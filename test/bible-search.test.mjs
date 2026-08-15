// lib/bible-search.js: parsing bsb.txt's own format, the inverted-index
// keyword search, and searchBibleText()'s handling of a not-yet-downloaded
// data file. parseBsbText()/buildInvertedIndex()/searchVerses() are tested
// directly against small hand-built fixtures (no filesystem, no real
// multi-megabyte download needed) — only the "file missing" path of
// searchBibleText()/isBibleTextAvailable() touches the filesystem, and does
// so against whatever's actually on disk (this sandbox has no network path
// to bereanbible.com, so data/bsb.txt is genuinely absent here — see
// scripts/fetch-data.js's downloadBsb() and this file's own test for that
// exact case below).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseBsbText,
  buildInvertedIndex,
  searchVerses,
  searchBibleText,
  isBibleTextAvailable,
  clearBibleSearchCache,
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

// --- searchBibleText / isBibleTextAvailable (real filesystem, no data/bsb.txt here) --

test("isBibleTextAvailable is false when data/bsb.txt hasn't been downloaded", async () => {
  // This sandbox has no network path to bereanbible.com (see
  // scripts/fetch-data.js's downloadBsb()), so data/bsb.txt is genuinely
  // absent here -- this exercises the real "not yet fetched" path rather
  // than a mocked one.
  assert.equal(await isBibleTextAvailable(), false);
});

test("searchBibleText throws a clear, catchable error when data/bsb.txt is missing", async () => {
  clearBibleSearchCache();
  await assert.rejects(
    () => searchBibleText("love"),
    (error) => {
      assert.equal(error.code, "BSB_NOT_DOWNLOADED");
      assert.match(error.message, /fetch-data/);
      return true;
    },
  );
});
