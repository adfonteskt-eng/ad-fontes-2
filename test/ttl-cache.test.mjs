// Unit tests for the shared TTLCache (lib/ttl-cache.js), used by both
// lib/gather.js and lib/interlinear.js. Tested here in isolation rather
// than only indirectly through its callers, since the eviction/expiry
// logic is exactly the kind of boundary behavior worth pinning down
// directly — a subtle bug here would silently affect every cache in the
// project at once.
import { test } from "node:test";
import assert from "node:assert/strict";

import { TTLCache } from "../lib/ttl-cache.js";

test("basic get/set roundtrip", () => {
  const cache = new TTLCache({ ttlMs: 60000, maxEntries: 10 });
  assert.equal(cache.get("a"), undefined);
  cache.set("a", 1);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.size, 1);
});

test("entries expire after ttlMs", () => {
  const realNow = Date.now.bind(Date);
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  try {
    const cache = new TTLCache({ ttlMs: 1000, maxEntries: 10 });
    cache.set("a", 1);
    assert.equal(cache.get("a"), 1);

    fakeNow += 1001;
    assert.equal(cache.get("a"), undefined, "expired entry should read as missing");
    assert.equal(cache.size, 0, "get() on an expired entry should also remove it");
  } finally {
    Date.now = realNow;
  }
});

test("evicts least-recently-used entry once over maxEntries", () => {
  const cache = new TTLCache({ ttlMs: 60000, maxEntries: 3 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert.equal(cache.size, 3);

  // Touch "a" so it's no longer the least-recently-used.
  cache.get("a");

  cache.set("d", 4); // pushes size to 4, should evict the LRU entry
  assert.equal(cache.size, 3);
  assert.equal(cache.get("a"), 1, "recently-touched entry should survive eviction");
  assert.equal(cache.get("b"), undefined, "least-recently-used entry should be evicted");
  assert.equal(cache.get("c"), 3);
  assert.equal(cache.get("d"), 4);
});

test("delete() and clear()", () => {
  const cache = new TTLCache({ ttlMs: 60000, maxEntries: 10 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.delete("a");
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), 2);

  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get("b"), undefined);
});

test("has() reflects expiry, not just presence", () => {
  const realNow = Date.now.bind(Date);
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  try {
    const cache = new TTLCache({ ttlMs: 1000, maxEntries: 10 });
    cache.set("a", 1);
    assert.equal(cache.has("a"), true);
    fakeNow += 1001;
    assert.equal(cache.has("a"), false);
  } finally {
    Date.now = realNow;
  }
});
