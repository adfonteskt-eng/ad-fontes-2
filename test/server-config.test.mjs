// Companion to test/server.test.mjs's "unconfigured" case for GET
// /api/config -- a separate spawned instance (same reasoning as
// test/server-rate-limit.test.mjs) so this one can set fake Supabase
// values without affecting the rest of that file's fixed env.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

const REPO_ROOT = new URL("..", import.meta.url);
const PORT = 36617 + Math.floor(Math.random() * 1000);
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
      SUPABASE_URL: "https://fake-project.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fake",
      SUPABASE_SECRET_KEY: "sb_secret_fake",
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

test("GET /api/config echoes the public Supabase URL and publishable key when configured", async () => {
  const response = await fetch(BASE_URL + "/api/config");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data, {
    supabaseUrl: "https://fake-project.supabase.co",
    supabasePublishableKey: "sb_publishable_fake",
  });
});

test("GET /api/config never leaks the secret key", async () => {
  const response = await fetch(BASE_URL + "/api/config");
  const data = await response.json();
  const raw = JSON.stringify(data);
  assert.ok(!raw.includes("sb_secret_fake"), "the secret key must never appear in a client-facing response");
});
