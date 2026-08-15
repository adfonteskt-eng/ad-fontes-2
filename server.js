// Phase 3 (start): a minimal HTTP server exposing ad-fontes's gather/
// summarize pipeline as a small JSON API, plus the static frontend in
// public/. Uses only node:http — no new dependencies, matching the rest of
// this project.
//
//   Usage: npm run web
//          PORT=8080 npm run web
//
// API: GET /api/passage?ref=JHN.3.16&variants=false&commentary=true&summary=true
//   ref        required, USFM-ish reference like JHN.3.16 or GEN.1.1
//   variants   "true" to include TR/Byzantine variant Greek words. Default false.
//   commentary "false" to skip the biblehub fetch entirely. Default true.
//   summary    "false" to skip the Anthropic call entirely. Default true.
//
// GET /api/daily -> { usfm, label, tag } for today's featured passage (same
//   for everyone on a given UTC day — see lib/daily-passage.js). No auth,
//   no rate limit, no external calls.
//
// GET /api/config -> { supabaseUrl, supabasePublishableKey } (both null if
//   Supabase isn't configured on the server). The publishable key is safe
//   to expose to the browser by design — see lib/supabase.js's header
//   comment — so this just hands the frontend what it needs to construct
//   its own Supabase client, without hardcoding those values into a static
//   file that can't read the server's .env.
//
// GET /api/conversations?sort=recent|book -> { conversations: [{ id, title,
//   primaryBook, updatedAt }] } for the signed-in user, most-recently-
//   updated first (default) or grouped in canonical Bible book order
//   (lib/bible-books.js). Requires a valid Authorization header — 401
//   without one.
//
// GET /api/conversations/:id -> { id, title, primaryBook, renderLog,
//   updatedAt } — the full stored transcript for one of the signed-in
//   user's own conversations (404 if it isn't theirs or doesn't exist), so
//   the frontend can redraw it when resuming from the menu. Requires a
//   valid Authorization header — 401 without one.
//
// GET /api/notes?ref=JHN.3.16 -> { notes: [{ id, reference, body,
//   createdAt }] }, newest first, for the signed-in user's own notes on
//   that exact reference. Requires a valid Authorization header — 401
//   without one.
//
// POST /api/notes { reference, body } -> the created note ({ id, reference,
//   body, createdAt }). Requires a valid Authorization header — 401 without
//   one.
//
// DELETE /api/notes/:id -> 204 on success, 404 if the note doesn't exist or
//   isn't the signed-in user's own. Requires a valid Authorization header —
//   401 without one.
//
// GET /api/preferences -> { dailyDigestOptIn: boolean } for the signed-in
//   user. Requires a valid Authorization header — 401 without one.
//
// PUT /api/preferences { dailyDigestOptIn: boolean } -> the preference as
//   saved, same shape as GET. Requires a valid Authorization header — 401
//   without one. (Only one preference exists today; PUT replaces the whole
//   object rather than PATCHing a single field, so this doesn't need to
//   change shape when a second preference is added later.)
//
// GET /api/reading-plans -> { plans: [{ id, title, description, days: [{
//   day, usfm, label, tag }], completedDays: [] }] } -- the full curated
//   list (lib/reading-plans.js), always 200 whether or not the caller is
//   signed in. No Authorization header: completedDays is [] for every plan
//   (nothing to attach progress to). With one: each plan's completedDays
//   reflects that signed-in user's own progress. Never 401 -- unlike
//   /api/notes and /api/conversations, there's a meaningful anonymous
//   response here (the plan content itself), same reasoning as /api/chat.
//
// PUT /api/reading-plans/:id/days/:day { completed: boolean } -> { completedDays:
//   [...] }, the plan's updated completed-day list for the signed-in user.
//   404 if :id isn't a real plan or :day isn't one of its real day numbers.
//   Requires a valid Authorization header — 401 without one (unlike GET
//   above, there's no meaningful anonymous version of "mark this done").
//
// GET /chat -> serves the same index.html as GET / -- the frontend is a
//   single-page app with two client-side views (home and conversation, see
//   public/app.js), and this route exists purely so a hard refresh or a
//   direct/bookmarked link to /chat still loads the app instead of 404ing.
//   Which view actually renders is decided client-side (from localStorage),
//   not by this route.
//
//      POST /api/chat   { sessionId?: string, conversationId?: string, message: string }
//   -> { sessionId, conversationId, reply }
//   sessionId is omitted on the first message of a conversation; the server
//   creates one and returns it for the client to send with every message
//   after that. Session durability (survives a restart or not) and the
//   per-IP daily usage caps protecting the Anthropic bill are both handled
//   in lib/ — see lib/session-store.js and lib/rate-limit.js. An optional
//   `Authorization: Bearer <supabase-access-token>` header attributes the
//   turn to a signed-in user (compounding study memory, and the durable
//   "previous conversations" history) — chat works the same without it,
//   just without those features. conversationId is only meaningful for a
//   signed-in user resuming an old conversation from GET
//   /api/conversations/:id after its live session has idled out — send the
//   resumed conversation's id here (sessionId can be omitted/stale) to keep
//   appending to that same durable conversation instead of starting a new
//   one. Omit it for a normal new-or-continuing conversation; the response's
//   conversationId is null for an anonymous request.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { bookOrder } from "./lib/bible-books.js";
import { chatTurn } from "./lib/chat.js";
import { getDailyPassage } from "./lib/daily-passage.js";
import { gatherPassage } from "./lib/gather.js";
import { CHAT_DAILY_LIMIT, SUMMARY_DAILY_LIMIT, checkAndIncrement } from "./lib/rate-limit.js";
import { getReadingPlan, isValidPlanDay, READING_PLANS } from "./lib/reading-plans.js";
import { summarizePassage } from "./lib/summarize.js";
import {
  createNote,
  deleteNote,
  getConversation,
  getDigestOptIn,
  listConversations,
  listNotes,
  listReadingPlanProgress,
  setDigestOptIn,
  setReadingPlanDayComplete,
  verifyUser,
} from "./lib/supabase.js";

try {
  process.loadEnvFile(new URL(".env", import.meta.url));
} catch {
  // no .env file — fall through to whatever is already in the environment
}

const PUBLIC_DIR = fileURLToPath(new URL("public/", import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Render (and most hosts fronted by a proxy/load balancer) terminates the
// real client connection itself and forwards it, so req.socket.remoteAddress
// would just be the proxy's own address for every request. X-Forwarded-For
// carries the real chain instead, client IP first — trustworthy here because
// the proxy in front of this app controls that header, not the client
// directly. Falls back to the raw socket address for local dev, where
// there's no proxy setting the header at all.
function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function serveStatic(res, pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = join(PUBLIC_DIR, relativePath);

  // Guard against escaping public/ (e.g. a request for "/../.env").
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    const type = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  }
}

// No auth, no rate limiting, no external calls — just an in-process lookup,
// so this is as cheap as a static file and doesn't need any of the
// machinery the other endpoints do.
function handleDaily(res) {
  sendJson(res, 200, getDailyPassage());
}

function handleConfig(res) {
  sendJson(res, 200, {
    // `||`, not `??`: an empty-string env var (e.g. explicitly blanked out
    // to disable the feature without deleting the line) should read as
    // "not configured" the same as it being unset entirely — consistent
    // with lib/supabase.js's isSupabaseConfigured(), which already treats
    // an empty string as falsy via Boolean(...).
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || null,
  });
}

// Extracts and verifies an optional "Authorization: Bearer <token>" header,
// returning { id, email } or null. Never throws for a missing/invalid
// token — accounts are additive everywhere they touch chat, never
// required — but a genuine Supabase-side failure (the service being down,
// not "this token is bad") still propagates, same reasoning as
// verifyUser() itself.
async function authenticateRequest(req) {
  const header = req.headers.authorization ?? "";
  const match = header.match(/^Bearer (.+)$/);
  if (!match) return null;
  return verifyUser(match[1]);
}

const CONVERSATION_ID_PATTERN = /^\/api\/conversations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// A note's id is a plain bigint identity column (see supabase/schema.sql),
// not a uuid like conversations — so this pattern (and NOTE_ID_PATTERN's
// use below) is deliberately simpler than CONVERSATION_ID_PATTERN.
const NOTE_ID_PATTERN = /^\/api\/notes\/(\d+)$/;

// Plan ids are lib/reading-plans.js's own hand-picked kebab-case strings
// (e.g. "gospel-in-six-verses"), not a generated id -- this pattern is just
// a shape guard on the URL, not a lookup; getReadingPlan() below is what
// actually confirms the id refers to a real plan.
const READING_PLAN_DAY_PATTERN = /^\/api\/reading-plans\/([a-z0-9-]+)\/days\/(\d+)$/;

// Both /api/conversations routes require a real signed-in user — unlike
// /api/chat, where accounts are optional and a missing/invalid token just
// falls back to anonymous behavior, there's no meaningful anonymous version
// of "list my past conversations." A genuine Supabase-side failure (not "no
// token" or "bad token," but Supabase itself erroring) is reported as a 500
// rather than silently treated the same as "not signed in."
async function requireUser(req, res) {
  let user;
  try {
    user = await authenticateRequest(req);
  } catch (error) {
    sendJson(res, 500, { error: `Could not verify sign-in: ${error.message}` });
    return null;
  }
  if (!user) {
    sendJson(res, 401, { error: "Sign in required." });
    return null;
  }
  return user;
}

async function handleListConversations(req, res, searchParams) {
  const user = await requireUser(req, res);
  if (!user) return;

  const rows = await listConversations(user.id);
  const conversations = rows.map((row) => ({
    id: row.id,
    title: row.title,
    primaryBook: row.primary_book,
    updatedAt: row.updated_at,
  }));

  if (searchParams.get("sort") === "book") {
    // Undated/topical conversations (no primaryBook yet) sort after
    // Revelation, per bookOrder()'s own fallback — see lib/bible-books.js.
    conversations.sort((a, b) => bookOrder(a.primaryBook) - bookOrder(b.primaryBook));
  } else {
    conversations.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  sendJson(res, 200, { conversations });
}

async function handleGetConversation(req, res, conversationId) {
  const user = await requireUser(req, res);
  if (!user) return;

  const row = await getConversation(user.id, conversationId);
  if (!row) {
    sendJson(res, 404, { error: "Conversation not found." });
    return;
  }

  sendJson(res, 200, {
    id: row.id,
    title: row.title,
    primaryBook: row.primary_book,
    renderLog: row.render_log ?? [],
    updatedAt: row.updated_at,
  });
}

// A reference is a short USFM-ish code (e.g. "JHN.3.16" or "JHN.3.16-18") —
// this cap is generous headroom above anything gatherPassage actually
// produces, just a real ceiling rather than unbounded.
const MAX_NOTE_REFERENCE_LENGTH = 100;
// Same limit as a chat message (MAX_MESSAGE_LENGTH) — a note is
// user-authored prose, same rough shape as a chat message, so there's no
// reason for a different ceiling here.
const MAX_NOTE_BODY_LENGTH = 4000;

function toNoteJson(row) {
  return { id: row.id, reference: row.reference, body: row.body, createdAt: row.created_at };
}

async function handleListNotes(req, res, searchParams) {
  const user = await requireUser(req, res);
  if (!user) return;

  const reference = searchParams.get("ref");
  if (!reference) {
    sendJson(res, 400, { error: "Missing required query param: ref (e.g. ?ref=JHN.3.16)" });
    return;
  }

  const rows = await listNotes(user.id, reference);
  sendJson(res, 200, { notes: rows.map(toNoteJson) });
}

async function handleCreateNote(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  let body;
  try {
    body = await readJsonBody(req, { maxBytes: MAX_CHAT_BODY_BYTES });
  } catch (error) {
    sendJson(res, error.status ?? 400, { error: error.message });
    return;
  }

  const reference = typeof body.reference === "string" ? body.reference.trim() : "";
  const noteBody = typeof body.body === "string" ? body.body.trim() : "";

  if (!reference) {
    sendJson(res, 400, { error: "Missing required field: reference." });
    return;
  }
  if (reference.length > MAX_NOTE_REFERENCE_LENGTH) {
    sendJson(res, 400, { error: `reference is too long (max ${MAX_NOTE_REFERENCE_LENGTH} characters).` });
    return;
  }
  if (!noteBody) {
    sendJson(res, 400, { error: "Missing required field: body." });
    return;
  }
  if (noteBody.length > MAX_NOTE_BODY_LENGTH) {
    sendJson(res, 400, { error: `body is too long (max ${MAX_NOTE_BODY_LENGTH} characters).` });
    return;
  }

  const row = await createNote(user.id, { reference, body: noteBody });
  sendJson(res, 201, toNoteJson(row));
}

async function handleDeleteNote(req, res, noteId) {
  const user = await requireUser(req, res);
  if (!user) return;

  const deleted = await deleteNote(user.id, noteId);
  if (!deleted) {
    sendJson(res, 404, { error: "Note not found." });
    return;
  }
  res.writeHead(204);
  res.end();
}

// No requireUser() here -- unlike /api/notes and /api/conversations, a
// signed-out request gets a real, useful 200 (the plan content itself,
// just with every completedDays empty), same "accounts are additive, never
// required" reasoning as /api/chat. authenticateRequest() already returns
// null gracefully for no/invalid token, so this only needs to branch on
// whether a genuine user came back.
async function handleListReadingPlans(req, res) {
  let user = null;
  try {
    user = await authenticateRequest(req);
  } catch (error) {
    console.error("Supabase auth check failed, listing reading plans without progress:", error.message);
  }

  const progressByPlan = user ? await listReadingPlanProgress(user.id) : {};

  const plans = READING_PLANS.map((plan) => ({
    id: plan.id,
    title: plan.title,
    description: plan.description,
    days: plan.days,
    completedDays: progressByPlan[plan.id]?.completedDays ?? [],
  }));

  sendJson(res, 200, { plans });
}

async function handleSetReadingPlanDay(req, res, planId, dayParam) {
  const user = await requireUser(req, res);
  if (!user) return;

  const plan = getReadingPlan(planId);
  const day = Number(dayParam);
  if (!plan || !isValidPlanDay(plan, day)) {
    sendJson(res, 404, { error: "Reading plan or day not found." });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req, { maxBytes: MAX_CHAT_BODY_BYTES });
  } catch (error) {
    sendJson(res, error.status ?? 400, { error: error.message });
    return;
  }

  if (typeof body.completed !== "boolean") {
    sendJson(res, 400, { error: "Missing or invalid field: completed (must be true or false)." });
    return;
  }

  const completedDays = await setReadingPlanDayComplete(user.id, planId, day, body.completed);
  sendJson(res, 200, { completedDays });
}

async function handleGetPreferences(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const dailyDigestOptIn = await getDigestOptIn(user.id);
  sendJson(res, 200, { dailyDigestOptIn });
}

async function handleSetPreferences(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  let body;
  try {
    body = await readJsonBody(req, { maxBytes: MAX_CHAT_BODY_BYTES });
  } catch (error) {
    sendJson(res, error.status ?? 400, { error: error.message });
    return;
  }

  if (typeof body.dailyDigestOptIn !== "boolean") {
    sendJson(res, 400, { error: "Missing or invalid field: dailyDigestOptIn (must be true or false)." });
    return;
  }

  await setDigestOptIn(user.id, body.dailyDigestOptIn);
  sendJson(res, 200, { dailyDigestOptIn: body.dailyDigestOptIn });
}

async function handlePassage(req, res, searchParams) {
  const appKey = process.env.YVP_APP_KEY;
  if (!appKey) {
    sendJson(res, 500, {
      error:
        "YVP_APP_KEY is not set on the server. Copy .env.example to .env and add your app key.",
    });
    return;
  }

  const usfm = searchParams.get("ref");
  if (!usfm) {
    sendJson(res, 400, {
      error: "Missing required query param: ref (e.g. ?ref=JHN.3.16)",
    });
    return;
  }

  const includeVariants = searchParams.get("variants") === "true";
  const includeCommentary = searchParams.get("commentary") !== "false";
  const includeSummary = searchParams.get("summary") !== "false";

  let gathered;
  try {
    gathered = await gatherPassage(usfm, {
      appKey,
      includeVariants,
      includeCommentary,
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  let summary = null;
  let summaryError = null;
  if (includeSummary) {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      summaryError = "ANTHROPIC_API_KEY is not set on the server.";
    } else {
      const { allowed } = await checkAndIncrement("summary", clientIp(req), SUMMARY_DAILY_LIMIT);
      if (!allowed) {
        summaryError = `Daily summary limit reached (${SUMMARY_DAILY_LIMIT}/day during the free beta). Try again tomorrow, or view the passage without a summary.`;
      } else {
        try {
          summary = await summarizePassage(gathered, { apiKey: anthropicKey });
        } catch (error) {
          summaryError = error.message;
        }
      }
    }
  }

  sendJson(res, 200, { ...gathered, summary, summaryError });
}

// A chat message has no business being more than a few KB of JSON — without
// a cap, node:http will happily keep buffering an arbitrarily large request
// body into memory (a broken client, or a deliberately abusive one, sending
// megabytes in one POST). 32 KB is generous for { sessionId, message } while
// still being a real ceiling rather than "unbounded."
const MAX_CHAT_BODY_BYTES = 32 * 1024;

// Generous for a real study question, but a ceiling — protects against a
// pathologically long message blowing past Anthropic's token limits with a
// confusing downstream error instead of a clear one here.
const MAX_MESSAGE_LENGTH = 4000;

// A real sessionId or conversationId only ever comes from randomUUID()
// (lib/chat.js), so either only ever looks like this. Anything else
// arriving in a request body is either a client bug or someone poking at
// the API by hand — rather than rejecting the whole request over it,
// silently treat it the same as absent (sessionId: a fresh conversation
// starts; conversationId: this turn's durable row falls back to the
// session id, same as if none had been given at all — see lib/chat.js's
// chatTurn). This is what actually matters: without this check, an
// arbitrary string would flow straight into a Redis/in-memory key
// (lib/session-store.js) or a PostgREST filter (lib/supabase.js) as-is, so
// a client could otherwise stuff arbitrarily large or malformed values in
// there — bounding the shape here is cheap and closes that off entirely,
// not just makes it less likely.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sanitizeUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : undefined;
}

// node:http gives you the request as a readable stream, not a parsed body —
// no framework here, so read and parse it by hand. Empty body -> {}.
async function readJsonBody(req, { maxBytes = MAX_CHAT_BODY_BYTES } = {}) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error(`Request body too large (max ${maxBytes} bytes).`);
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON body.");
  }
}

async function handleChat(req, res) {
  const appKey = process.env.YVP_APP_KEY;
  if (!appKey) {
    sendJson(res, 500, {
      error:
        "YVP_APP_KEY is not set on the server. Copy .env.example to .env and add your app key.",
    });
    return;
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    sendJson(res, 500, {
      error: "ANTHROPIC_API_KEY is not set on the server. Chat requires it.",
    });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, error.status ?? 400, { error: error.message });
    return;
  }

  const sessionId = sanitizeUuid(body.sessionId);
  const conversationId = sanitizeUuid(body.conversationId);
  const { message } = body;
  if (!message || typeof message !== "string" || !message.trim()) {
    sendJson(res, 400, { error: "Missing required field: message." });
    return;
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    sendJson(res, 400, {
      error: `Message is too long (${message.length} characters, max ${MAX_MESSAGE_LENGTH}). Try asking a narrower question.`,
    });
    return;
  }

  const { allowed } = await checkAndIncrement("chat", clientIp(req), CHAT_DAILY_LIMIT);
  if (!allowed) {
    sendJson(res, 429, {
      error: `Daily chat limit reached (${CHAT_DAILY_LIMIT} messages/day during the free beta). Try again tomorrow.`,
    });
    return;
  }

  // Accounts are entirely optional here: a request with no Authorization
  // header (or an invalid one) just proceeds anonymously, same as always.
  // A genuine Supabase-side failure (not "this token is bad," but "Supabase
  // itself errored") is caught rather than allowed to fail the whole chat
  // turn — the compounding-memory feature this unlocks is additive, and
  // shouldn't be able to take down core chat functionality if it's briefly
  // unreachable.
  let user = null;
  try {
    user = await authenticateRequest(req);
  } catch (error) {
    console.error("Supabase auth check failed, proceeding anonymously:", error.message);
  }

  try {
    const result = await chatTurn({
      sessionId,
      conversationId,
      message,
      appKey,
      apiKey: anthropicKey,
      userId: user?.id ?? null,
    });
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "GET" && url.pathname === "/api/passage") {
      await handlePassage(req, res, url.searchParams);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/daily") {
      handleDaily(res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/config") {
      handleConfig(res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/conversations") {
      await handleListConversations(req, res, url.searchParams);
      return;
    }
    const conversationMatch = req.method === "GET" ? url.pathname.match(CONVERSATION_ID_PATTERN) : null;
    if (conversationMatch) {
      await handleGetConversation(req, res, conversationMatch[1]);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/notes") {
      await handleListNotes(req, res, url.searchParams);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/notes") {
      await handleCreateNote(req, res);
      return;
    }
    const noteMatch = req.method === "DELETE" ? url.pathname.match(NOTE_ID_PATTERN) : null;
    if (noteMatch) {
      await handleDeleteNote(req, res, noteMatch[1]);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/reading-plans") {
      await handleListReadingPlans(req, res);
      return;
    }
    const planDayMatch = req.method === "PUT" ? url.pathname.match(READING_PLAN_DAY_PATTERN) : null;
    if (planDayMatch) {
      await handleSetReadingPlanDay(req, res, planDayMatch[1], planDayMatch[2]);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/preferences") {
      await handleGetPreferences(req, res);
      return;
    }
    if (req.method === "PUT" && url.pathname === "/api/preferences") {
      await handleSetPreferences(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      await handleChat(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/chat") {
      await serveStatic(res, "/"); // same file as the homepage -- see the GET /chat doc comment above
      return;
    }
    if (req.method === "GET") {
      await serveStatic(res, url.pathname);
      return;
    }
    res.writeHead(405, { "content-type": "text/plain" });
    res.end("Method not allowed");
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Internal server error." });
  }
});

server.listen(PORT, () => {
  console.log(`ad-fontes web server running at http://localhost:${PORT}`);
});
