// Regression tests for the real bugs found and fixed across this project's
// STEPBible parsing (lib/interlinear.js) and the gather-level error
// messages built on top of it (lib/gather.js) — all against the actual
// downloaded TAGNT/TAHOT/TBESG/TBESH data files, not synthetic fixtures.
// Each test here corresponds to a specific historical bug; if one of these
// starts failing, that bug has almost certainly come back.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  parseReference,
  readGreekVerseWords,
  readHebrewVerseWords,
  searchLexicon,
  findStrongsOccurrences,
} from "../lib/interlinear.js";
import { gatherPassage, clearGatherCache } from "../lib/gather.js";

let realFetch;

before(() => {
  realFetch = globalThis.fetch;
  // gatherPassage() also fetches translations; stub YouVersion so these
  // tests only exercise the original-language path they're actually about.
  globalThis.fetch = async (url) => {
    const href = url.toString();
    if (href.includes("youversion")) {
      return { ok: true, json: async () => ({ content: "<p>stub</p>", reference: "stub" }) };
    }
    throw new Error(`unexpected fetch in interlinear test: ${href}`);
  };
});

after(() => {
  globalThis.fetch = realFetch;
});

test("JHN.3.16 returns real tagged Greek with the expected word count", async () => {
  const ref = parseReference("JHN.3.16");
  const { words } = await readGreekVerseWords(ref);
  assert.ok(words.length > 0, "expected tagged Greek words");
  // NA28 critical text for John 3:16 is 24 words; the TR/Byzantine-only
  // "his" variant is filtered separately by gatherGreek(), not here.
  const critical = words.filter((w) => w.isCriticalText);
  assert.ok(critical.length >= 20 && critical.length <= 26, `expected ~24 critical-text words, got ${critical.length}`);
});

test("Hebrew dual-versification: PSA.48.4 carries a hebrewVerseRef note", async () => {
  clearGatherCache();
  const gathered = await gatherPassage("PSA.48.4", { appKey: "k", includeCommentary: false });
  const ol = gathered.originalLanguage;
  assert.equal(ol.error, null);
  assert.ok(ol.words.length > 0);
  assert.ok(ol.hebrewVerseRef, "expected a hebrewVerseRef offset note for a psalm past the superscription");
});

test("TAGNT bracket versification: PHP.1.16 and PHP.1.17 don't cross-contaminate", async () => {
  // Real, well-documented transposition case: this dataset's primary
  // (NRSV) numbering and the KJV's are swapped for these two verses —
  // primary Php.1.16 is the KJV's 1:17 and vice versa. Php.1.16 (NRSV) is
  // about proclaiming Christ "out of love" (G0026, agapē); Php.1.17 (NRSV)
  // is about doing so "out of selfish ambition" (G2052, eritheia). The
  // historical bug merged a verse's own primary content with an unrelated
  // verse's content whenever their bracket numbers collided.
  const ref16 = parseReference("PHP.1.16");
  const ref17 = parseReference("PHP.1.17");
  const { words: words16 } = await readGreekVerseWords(ref16);
  const { words: words17 } = await readGreekVerseWords(ref17);

  assert.ok(words16.length > 0 && words17.length > 0);
  assert.ok(words16.some((w) => w.strongs === "G0026"), "PHP.1.16 should contain agapē (love)");
  assert.ok(!words16.some((w) => w.strongs === "G2052"), "PHP.1.16 should not contain PHP.1.17's eritheia");
  assert.ok(words17.some((w) => w.strongs === "G2052"), "PHP.1.17 should contain eritheia (selfish ambition)");
  assert.ok(!words17.some((w) => w.strongs === "G0026"), "PHP.1.17 should not contain PHP.1.16's agapē");
});

test("Mark 16:9 (disputed ending) gets an explanatory error, not a silent empty result", async () => {
  clearGatherCache();
  const gathered = await gatherPassage("MRK.16.9", { appKey: "k", includeCommentary: false });
  const ol = gathered.originalLanguage;
  assert.equal(ol.words.length, 0);
  assert.match(ol.error ?? "", /TR\/Byzantine|variants/i, "should explain this is a manuscript-tradition variant, not missing data");
});

test("Qere/Ketiv placeholder rows are filtered out of Hebrew word lists", async () => {
  const ref = parseReference("JDG.16.25");
  const { words } = await readHebrewVerseWords(ref);
  assert.ok(words.length > 0);
  assert.ok(!words.some((w) => !w.surface), "no word should have empty Hebrew surface text");
});

test("searchLexicon finds real Strong's numbers for an English concept", async () => {
  const { results, totalCount } = await searchLexicon("love", { testament: "both", limit: 15 });
  assert.ok(totalCount > 0);
  assert.ok(results.some((r) => r.strongs === "G0025"), "expected agapaō (G0025) among the results");
});

test("findStrongsOccurrences returns real cross-references for a common word", async () => {
  const { occurrences, totalCount } = await findStrongsOccurrences("G0025", { limit: 5 });
  assert.equal(occurrences.length, 5);
  assert.ok(totalCount > 100, "agapaō should occur well over 100 times in the NT");
  assert.ok(occurrences.every((o) => /^[A-Za-z0-9]+\.\d+\.\d+$/.test(o.reference)));
});

test("findStrongsOccurrences caches repeat lookups (real speedup, not just equal output)", async () => {
  // G2532 (kai, "and") is one of the most common words in the NT — a full,
  // uncached scan of both TAGNT files is genuinely slow enough (hundreds of
  // ms) to make a cached repeat's speedup unambiguous rather than noise.
  const start1 = Date.now();
  const first = await findStrongsOccurrences("G2532", { limit: 10 });
  const uncachedMs = Date.now() - start1;

  const start2 = Date.now();
  const second = await findStrongsOccurrences("G2532", { limit: 10 });
  const cachedMs = Date.now() - start2;

  assert.deepEqual(second, first, "a cached repeat should return the identical result");
  assert.ok(
    cachedMs < uncachedMs / 2 || cachedMs < 20,
    `expected a cached call to be clearly faster (uncached ${uncachedMs}ms, cached ${cachedMs}ms)`,
  );
});

test("findStrongsOccurrences cache is keyed by limit, not just the Strong's number", async () => {
  const small = await findStrongsOccurrences("G0025", { limit: 3 });
  const large = await findStrongsOccurrences("G0025", { limit: 8 });
  assert.equal(small.occurrences.length, 3);
  assert.equal(large.occurrences.length, 8);
  assert.equal(small.totalCount, large.totalCount, "totalCount shouldn't depend on limit");
});

test("searchLexicon cache is keyed by testament, not just the keyword", async () => {
  const both = await searchLexicon("love", { testament: "both", limit: 30 });
  const greekOnly = await searchLexicon("love", { testament: "greek", limit: 30 });
  assert.ok(both.totalCount >= greekOnly.totalCount, "both-testament search shouldn't return fewer matches than Greek alone");
  assert.ok(greekOnly.results.every((r) => r.strongs.startsWith("G")), "a Greek-only search shouldn't leak Hebrew entries");
});
