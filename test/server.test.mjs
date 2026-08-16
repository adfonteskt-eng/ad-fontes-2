// Integration tests against the real server.js, spawned as a subprocess on
// a random local port and talked to over real HTTP (loopback only — no
// external network involved, so this runs fine in a network-restricted
// sandbox same as everything else here). server.js has never had any test
// coverage before this: routing, static-file serving, and request
// validation were only ever checked by hand.
//
// Fake YVP_APP_KEY/ANTHROPIC_API_KEY are enough to get past the "is a key
// configured" checks and reach the validation logic this suite actually
// cares about — none of these tests exercise a real gatherPassage()/
// chatTurn() call far enough to hit the network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

const REPO_ROOT = new URL("..", import.meta.url);
const PORT = 34117 + Math.floor(Math.random() * 1000); // avoid clashing with a real dev server
const BASE_URL = `http://127.0.0.1:${PORT}`;

let serverProcess;

before(async () => {
  serverProcess = spawn(process.execPath, ["server.js"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      YVP_APP_KEY: "test-fake-app-key",
      ANTHROPIC_API_KEY: "test-fake-anthropic-key",
      // Explicitly blanked, not just omitted: server.js's own
      // process.loadEnvFile() call would otherwise pick up a real
      // developer .env (if one exists, e.g. with live Supabase
      // credentials) and make this suite's "Supabase unconfigured"
      // assumptions fail depending on the machine it runs on.
      // loadEnvFile doesn't override an already-set env var, so setting
      // these to "" here keeps them unset in spirit ("" reads as
      // not-configured — see handleConfig/isSupabaseConfigured) regardless
      // of what's in that file.
      SUPABASE_URL: "",
      SUPABASE_PUBLISHABLE_KEY: "",
      SUPABASE_SECRET_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Wait for the "running at" line rather than a fixed delay, so this isn't
  // flaky on a slow CI box but also doesn't wait longer than it has to.
  await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`server didn't start in time; output so far: ${out}`)), 10000);
    serverProcess.stdout.on("data", (chunk) => {
      out += chunk.toString();
      if (out.includes("running at")) {
        clearTimeout(timer);
        resolve();
      }
    });
    serverProcess.on("error", reject);
  });
});

after(async () => {
  if (!serverProcess) return;
  serverProcess.kill();
  await once(serverProcess, "exit").catch(() => {});
});

test("GET / serves index.html", async () => {
  const response = await fetch(BASE_URL + "/");
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /<html/i);
});

test("GET /chat serves the same index.html as GET / (client-side view routing)", async () => {
  const response = await fetch(BASE_URL + "/chat");
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /<html/i);
});

test("GET /today, /plans, and /subscription each serve the same index.html (client-side view routing)", async () => {
  for (const path of ["/today", "/plans", "/subscription"]) {
    const response = await fetch(BASE_URL + path);
    assert.equal(response.status, 200, `${path} should return 200`);
    const body = await response.text();
    assert.match(body, /<html/i, `${path} should serve index.html`);
  }
});

test("GET /app.js serves the frontend script with the right content type", async () => {
  const response = await fetch(BASE_URL + "/app.js");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /javascript/);
});

test("GET /does-not-exist.js returns 404", async () => {
  const response = await fetch(BASE_URL + "/does-not-exist.js");
  assert.equal(response.status, 404);
});

test("GET /../server.js (path traversal attempt) is rejected, not served", async () => {
  // fetch()/undici normalizes ".." in the URL before it's ever sent, same
  // as a real browser would — so this hits serveStatic()'s PUBLIC_DIR guard
  // via an already-resolved path outside public/, which correctly 404s.
  const response = await fetch(BASE_URL + "/../server.js");
  assert.notEqual(response.status, 200);
});

test("DELETE / is rejected with 405", async () => {
  const response = await fetch(BASE_URL + "/", { method: "DELETE" });
  assert.equal(response.status, 405);
});

test("GET /api/config reports Supabase as unconfigured when no env vars are set", async () => {
  const response = await fetch(BASE_URL + "/api/config");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data, { supabaseUrl: null, supabasePublishableKey: null });
});

test("POST /api/chat with a garbage Authorization header still behaves like an anonymous request", async () => {
  // Accounts are entirely optional: with Supabase unconfigured (this test
  // server's env, same as the rest of this file), authenticateRequest()
  // should short-circuit to null without erroring or changing any other
  // behavior -- confirmed here by checking this doesn't produce a 400/401
  // the way a required-auth endpoint would.
  const response = await fetch(BASE_URL + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer not-a-real-token" },
    body: JSON.stringify({ message: "What does Psalm 23:1 mean?" }),
  });
  assert.notEqual(response.status, 400);
  assert.notEqual(response.status, 401);
});

test("GET /api/daily returns today's featured passage", async () => {
  const response = await fetch(BASE_URL + "/api/daily");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.match(data.usfm, /^[A-Z0-9]+\.\d+\.\d+$/, "usfm should look like BOOK.chapter.verse");
  assert.equal(typeof data.label, "string");
  assert.ok(data.label.length > 0);
});

test("GET /api/passage with no ref returns 400", async () => {
  const response = await fetch(BASE_URL + "/api/passage");
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.error, /ref/i);
});

test("POST /api/chat with no message returns 400", async () => {
  const response = await fetch(BASE_URL + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.error, /message/i);
});

test("POST /api/chat with invalid JSON returns 400, not a 500 crash", async () => {
  const response = await fetch(BASE_URL + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not valid json",
  });
  assert.equal(response.status, 400);
});

test("POST /api/chat with an over-length message is rejected before any API call", async () => {
  const response = await fetch(BASE_URL + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "x".repeat(5000) }),
  });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.error, /too long/i);
});

test("POST /api/chat with an oversized body is rejected (413), not silently buffered forever", async () => {
  const response = await fetch(BASE_URL + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "x".repeat(64 * 1024) }),
  });
  assert.equal(response.status, 413);
});

test("GET /api/notes with no Authorization header returns 401", async () => {
  const response = await fetch(BASE_URL + "/api/notes?ref=JHN.3.16");
  assert.equal(response.status, 401);
});

test("POST /api/notes with no Authorization header returns 401", async () => {
  const response = await fetch(BASE_URL + "/api/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reference: "JHN.3.16", body: "a note" }),
  });
  assert.equal(response.status, 401);
});

test("DELETE /api/notes/:id with no Authorization header returns 401", async () => {
  const response = await fetch(BASE_URL + "/api/notes/1", { method: "DELETE" });
  assert.equal(response.status, 401);
});

test("DELETE /api/notes/not-a-number doesn't match the notes route (falls through to 405)", async () => {
  // NOTE_ID_PATTERN only matches a plain integer id (see server.js) — a
  // non-numeric id doesn't match any route at all for DELETE, so this falls
  // all the way through to the generic "method not allowed" rather than
  // being treated as a malformed note id.
  const response = await fetch(BASE_URL + "/api/notes/not-a-number", { method: "DELETE" });
  assert.equal(response.status, 405);
});

test("GET /api/reading-plans returns the curated plan list, no auth required", async () => {
  const response = await fetch(BASE_URL + "/api/reading-plans");
  assert.equal(response.status, 200);
  const { plans } = await response.json();
  assert.ok(Array.isArray(plans) && plans.length > 0);
  for (const plan of plans) {
    assert.equal(typeof plan.id, "string");
    assert.equal(typeof plan.title, "string");
    assert.ok(Array.isArray(plan.days) && plan.days.length > 0);
    assert.deepEqual(plan.completedDays, [], "no Authorization header -- nothing to attach progress to");
  }
});

test("PUT /api/reading-plans/:id/days/:day with no Authorization header returns 401", async () => {
  const response = await fetch(BASE_URL + "/api/reading-plans/gospel-in-six-verses/days/1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ completed: true }),
  });
  assert.equal(response.status, 401);
});

test("GET /api/preferences with no Authorization header returns 401", async () => {
  const response = await fetch(BASE_URL + "/api/preferences");
  assert.equal(response.status, 401);
});

test("PUT /api/preferences with no Authorization header returns 401", async () => {
  const response = await fetch(BASE_URL + "/api/preferences", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dailyDigestOptIn: true }),
  });
  assert.equal(response.status, 401);
});

test("POST /api/chat with a malformed sessionId is sanitized away, not rejected", async () => {
  // A real sessionId only ever comes from randomUUID() server-side. A
  // client sending something else (a huge string, an object, whatever)
  // should be treated the same as sending no sessionId at all — proven
  // here by confirming it does NOT trip a 400. It still won't reach 200
  // (the fake ANTHROPIC_API_KEY means chatTurn() fails on the real network
  // call this sandbox can't make), but that failure has to come from
  // further downstream than request validation, not from the sessionId
  // shape itself.
  const response = await fetch(BASE_URL + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "not-a-real-uuid; drop table sessions;", message: "What does Genesis 1:1 mean?" }),
  });
  assert.notEqual(response.status, 400, "a malformed sessionId shouldn't be treated as a validation error");
});
