// Server-side Supabase client for accounts + the compounding study memory
// feature. Plain fetch against Supabase's documented REST APIs (Auth REST
// for verifying a user's access token, PostgREST for reading/writing
// study_entries) rather than the @supabase/supabase-js SDK — consistent
// with how lib/upstash.js talks to Redis, and it means this project's
// server-side code stays at zero npm dependencies even with accounts added.
//
// The browser IS expected to use the official @supabase/supabase-js
// library (loaded via CDN in public/, not through npm) for the actual
// sign-in flow — magic-link/PKCE auth is genuinely fiddly to get right by
// hand, and that's exactly the kind of security-sensitive code worth using
// the officially maintained client for. This module only ever receives an
// access token the browser already obtained and verifies it; it never
// initiates a sign-in itself.
//
// Two Supabase API keys are involved, and they are NOT interchangeable —
// see https://supabase.com/docs/guides/getting-started/api-keys:
//   - SUPABASE_PUBLISHABLE_KEY ("Publishable key" in the dashboard, or the
//     legacy "anon" key on older projects) — low-privilege, safe to expose
//     in a browser. Used here as the `apikey` header when verifying a
//     user's own access token.
//   - SUPABASE_SECRET_KEY ("Secret keys" in the dashboard, or the legacy
//     "service_role" key) — elevated privilege, bypasses Row Level
//     Security entirely. Server-only, never sent to the browser. Used for
//     every study_entries/conversations read/write, since this server
//     already verified the user itself and scopes every query by their id
//     manually. Sent only as the `apikey` header, never as `Authorization`
//     — see postgrest()'s comment below for why.

import { fetchWithTimeout } from "./fetch-timeout.js";

const SUPABASE_TIMEOUT_MS = 8000;

function isSupabaseConfigured() {
  return Boolean(
    process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY && process.env.SUPABASE_SECRET_KEY,
  );
}

// --- Auth: verifying a user's access token ---------------------------------

/**
 * Verifies a Supabase access token (a JWT the browser attaches to a
 * request, obtained via its own sign-in flow) and returns { id, email } for
 * the user it belongs to, or null if the token is missing, malformed,
 * expired, or otherwise invalid. Never throws for an invalid token — an
 * unauthenticated request to a route that supports (but doesn't require)
 * accounts should just proceed anonymously, not fail the whole request.
 *
 * Does throw if Supabase itself is unreachable/erroring (a real
 * infrastructure problem, not "this particular token is bad") — same
 * "distinguish a bad request from a broken dependency" reasoning as
 * lib/upstash.js's redisCommand().
 */
export async function verifyUser(accessToken) {
  if (!accessToken || !isSupabaseConfigured()) return null;

  const response = await fetchWithTimeout(
    `${process.env.SUPABASE_URL}/auth/v1/user`,
    {
      headers: {
        apikey: process.env.SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
    },
    SUPABASE_TIMEOUT_MS,
  );

  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase Auth returned ${response.status} ${response.statusText}\n${body}`);
  }

  const user = await response.json();
  if (!user?.id) return null;
  return { id: user.id, email: user.email ?? null };
}

// --- Study history (PostgREST) ---------------------------------------------

async function postgrest(path, options = {}) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`;
  const response = await fetchWithTimeout(
    url,
    {
      ...options,
      headers: {
        // apikey alone (no Authorization header) is what actually gets
        // PostgREST to use the service_role Postgres role for a secret key.
        // Sending `Authorization: Bearer <secret key>` — even set to the
        // exact same value as apikey, which used to be here — is explicitly
        // called out as broken in Supabase's docs ("Known limitations and
        // compatibility differences"): the new publishable/secret keys
        // aren't JWTs, so a secret key in the Authorization header gets
        // forwarded to Postgres and rejected there for not being one. This
        // was the cause of the real "permissions error" hit in production —
        // see https://supabase.com/docs/guides/getting-started/api-keys.
        apikey: process.env.SUPABASE_SECRET_KEY,
        "content-type": "application/json",
        ...options.headers,
      },
    },
    SUPABASE_TIMEOUT_MS,
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase (PostgREST) returned ${response.status} ${response.statusText}\n${body}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Records one study_entries row for a signed-in user. Fire-and-forget from
 * the caller's perspective in spirit (see lib/chat.js) — a logging failure
 * here shouldn't be allowed to break the actual chat reply the user is
 * waiting on, so callers should catch/ignore errors from this rather than
 * let them propagate into the turn's critical path.
 */
export async function logStudyEntry(userId, { reference = null, topic = null, summary }) {
  if (!isSupabaseConfigured()) return;
  await postgrest("study_entries", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify([{ user_id: userId, reference, topic, summary }]),
  });
}

/**
 * Searches a user's own study_entries for ones matching `keyword` (against
 * reference and a plain substring match on topic/summary — not semantic
 * search; see the schema.sql comment on why embeddings are a deliberate
 * v2, not a v1 gap) or returns their most recent entries if no keyword is
 * given. Returns [] (not null/undefined) when Supabase isn't configured or
 * nothing matches, so callers can iterate the result unconditionally.
 */
export async function searchStudyHistory(userId, { keyword, limit = 10 } = {}) {
  if (!isSupabaseConfigured()) return [];

  const params = new URLSearchParams({
    user_id: `eq.${userId}`,
    order: "created_at.desc",
    limit: String(Math.min(limit, 50)),
    select: "reference,topic,summary,created_at",
  });

  if (keyword && keyword.trim()) {
    // PostgREST "or" filter across two columns, each a case-insensitive
    // substring match. Reference matching is exact-ish (a USFM code is
    // short and structured) via ilike too, so "john" still finds "JHN.3.16"
    // entries by matching against topic/summary instead, not reference.
    const escaped = keyword.trim().replace(/[,()]/g, ""); // PostgREST filter syntax uses these as delimiters
    params.set("or", `(topic.ilike.*${escaped}*,summary.ilike.*${escaped}*,reference.ilike.*${escaped}*)`);
  }

  const rows = await postgrest(`study_entries?${params.toString()}`, { method: "GET" });
  return rows ?? [];
}

// --- Conversations (durable, per-user chat history for the "previous
// conversations" menu) ------------------------------------------------------

// Caps how many { role, text, gathered } entries a conversation's render_log
// carries — mirrors the reasoning behind app.js's CLIENT_HISTORY_CAP: a
// safety ceiling on storage/payload size, not a limit normal use should hit.
const RENDER_LOG_MAX_ENTRIES = 80;

/**
 * Appends this turn's entries to a conversation, creating the row on first
 * use. `title`/`primaryBook` are only ever set once (the first turn that has
 * something to offer for each) — passed on every call as candidates, but an
 * already-set value always wins, so the title stays "whatever the
 * conversation actually opened with" rather than drifting turn to turn.
 * Fire-and-forget from the caller's side, same as logStudyEntry — a failure
 * here should never break the chat reply the user is waiting on.
 */
export async function appendToConversation(userId, conversationId, { title, primaryBook, entries }) {
  if (!isSupabaseConfigured() || !entries || entries.length === 0) return;

  const existingRows = await postgrest(
    `conversations?id=eq.${conversationId}&user_id=eq.${userId}&select=title,primary_book,render_log`,
    { method: "GET" },
  );
  const existing = existingRows?.[0];

  const renderLog = [...(existing?.render_log ?? []), ...entries].slice(-RENDER_LOG_MAX_ENTRIES);
  const row = {
    id: conversationId,
    user_id: userId,
    title: existing?.title ?? title ?? null,
    primary_book: existing?.primary_book ?? primaryBook ?? null,
    render_log: renderLog,
    updated_at: new Date().toISOString(),
  };

  await postgrest(`conversations?on_conflict=id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([row]),
  });
}

/**
 * Lists a user's conversations, most-recently-updated first (the "book"
 * sort mode is applied by the caller — server.js — using
 * lib/bible-books.js's canonical order, since PostgREST has no notion of
 * that ordering). Returns [] when Supabase isn't configured.
 */
export async function listConversations(userId) {
  if (!isSupabaseConfigured()) return [];
  const params = new URLSearchParams({
    user_id: `eq.${userId}`,
    select: "id,title,primary_book,updated_at",
    order: "updated_at.desc",
    limit: "200",
  });
  const rows = await postgrest(`conversations?${params.toString()}`, { method: "GET" });
  return rows ?? [];
}

/**
 * Fetches one conversation's full render_log, scoped to the given user —
 * the user_id filter in the query IS the ownership check (a mismatched or
 * nonexistent id just returns no rows, same as "not found"), not a
 * secondary check applied after the fact. Returns null when Supabase isn't
 * configured or nothing matches.
 */
export async function getConversation(userId, conversationId) {
  if (!isSupabaseConfigured()) return null;
  const rows = await postgrest(
    `conversations?id=eq.${conversationId}&user_id=eq.${userId}&select=id,title,primary_book,render_log,updated_at`,
    { method: "GET" },
  );
  return rows?.[0] ?? null;
}

// --- Notes (a signed-in user's own notes on a passage) ----------------------

/**
 * Creates a note on a passage for a signed-in user and returns the created
 * row (id, reference, body, createdAt). Unlike logStudyEntry/
 * appendToConversation, this is NOT fire-and-forget — a note is content the
 * user explicitly asked to save, so a write failure here should surface as
 * a real error to the caller (server.js), not be swallowed.
 */
export async function createNote(userId, { reference, body }) {
  const rows = await postgrest("notes", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([{ user_id: userId, reference, body }]),
  });
  return rows?.[0] ?? null;
}

/**
 * Lists a user's notes on one reference, newest first. Returns [] when
 * Supabase isn't configured or there are none — same "always iterable"
 * contract as searchStudyHistory/listConversations.
 */
export async function listNotes(userId, reference) {
  if (!isSupabaseConfigured()) return [];
  const params = new URLSearchParams({
    user_id: `eq.${userId}`,
    reference: `eq.${reference}`,
    select: "id,reference,body,created_at",
    order: "created_at.desc",
  });
  const rows = await postgrest(`notes?${params.toString()}`, { method: "GET" });
  return rows ?? [];
}

/**
 * Deletes one of a user's own notes. The user_id filter in the query IS the
 * ownership check (same pattern as getConversation) -- a note id that
 * exists but belongs to someone else just matches zero rows and deletes
 * nothing, rather than needing a separate "is this yours" check first.
 * Returns true if a row was actually deleted, false if nothing matched (so
 * the caller can tell "not found/not yours" apart from a real error, which
 * still throws).
 */
export async function deleteNote(userId, noteId) {
  const rows = await postgrest(`notes?id=eq.${noteId}&user_id=eq.${userId}`, {
    method: "DELETE",
    headers: { Prefer: "return=representation" },
  });
  return Boolean(rows && rows.length > 0);
}

// --- Daily digest preference (profiles.daily_digest_opt_in) ----------------

/**
 * Returns whether a signed-in user currently wants the daily digest email.
 * Defaults to false if there's somehow no profiles row yet — shouldn't
 * happen (handle_new_user() creates one on sign-up, see schema.sql) but
 * cheap insurance against a race between sign-up and this being called.
 */
export async function getDigestOptIn(userId) {
  if (!isSupabaseConfigured()) return false;
  const rows = await postgrest(`profiles?id=eq.${userId}&select=daily_digest_opt_in`, { method: "GET" });
  return Boolean(rows?.[0]?.daily_digest_opt_in);
}

/**
 * Sets a signed-in user's daily digest preference. Not fire-and-forget —
 * like createNote, this is an explicit user action (flipping a toggle) that
 * should surface a real error to the caller if the write fails, rather than
 * silently leaving the toggle in a state the database doesn't agree with.
 */
export async function setDigestOptIn(userId, optIn) {
  await postgrest(`profiles?id=eq.${userId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ daily_digest_opt_in: Boolean(optIn) }),
  });
}

/**
 * Lists every user currently opted into the daily digest email, as
 * { id, email }. Used only by lib/daily-digest.js's scheduled job, never by
 * a per-request handler -- unlike everything else in this module, this is
 * deliberately NOT scoped to one user's id, since the whole point is to
 * enumerate everyone. Returns [] when Supabase isn't configured.
 */
export async function listDigestOptedInUsers() {
  if (!isSupabaseConfigured()) return [];
  const params = new URLSearchParams({
    daily_digest_opt_in: "eq.true",
    select: "id,email",
  });
  const rows = await postgrest(`profiles?${params.toString()}`, { method: "GET" });
  return rows ?? [];
}

// --- Reading plan progress (per-user, per-plan) -----------------------------

/**
 * Fetches a user's progress on one plan, or null if they haven't started it
 * (no row yet -- distinct from an empty `completedDays`, which means
 * "started, nothing checked off yet"). Returns
 * { completedDays, startedAt, updatedAt }.
 */
export async function getReadingPlanProgress(userId, planId) {
  if (!isSupabaseConfigured()) return null;
  const rows = await postgrest(
    `reading_plan_progress?user_id=eq.${userId}&plan_id=eq.${planId}&select=completed_days,started_at,updated_at`,
    { method: "GET" },
  );
  const row = rows?.[0];
  if (!row) return null;
  return { completedDays: row.completed_days ?? [], startedAt: row.started_at, updatedAt: row.updated_at };
}

/**
 * Fetches a user's progress on every plan they've started, keyed by
 * plan_id -- used to show a completed-day count next to each plan in the
 * list view without a request per plan. Returns {} (not null) when
 * Supabase isn't configured or nothing's been started, so callers can look
 * up `progressByPlan[id]` unconditionally.
 */
export async function listReadingPlanProgress(userId) {
  if (!isSupabaseConfigured()) return {};
  const rows = await postgrest(
    `reading_plan_progress?user_id=eq.${userId}&select=plan_id,completed_days,started_at,updated_at`,
    { method: "GET" },
  );
  const byPlan = {};
  for (const row of rows ?? []) {
    byPlan[row.plan_id] = { completedDays: row.completed_days ?? [], startedAt: row.started_at, updatedAt: row.updated_at };
  }
  return byPlan;
}

/**
 * Marks one day of a plan complete or incomplete for a user, creating the
 * progress row on first use (same "fetch existing, merge, upsert" shape as
 * appendToConversation() -- there's no atomic array-append/-remove via
 * plain PostgREST without a stored procedure, and this project doesn't use
 * those -- see lib/supabase.js's header comment on staying SDK-free).
 * Returns the resulting completedDays array. Not fire-and-forget: like
 * createNote/setDigestOptIn, this is an explicit user action (checking a
 * box) that should surface a real error if the write fails.
 */
export async function setReadingPlanDayComplete(userId, planId, day, completed) {
  const existing = await postgrest(
    `reading_plan_progress?user_id=eq.${userId}&plan_id=eq.${planId}&select=completed_days`,
    { method: "GET" },
  );
  const current = new Set(existing?.[0]?.completed_days ?? []);
  if (completed) current.add(day);
  else current.delete(day);
  const completedDays = [...current].sort((a, b) => a - b);

  await postgrest(`reading_plan_progress?on_conflict=user_id,plan_id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([
      { user_id: userId, plan_id: planId, completed_days: completedDays, updated_at: new Date().toISOString() },
    ]),
  });

  return completedDays;
}

export { isSupabaseConfigured };
