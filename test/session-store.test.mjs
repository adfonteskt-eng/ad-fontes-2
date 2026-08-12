// lib/session-store.js: the pluggable session backend behind lib/chat.js.
// Tests both paths — the in-memory fallback (default, no env vars) and the
// Redis backend (Upstash REST API), the latter against a fetch stub that
// implements just enough of Upstash's real documented contract (POST body
// is a JSON command array, response is { result } or { error }) to catch
// a wrong request shape, not just a wrong return value.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  getSession,
  setSession,
  deleteSession,
  getSessionCount,
  isDurable,
  clearMemoryStoreForTests,
  SESSION_TTL_SECONDS,
} from "../lib/session-store.js";

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

// --- In-memory backend (no Upstash env vars set) --------------------------

test("in-memory: isDurable() is false, getSessionCount() is exact", async () => {
  assert.equal(isDurable(), false);
  assert.equal(getSessionCount(), 0);
  await setSession("s1", { history: [], lastActiveAt: Date.now() });
  assert.equal(getSessionCount(), 1);
});

test("in-memory: get/set/delete roundtrip", async () => {
  assert.equal(await getSession("missing"), undefined);
  await setSession("s1", { history: [{ role: "user", content: "hi" }], lastActiveAt: 123 });
  const got = await getSession("s1");
  assert.deepEqual(got, { history: [{ role: "user", content: "hi" }], lastActiveAt: 123 });
  await deleteSession("s1");
  assert.equal(await getSession("s1"), undefined);
});

test("in-memory: sessions expire after SESSION_TTL_SECONDS of inactivity", async () => {
  const realNow = Date.now.bind(Date);
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  try {
    await setSession("s1", { history: [], lastActiveAt: fakeNow });
    assert.notEqual(await getSession("s1"), undefined);
    fakeNow += SESSION_TTL_SECONDS * 1000 + 1000;
    assert.equal(await getSession("s1"), undefined, "expired session should read as missing");
  } finally {
    Date.now = realNow;
  }
});

// --- Redis backend (Upstash REST API) --------------------------------------

// A minimal in-test fake of Upstash's REST contract: POST body is a JSON
// command array (["GET", key] / ["SET", key, value, "EX", seconds] /
// ["DEL", key]), response is { result } on success. Backed by a plain Map
// so GET actually reflects prior SET/DEL calls within a test.
function stubUpstash({ url = "https://fake-upstash.example.com", token = "fake-token" } = {}) {
  process.env.UPSTASH_REDIS_REST_URL = url;
  process.env.UPSTASH_REDIS_REST_TOKEN = token;

  const store = new Map();
  const requests = [];

  globalThis.fetch = async (requestUrl, opts) => {
    requests.push({ url: requestUrl, opts });
    assert.equal(requestUrl, url, "should call the configured Upstash URL");
    assert.equal(opts.headers.Authorization, `Bearer ${token}`, "should send the bearer token");

    const [command, ...args] = JSON.parse(opts.body);
    if (command === "GET") {
      const [key] = args;
      const value = store.has(key) ? store.get(key) : null;
      return { ok: true, status: 200, json: async () => ({ result: value }) };
    }
    if (command === "SET") {
      const [key, value] = args;
      store.set(key, value);
      return { ok: true, status: 200, json: async () => ({ result: "OK" }) };
    }
    if (command === "DEL") {
      const [key] = args;
      const existed = store.delete(key);
      return { ok: true, status: 200, json: async () => ({ result: existed ? 1 : 0 }) };
    }
    return { ok: true, status: 200, json: async () => ({ error: `ERR unknown command '${command}'` }) };
  };

  return { store, requests };
}

test("redis: isDurable() is true and getSessionCount() is null (not tracked)", () => {
  stubUpstash();
  assert.equal(isDurable(), true);
  assert.equal(getSessionCount(), null);
});

test("redis: get/set/delete roundtrip issues the documented command shape", async () => {
  const { store, requests } = stubUpstash();

  assert.equal(await getSession("s1"), undefined, "missing key should read as undefined, not throw");

  await setSession("s1", { history: [{ role: "user", content: "hi" }], lastActiveAt: 123 });
  const setRequest = requests.find((r) => JSON.parse(r.opts.body)[0] === "SET");
  const [, key, value, exFlag, ttl] = JSON.parse(setRequest.opts.body);
  assert.equal(key, "adfontes:session:s1", "should prefix the key to avoid collisions");
  assert.deepEqual(JSON.parse(value), { history: [{ role: "user", content: "hi" }], lastActiveAt: 123 });
  assert.equal(exFlag, "EX");
  assert.equal(ttl, SESSION_TTL_SECONDS);

  const got = await getSession("s1");
  assert.deepEqual(got, { history: [{ role: "user", content: "hi" }], lastActiveAt: 123 });

  await deleteSession("s1");
  assert.equal(store.has("adfontes:session:s1"), false);
  assert.equal(await getSession("s1"), undefined);
});

test("redis: a corrupted stored value reads as undefined rather than throwing", async () => {
  const { store } = stubUpstash();
  store.set("adfontes:session:bad", "{not valid json");
  assert.equal(await getSession("bad"), undefined);
});

test("redis: an HTTP error response throws with a clear message", async () => {
  process.env.UPSTASH_REDIS_REST_URL = "https://fake-upstash.example.com";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
  globalThis.fetch = async () => ({ ok: false, status: 500, statusText: "Internal Server Error", text: async () => "boom" });
  await assert.rejects(() => getSession("s1"), /Upstash Redis returned 500/);
});

test("redis: a Redis-level error field throws instead of silently returning garbage", async () => {
  process.env.UPSTASH_REDIS_REST_URL = "https://fake-upstash.example.com";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ error: "WRONGPASS invalid password" }) });
  await assert.rejects(() => getSession("s1"), /Upstash Redis error: WRONGPASS/);
});

test("switching env vars mid-run switches backends without re-importing the module", async () => {
  // isRedisConfigured() must read process.env fresh on every call, not
  // cache it at module-load time — otherwise this exact test setup
  // (multiple test files sharing one process, each toggling env vars)
  // would silently use whichever backend was active when the module first
  // loaded, regardless of what later tests configure.
  assert.equal(isDurable(), false);
  stubUpstash();
  assert.equal(isDurable(), true);
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  assert.equal(isDurable(), false);
});
