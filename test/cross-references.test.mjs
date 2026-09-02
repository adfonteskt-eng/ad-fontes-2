// lib/cross-references.js: parsing openbible.info's cross-references.txt
// format, building the bidirectional index, and findCrossReferences()'s
// handling of a not-yet-downloaded data file. Same "file missing" caveat
// and withCrossRefsFileMissing() pattern as test/bible-search.test.mjs —
// see that file's header comment for why a naive test can't just assume
// the file is absent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, rename } from "node:fs/promises";

import { dataFile } from "../scripts/fetch-data.js";
import {
  parseCrossReferencesText,
  buildCrossReferenceIndex,
  lookupCrossReferences,
  findCrossReferences,
  isCrossReferencesAvailable,
  clearCrossReferencesCache,
  formatCrossRefRange,
  CROSS_REFS_FILE,
} from "../lib/cross-references.js";

// --- parseCrossReferencesText -------------------------------------------

test("parseCrossReferencesText skips the header line and parses From/To/Votes rows", () => {
  const raw = [
    "From Verse\tTo Verse\tVotes\t#www.openbible.info CC-BY 2026-08-31",
    "Gen.1.1\tPs.121.2\t65",
    "Gen.1.1\tJohn.1.1-John.1.3\t378",
  ].join("\n");

  const { rows, skipped } = parseCrossReferencesText(raw);
  assert.equal(skipped, 0);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { fromUsfm: "GEN.1.1", toStart: "PSA.121.2", toEnd: "PSA.121.2", toDisplay: "PSA.121.2", votes: 65 });
  assert.deepEqual(rows[1], { fromUsfm: "GEN.1.1", toStart: "JHN.1.1", toEnd: "JHN.1.3", toDisplay: "JHN.1.1-3", votes: 378 });
});

test("parseCrossReferencesText skips blank lines and malformed rows without throwing", () => {
  const raw = ["", "Gen.1.1\tPs.121.2\t65", "not a real row", "Gen.1.1\tPs.121.2"].join("\n");
  const { rows, skipped } = parseCrossReferencesText(raw);
  assert.equal(rows.length, 1);
  assert.equal(skipped, 2);
});

test("parseCrossReferencesText reports, but does not throw on, an unrecognized book abbreviation", () => {
  const raw = "Xyz.1.1\tPs.121.2\t65";
  const { rows, skipped } = parseCrossReferencesText(raw);
  assert.equal(rows.length, 0);
  assert.equal(skipped, 1);
});

// --- formatCrossRefRange --------------------------------------------------

test("formatCrossRefRange formats a single verse, same-chapter range, and cross-chapter range", () => {
  const v = (usfm, chapter, verse) => ({ usfm, chapter, verse });
  assert.equal(formatCrossRefRange(v("JHN.3.16", 3, 16), v("JHN.3.16", 3, 16)), "JHN.3.16");
  assert.equal(formatCrossRefRange(v("PSA.148.4", 148, 4), v("PSA.148.5", 148, 5)), "PSA.148.4-5");
  assert.equal(formatCrossRefRange(v("JHN.1.1", 1, 1), v("JHN.2.2", 2, 2)), "JHN.1.1-2.2");
});

// --- buildCrossReferenceIndex / lookupCrossReferences ---------------------

const FIXTURE_ROWS = [
  { fromUsfm: "GEN.1.1", toStart: "PSA.121.2", toEnd: "PSA.121.2", toDisplay: "PSA.121.2", votes: 65 },
  { fromUsfm: "GEN.1.1", toStart: "JHN.1.1", toEnd: "JHN.1.3", toDisplay: "JHN.1.1-3", votes: 378 },
  { fromUsfm: "ROM.5.8", toStart: "JHN.3.16", toEnd: "JHN.3.16", toDisplay: "JHN.3.16", votes: 981 },
];

test("lookupCrossReferences finds a verse's forward connections, highest-voted first", () => {
  const index = buildCrossReferenceIndex(FIXTURE_ROWS);
  const { results, totalCount } = lookupCrossReferences(index, "GEN.1.1");
  assert.equal(totalCount, 2);
  assert.deepEqual(results.map((r) => r.reference), ["JHN.1.1-3", "PSA.121.2"]);
});

test("lookupCrossReferences also finds a verse's reverse connections (indexed by range start)", () => {
  const index = buildCrossReferenceIndex(FIXTURE_ROWS);
  const { results, totalCount } = lookupCrossReferences(index, "JHN.3.16");
  assert.equal(totalCount, 1);
  assert.deepEqual(results, [{ reference: "ROM.5.8", votes: 981 }]);
});

test("lookupCrossReferences returns an empty result for a verse with no connections", () => {
  const index = buildCrossReferenceIndex(FIXTURE_ROWS);
  assert.deepEqual(lookupCrossReferences(index, "REV.22.21"), { results: [], totalCount: 0 });
});

test("lookupCrossReferences respects and caps the limit option", () => {
  const index = buildCrossReferenceIndex(FIXTURE_ROWS);
  const { results } = lookupCrossReferences(index, "GEN.1.1", { limit: 1 });
  assert.equal(results.length, 1);
  const { results: uncapped } = lookupCrossReferences(index, "GEN.1.1", { limit: 9999 });
  assert.ok(uncapped.length <= 30, "limit should be capped at MAX_LIMIT even if a caller asks for more");
});

test("buildCrossReferenceIndex dedupes a pair listed in both directions, keeping the higher vote count", () => {
  const rows = [
    { fromUsfm: "GEN.1.1", toStart: "PSA.121.2", toEnd: "PSA.121.2", toDisplay: "PSA.121.2", votes: 65 },
    { fromUsfm: "PSA.121.2", toStart: "GEN.1.1", toEnd: "GEN.1.1", toDisplay: "GEN.1.1", votes: 90 },
  ];
  const index = buildCrossReferenceIndex(rows);
  const { results, totalCount } = lookupCrossReferences(index, "GEN.1.1");
  assert.equal(totalCount, 1);
  assert.deepEqual(results, [{ reference: "PSA.121.2", votes: 90 }]);
});

// --- findCrossReferences / isCrossReferencesAvailable: the "not yet downloaded" path --
// Same reasoning as test/bible-search.test.mjs's withBsbFileMissing(): whether
// data/cross-references.txt actually exists depends on whether `npm run
// fetch-data` has run with network access in this environment, so these
// tests temporarily move the real file aside rather than assuming either way.

const REAL_PATH = dataFile(CROSS_REFS_FILE);
const MOVED_ASIDE_PATH = dataFile(`${CROSS_REFS_FILE}.test-backup`);

async function withCrossRefsFileMissing(fn) {
  let movedAside = false;
  try {
    await access(REAL_PATH);
    await rename(REAL_PATH, MOVED_ASIDE_PATH);
    movedAside = true;
  } catch {
    // Already missing in this environment -- nothing to move.
  }
  clearCrossReferencesCache();
  try {
    await fn();
  } finally {
    if (movedAside) await rename(MOVED_ASIDE_PATH, REAL_PATH);
    clearCrossReferencesCache();
  }
}

test("isCrossReferencesAvailable is false when data/cross-references.txt hasn't been downloaded", async () => {
  await withCrossRefsFileMissing(async () => {
    assert.equal(await isCrossReferencesAvailable(), false);
  });
});

test("findCrossReferences throws a clear, catchable error when data/cross-references.txt is missing", async () => {
  await withCrossRefsFileMissing(async () => {
    await assert.rejects(
      () => findCrossReferences("JHN.3.16"),
      (error) => {
        assert.equal(error.code, "CROSS_REFERENCES_NOT_DOWNLOADED");
        assert.match(error.message, /fetch-data/);
        return true;
      },
    );
  });
});
