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
