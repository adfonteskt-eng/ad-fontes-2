// lib/bible-search.js: parsing bsb.txt's own format, the inverted-index
// keyword search, and searchBibleText()'s handling of a not-yet-downloaded
// data file. parseBsbText()/buildInvertedIndex()/searchVerses() are tested
// directly against small hand-built fixtures (no filesystem, no real
// multi-megabyte download needed).
//
// The "file missing" tests below can't just assume data/bsb.txt is absent —
// whether it actually is depends on whether `npm run fetch-data` has been
// run in *this* environment (it has network access to bereanbible.com in
// CI/most local setups, but not in every sandbox), so a naive test would
// pass in one environment and fail in another for reasons that have nothing
// to do with the code under test. Instead, withBsbFileMissing() below
// temporarily renames the real file out of the way (if present), runs the
// assertion, and renames it back — deterministic either way, and it leaves
// the file exactly as it found it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, rename } from "node:fs/promises";

import { dataFile } from "../scripts/fetch-data.js";
import {
  parseBsbText,
  buildInvertedIndex,
  searchVerses,
  searchBibleText,
  isBibleTextAvailable,
  clearBibleSearchCache,
  BSB_FILE,
} from "../lib/bible-search.js";

// --- parseBsbText ------------------------------------------------------

test("parseBsbText skips header/blank lines and parses Verse<TAB>Text rows", () => {
  const raw = [
    "﻿The Holy Bible, Berean Standard Bible, BSB is produced in cooperation with...",
    "This text of God's Word has been dedicated to the public domain.",
    "Verse\tBerean Standard Bible",
    "Genesis 1:1\tIn the beginning God created the heavens and the earth.",
    "",
    "Genesis 1:2\tNow the earth was formless and void.",
  ].join("\n");

  const { verses, unrecognizedBookNames } = parseBsbText(raw);
  assert.equal(unrecognizedBookNames.length, 0);
  assert.equal(verses.length, 2);
  assert.deepEqual(verses[0], { usfm: "GEN.1.1", book: "GEN", chapter: 1, verse: 1, text: "In the beginning God created the heavens and the earth." });
  assert.deepEqual(verses[1], { usfm: "GEN.1.2", book: "GEN", chapter: 1, verse: 2, text: "Now the earth was formless and void." });
});

test("parseBsbText handles multi-word book names correctly (greedy book-name match)", () => {
  const raw = [
    "1 Corinthians 13:4\tLove is patient, love is kind.",
    "Song of Solomon 1:1\tSolomon's Song of Songs.",
    "1 John 4:8\tGod is love.",
  ].join("\n");

  const { verses, unrecognizedBookNames } = parseBsbText(raw);
  assert.equal(unrecognizedBookNames.length, 0);
  assert.equal(verses[0].usfm, "1CO.13.4");
  assert.equal(verses[1].usfm, "SNG.1.1", "Song of Solomon should alias to the SNG book code");
  assert.equal(verses[2].usfm, "1JN.4.8");
});

test("parseBsbText reports, but does not throw on, an unrecognized book name", () => {
  const raw = "Not A Real Book 1:1\tSome text.";
  const { verses, unrecognizedBookNames } = parseBsbText(raw);
  assert.equal(verses.length, 0);
  assert.deepEqual(unrecognizedBookNames, ["Not A Real Book"]);
});

// --- buildInvertedIndex / searchVerses ----------------------------------

const FIXTURE_VERSES = [
  { usfm: "JHN.3.16", book: "JHN", chapter: 3, verse: 16, text: "For God so loved the world that He gave His one and only Son." },
  { usfm: "ROM.5.8", book: "ROM", chapter: 5, verse: 8, text: "God shows His love in that while we were still sinners, Christ died for us." },
  { usfm: "1KI.19.12", book: "1KI", chapter: 19, verse: 12, text: "And after the fire came a still, small voice." },
  { usfm: "PHP.4.7", book: "PHP", chapter: 4, verse: 7, text: "And the peace of God, which surpasses all understanding." },
];

function fixtureIndex() {
  return buildInvertedIndex(FIXTURE_VERSES);
}

test("searchVerses finds a verse matching a single word", () => {
  const results = searchVerses(FIXTURE_VERSES, fixtureIndex(), "voice");
  assert.equal(results.length, 1);
  assert.equal(results[0].usfm, "1KI.19.12");
});

test("searchVerses requires ALL query words to appear (AND across words)", () => {
  const results = searchVerses(FIXTURE_VERSES, fixtureIndex(), "God love");
  // JHN.3.16 has "God" and "loved" (not "love"), ROM.5.8 has "God" and "love" -- exact-token match only
  assert.deepEqual(results.map((r) => r.usfm), ["ROM.5.8"]);
});

test("searchVerses is an exact-token match, not stemmed", () => {
  const results = searchVerses(FIXTURE_VERSES, fixtureIndex(), "love");
  assert.deepEqual(results.map((r) => r.usfm), ["ROM.5.8"], '"love" should not also match "loved"');
});

test("searchVerses is case-insensitive", () => {
  // "God" appears in JHN.3.16, ROM.5.8, and PHP.4.7 ("the peace of God...") --
  // all three should match regardless of the query's casing.
  const results = searchVerses(FIXTURE_VERSES, fixtureIndex(), "GOD");
  assert.equal(results.length, 3);
});

test("searchVerses returns [] for an empty query", () => {
  assert.deepEqual(searchVerses(FIXTURE_VERSES, fixtureIndex(), ""), []);
  assert.deepEqual(searchVerses(FIXTURE_VERSES, fixtureIndex(), "   "), []);
});

test("searchVerses returns [] when no verse contains all query words", () => {
  const results = searchVerses(FIXTURE_VERSES, fixtureIndex(), "God xyzzy");
  assert.deepEqual(results, []);
});

test("searchVerses results are in canonical (file) order, not relevance-scored", () => {
  const results = searchVerses(FIXTURE_VERSES, fixtureIndex(), "God");
  assert.deepEqual(
    results.map((r) => r.usfm),
    ["JHN.3.16", "ROM.5.8", "PHP.4.7"],
    "should preserve the verses array's own order",
  );
});

test("searchVerses respects and caps the limit option", () => {
  const results = searchVerses(FIXTURE_VERSES, fixtureIndex(), "God", { limit: 1 });
  assert.equal(results.length, 1);
  const uncapped = searchVerses(FIXTURE_VERSES, fixtureIndex(), "God", { limit: 9999 });
  assert.ok(uncapped.length <= 50, "limit should be capped at MAX_LIMIT even if a caller asks for more");
});

// --- searchBibleText / isBibleTextAvailable: the "not yet downloaded" path --
// Whether data/bsb.txt actually exists on disk depends on whether
// `npm run fetch-data` has run somewhere with network access to
// bereanbible.com -- true in CI, not necessarily true in every local/
// sandboxed environment. These tests can't assume either way; see this
// file's header comment for why withBsbFileMissing() temporarily moves the
// real file aside instead.

const REAL_BSB_PATH = dataFile(BSB_FILE);
const MOVED_ASIDE_PATH = dataFile(`${BSB_FILE}.test-backup`);

async function withBsbFileMissing(fn) {
  let movedAside = false;
  try {
    await access(REAL_BSB_PATH);
    await rename(REAL_BSB_PATH, MOVED_ASIDE_PATH);
    movedAside = true;
  } catch {
    // Already missing in this environment -- nothing to move, the "missing"
    // state already holds.
  }
  clearBibleSearchCache();
  try {
    await fn();
  } finally {
    if (movedAside) await rename(MOVED_ASIDE_PATH, REAL_BSB_PATH);
    clearBibleSearchCache();
  }
}

test("isBibleTextAvailable is false when data/bsb.txt hasn't been downloaded", async () => {
  await withBsbFileMissing(async () => {
    assert.equal(await isBibleTextAvailable(), false);
  });
});

test("searchBibleText throws a clear, catchable error when data/bsb.txt is missing", async () => {
  await withBsbFileMissing(async () => {
    await assert.rejects(
      () => searchBibleText("love"),
      (error) => {
        assert.equal(error.code, "BSB_NOT_DOWNLOADED");
        assert.match(error.message, /fetch-data/);
        return true;
      },
    );
  });
});
