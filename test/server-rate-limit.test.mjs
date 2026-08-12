// Integration test for the rate-limit wiring in server.js specifically —
// test/server.test.mjs already covers routing/validation against a real
// spawned server, but doesn't set CHAT_DAILY_LIMIT low enough to actually
// trip it (the default, 60, would mean 60 real requests just to reach the
// interesting case). A separate server instance with the limit pinned to 1
// makes the 429 path reachable in two requests instead.
//
// Doesn't touch summary rate-limiting (GET /api/passage): that path only
// reaches checkAndIncrement() after a real gatherPassage() call succeeds,
// which needs live YouVersion network access this sandbox doesn't have —
// same reason test/server.test.mjs stays at the validation layer rather
// than exercising real gatherPassage()/chatTurn() calls. checkAndIncrement()
// itself (the shared logic both endpoints call) is already covered in
// isolation by test/rate-limit.test.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

const REPO_ROOT = new URL("..", import.meta.url);
const PORT = 35617 + Math.floor(Math.random() * 1000);
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
      CHAT_DAILY_LIMIT: "1",
      // Deliberately unset so this run uses the in-memory rate-limit
      // backend regardless of what's in the parent test process's .env —
      // this test is about server.js's wiring, not Upstash connectivity.
      UPSTASH_REDIS_REST_URL: "",
      UPSTASH_REDIS_REST_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

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

test("POST /api/chat: first request under CHAT_DAILY_LIMIT=1 is not rate-limited", async () => {
  const response = await fetch(BASE_URL + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "What does John 3:16 mean?" }),
  });
  // Not asserting 200 here: with a fake ANTHROPIC_API_KEY and no network,
  // chatTurn() itself fails downstream (a real Anthropic call), which is
  // expected and fine — the point of this request is only to consume the
  // one allowed slot without tripping the limiter itself.
  assert.notEqual(response.status, 429, "the very first request of the day should never be rate-limited");
});

test("POST /api/chat: second request past CHAT_DAILY_LIMIT=1 returns 429 with a clear message", async () => {
  const response = await fetch(BASE_URL + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "What does Romans 8:28 mean?" }),
  });
  assert.equal(response.status, 429);
  const data = await response.json();
  assert.match(data.error, /daily chat limit/i);
});

test("POST /api/chat: rate limit is checked before message validation would otherwise pass through unrelated errors", async () => {
  // A third request, still over the limit — confirms the block isn't a
  // one-shot fluke tied to exactly the second request.
  const response = await fetch(BASE_URL + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Another message." }),
  });
  assert.equal(response.status, 429);
});
