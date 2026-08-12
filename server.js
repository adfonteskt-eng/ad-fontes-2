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
//      POST /api/chat   { sessionId?: string, message: string }
//   -> { sessionId, reply }
//   sessionId is omitted on the first message of a conversation; the server
//   creates one and returns it for the client to send with every message
//   after that. Session durability (survives a restart or not) and the
//   per-IP daily usage caps protecting the Anthropic bill are both handled
//   in lib/ — see lib/session-store.js and lib/rate-limit.js.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chatTurn } from "./lib/chat.js";
import { gatherPassage } from "./lib/gather.js";
import { CHAT_DAILY_LIMIT, SUMMARY_DAILY_LIMIT, checkAndIncrement } from "./lib/rate-limit.js";
import { summarizePassage } from "./lib/summarize.js";

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

  const { sessionId, message } = body;
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

  try {
    const result = await chatTurn({ sessionId, message, appKey, apiKey: anthropicKey });
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
    if (req.method === "POST" && url.pathname === "/api/chat") {
      await handleChat(req, res);
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
