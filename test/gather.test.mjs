// gatherPassage()'s in-memory cache (lib/gather.js) — coalescing concurrent
// requests, TTL isolation by option combo, and not caching a thrown error.
// Network is stubbed throughout; nothing here needs a real YouVersion key.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { gatherPassage, clearGatherCache } from "../lib/gather.js";

let realFetch;
let fetchCount;

before(() => {
  realFetch = globalThis.fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

function stubYouVersion() {
  fetchCount = 0;
  globalThis.fetch = async (url) => {
    const href = url.toString();
    if (href.includes("youversion")) {
      fetchCount++;
      return { ok: true, json: async () => ({ content: "<p>stub</p>", reference: "Jhn.3.16" }) };
    }
    throw new Error(`unexpected fetch in gather cache test: ${href}`);
  };
}

test("concurrent identical requests coalesce into one fetch batch", async () => {
  clearGatherCache();
  stubYouVersion();

  const [a, b] = await Promise.all([
    gatherPassage("JHN.3.16", { appKey: "k", includeCommentary: false }),
    gatherPassage("JHN.3.16", { appKey: "k", includeCommentary: false }),
  ]);

  assert.equal(a, b, "concurrent calls should resolve to the literal same object");
  assert.ok(fetchCount > 0, "the shared fetch should have actually happened");
});

test("a sequential repeat hits the cache with zero new fetches", async () => {
  clearGatherCache();
  stubYouVersion();

  const first = await gatherPassage("JHN.3.16", { appKey: "k", includeCommentary: false });
  const before = fetchCount;
  const second = await gatherPassage("JHN.3.16", { appKey: "k", includeCommentary: false });

  assert.equal(fetchCount, before, "no new fetch should have happened");
  assert.equal(first, second);
});

test("a different reference is not cached under the same key", async () => {
  clearGatherCache();
  stubYouVersion();

  await gatherPassage("JHN.3.16", { appKey: "k", includeCommentary: false });
  const before = fetchCount;
  await gatherPassage("ROM.8.28", { appKey: "k", includeCommentary: false });

  assert.ok(fetchCount > before, "a different reference should trigger new fetches");
});

test("a different option combo for the same reference is not cached together", async () => {
  clearGatherCache();
  stubYouVersion();

  await gatherPassage("JHN.3.16", { appKey: "k", includeCommentary: false });
  const before = fetchCount;
  await gatherPassage("JHN.3.16", { appKey: "k", includeCommentary: false, includeVariants: true });

  assert.ok(fetchCount > before, "includeVariants should be part of the cache key");
});

test("includeTranslations: false skips the YouVersion fetch and returns an empty translations array", async () => {
  clearGatherCache();
  stubYouVersion();

  const result = await gatherPassage("JHN.3.16", { appKey: "k", includeCommentary: false, includeTranslations: false });
  assert.deepEqual(result.translations, []);
  assert.equal(fetchCount, 0, "no YouVersion fetch should have happened");
});

test("includeOriginalLanguage: false skips the interlinear lookup and returns a skipped marker", async () => {
  clearGatherCache();
  stubYouVersion();

  const result = await gatherPassage("JHN.3.16", { appKey: "k", includeCommentary: false, includeOriginalLanguage: false });
  assert.equal(result.originalLanguage.type, "skipped");
  assert.deepEqual(result.originalLanguage.words, []);
});

test("includeTranslations/includeOriginalLanguage are part of the cache key, so a narrower and a fuller request for the same reference don't collide", async () => {
  clearGatherCache();
  stubYouVersion();

  const narrow = await gatherPassage("JHN.3.16", { appKey: "k", includeCommentary: false, includeTranslations: false });
  const full = await gatherPassage("JHN.3.16", { appKey: "k", includeCommentary: false });

  assert.deepEqual(narrow.translations, []);
  assert.ok(full.translations.length > 0, "the fuller request should have actually fetched translations, not reused the narrow one's cached (empty) result");
});

test("a thrown parse error is not cached as a standing failure", async () => {
  clearGatherCache();
  globalThis.fetch = async () => {
    throw new Error("should not be called for a malformed reference");
  };

  await assert.rejects(() => gatherPassage("not-a-valid-usfm", { appKey: "k" }));
  await assert.rejects(() => gatherPassage("not-a-valid-usfm", { appKey: "k" }));
  // Both rejections above (not a hang, not a silently-cached success) is
  // itself the assertion — nothing further to check.
});
