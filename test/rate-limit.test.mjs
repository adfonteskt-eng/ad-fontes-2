// lib/rate-limit.js: per-IP daily usage caps. Same two-backend shape as
// session-store.test.mjs (in-memory + a fetch stub implementing Upstash's
// real REST contract), plus the fixed-window increment/limit logic itself.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { checkAndIncrement, clearMemoryStoreForTests } from "../lib/rate-limit.js";

let realFetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
  clearMemoryStoreForTests();
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

// --- In-memory backend -------------------------------------------------

test("in-memory: allows requests under the limit, counts up", async () => {
  const first = await checkAndIncrement("chat", "1.2.3.4", 3);
  assert.deepEqual(first, { allowed: true, count: 1, limit: 3 });
  const second = await checkAndIncrement("chat", "1.2.3.4", 3);
  assert.deepEqual(second, { allowed: true, count: 2, limit: 3 });
});

test("in-memory: blocks once the limit is reached, still counts the blocking request", async () => {
  await checkAndIncrement("chat", "1.2.3.4", 2);
  await checkAndIncrement("chat", "1.2.3.4", 2);
  const third = await checkAndIncrement("chat", "1.2.3.4", 2);
  assert.deepEqual(third, { allowed: false, count: 3, limit: 2 });
});

test("in-memory: different identifiers get independent counters", async () => {
  await checkAndIncrement("chat", "1.2.3.4", 1);
  const other = await checkAndIncrement("chat", "5.6.7.8", 1);
  assert.equal(other.allowed, true, "a different IP shouldn't be affected by another IP's usage");
});

test("in-memory: different kinds get independent counters for the same identifier", async () => {
  await checkAndIncrement("chat", "1.2.3.4", 1);
  const summary = await checkAndIncrement("summary", "1.2.3.4", 1);
  assert.equal(summary.allowed, true, "chat and summary caps shouldn't share a counter");
});

test("in-memory: window resets after it expires", async () => {
  const realNow = Date.now.bind(Date);
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  try {
    await checkAndIncrement("chat", "1.2.3.4", 1);
    const blocked = await checkAndIncrement("chat", "1.2.3.4", 1);
    assert.equal(blocked.allowed, false);

    fakeNow += 24 * 60 * 60 * 1000 + 1000; // just past the 24h window
    const afterReset = await checkAndIncrement("chat", "1.2.3.4", 1);
    assert.deepEqual(afterReset, { allowed: true, count: 1, limit: 1 });
  } finally {
    Date.now = realNow;
  }
});

// --- Redis backend (Upstash REST API) --------------------------------------

// Mirrors session-store.test.mjs's stub: parses the Upstash command-array
// contract, backed by a real Map so INCR/EXPIRE actually reflect state
// across calls within a test.
function stubUpstash({ url = "https://fake-upstash.example.com", token = "fake-token" } = {}) {
  process.env.UPSTASH_REDIS_REST_URL = url;
  process.env.UPSTASH_REDIS_REST_TOKEN = token;

  const counters = new Map(); // key -> number
  const expiries = new Map(); // key -> seconds (only ever set once, mimicking NX)
  const requests = [];

  globalThis.fetch = async (requestUrl, opts) => {
    requests.push({ url: requestUrl, opts });
    assert.equal(opts.headers.Authorization, `Bearer ${token}`);

    const [command, ...args] = JSON.parse(opts.body);
    if (command === "INCR") {
      const [key] = args;
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return { ok: true, status: 200, json: async () => ({ result: next }) };
    }
    if (command === "EXPIRE") {
      const [key, seconds, flag] = args;
      if (flag === "NX" && expiries.has(key)) {
        return { ok: true, status: 200, json: async () => ({ result: 0 }) };
      }
      expiries.set(key, seconds);
      return { ok: true, status: 200, json: async () => ({ result: 1 }) };
    }
    return { ok: true, status: 200, json: async () => ({ error: `ERR unknown command '${command}'` }) };
  };

  return { counters, expiries, requests };
}

test("redis: issues INCR then EXPIRE with NX, prefixed and namespaced by kind", async () => {
  const { requests } = stubUpstash();

  const result = await checkAndIncrement("chat", "9.9.9.9", 5);
  assert.deepEqual(result, { allowed: true, count: 1, limit: 5 });

  const incrCall = requests.find((r) => JSON.parse(r.opts.body)[0] === "INCR");
  const [, key] = JSON.parse(incrCall.opts.body);
  assert.equal(key, "adfontes:ratelimit:chat:9.9.9.9");

  const expireCall = requests.find((r) => JSON.parse(r.opts.body)[0] === "EXPIRE");
  const [, expireKey, seconds, flag] = JSON.parse(expireCall.opts.body);
  assert.equal(expireKey, key);
  assert.equal(seconds, 24 * 60 * 60);
  assert.equal(flag, "NX");
});

test("redis: blocks once the limit is reached", async () => {
  stubUpstash();
  await checkAndIncrement("chat", "9.9.9.9", 2);
  await checkAndIncrement("chat", "9.9.9.9", 2);
  const third = await checkAndIncrement("chat", "9.9.9.9", 2);
  assert.deepEqual(third, { allowed: false, count: 3, limit: 2 });
});

test("redis: EXPIRE NX only takes effect once — a repeated call doesn't reset the window", async () => {
  const { expiries } = stubUpstash();
  await checkAndIncrement("chat", "9.9.9.9", 5);
  await checkAndIncrement("chat", "9.9.9.9", 5);
  assert.equal(expiries.get("adfontes:ratelimit:chat:9.9.9.9"), 24 * 60 * 60);
  assert.equal(expiries.size, 1, "EXPIRE should have been sent twice but only taken effect once");
});
