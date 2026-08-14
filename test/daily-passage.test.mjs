import { test } from "node:test";
import assert from "node:assert/strict";

import { DAILY_PASSAGES, getDailyPassage } from "../lib/daily-passage.js";
import { isNewTestament, isOldTestament, parseReference } from "../lib/interlinear.js";

test("every curated passage is a well-formed, supported reference", () => {
  // Catches typos in the hand-typed list (a wrong book code, a "." instead
  // of the expected separator, etc.) without needing the actual STEPBible
  // data downloaded — parseReference() + isNewTestament/isOldTestament()
  // only need the book-code tables, not the data files themselves.
  for (const { usfm, label } of DAILY_PASSAGES) {
    const reference = parseReference(usfm);
    const supported = isNewTestament(reference.book) || isOldTestament(reference.book);
    assert.ok(supported, `${usfm} (${label}) has an unrecognized book code`);
  }
});

test("every curated passage has a short, non-empty tag", () => {
  // The homepage shows this right under the reference (see server.js's
  // GET /api/daily and public/app.js's loadDailyPassage) -- an entry
  // missing one would render as a blank line, so this is worth catching in
  // the same pass as the other hand-typed-list checks above.
  for (const { usfm, label, tag } of DAILY_PASSAGES) {
    assert.equal(typeof tag, "string", `${usfm} (${label}) is missing a tag`);
    assert.ok(tag.trim().length > 0, `${usfm} (${label}) has an empty tag`);
    assert.ok(tag.length <= 120, `${usfm} (${label})'s tag is too long for a homepage teaser (${tag.length} chars)`);
  }
});

test("no duplicate references in the curated list", () => {
  const seen = new Set();
  for (const { usfm } of DAILY_PASSAGES) {
    assert.ok(!seen.has(usfm), `${usfm} appears more than once`);
    seen.add(usfm);
  }
});

test("list is long enough that the daily rotation doesn't repeat within a couple months", () => {
  assert.ok(DAILY_PASSAGES.length >= 60, `only ${DAILY_PASSAGES.length} entries`);
});

test("getDailyPassage is deterministic for a given date", () => {
  const date = new Date("2026-03-15T12:00:00Z");
  assert.deepEqual(getDailyPassage(date), getDailyPassage(new Date("2026-03-15T23:59:00Z")));
});

test("getDailyPassage changes across a UTC day boundary", () => {
  const a = getDailyPassage(new Date("2026-03-15T23:59:00Z"));
  const b = getDailyPassage(new Date("2026-03-16T00:01:00Z"));
  // Not asserting inequality unconditionally -- with a list length that
  // doesn't evenly divide the days-in-year count this could theoretically
  // land on the same entry right at a wrap-around, but for adjacent days
  // that's only possible if the list has exactly 1 entry, which the
  // previous test already rules out.
  assert.notDeepEqual(a, b);
});

test("getDailyPassage cycles back to the start of the list after DAILY_PASSAGES.length days", () => {
  const first = getDailyPassage(new Date(Date.UTC(2026, 0, 1)));
  const wrapped = getDailyPassage(new Date(Date.UTC(2026, 0, 1 + DAILY_PASSAGES.length)));
  assert.deepEqual(first, wrapped);
});
