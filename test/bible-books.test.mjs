import { test } from "node:test";
import assert from "node:assert/strict";

import { BIBLE_BOOKS, bookCodeFromReference, bookName, bookOrder } from "../lib/bible-books.js";

test("BIBLE_BOOKS has all 66 books, Genesis first and Revelation last", () => {
  assert.equal(BIBLE_BOOKS.length, 66);
  assert.equal(BIBLE_BOOKS[0].usfm, "GEN");
  assert.equal(BIBLE_BOOKS.at(-1).usfm, "REV");
});

test("BIBLE_BOOKS has no duplicate USFM codes", () => {
  const codes = BIBLE_BOOKS.map((b) => b.usfm);
  assert.equal(new Set(codes).size, codes.length);
});

test("bookCodeFromReference extracts the book code from a full USFM reference", () => {
  assert.equal(bookCodeFromReference("JHN.3.16"), "JHN");
  assert.equal(bookCodeFromReference("1CO.13.4"), "1CO");
  assert.equal(bookCodeFromReference("gen.1.1"), "GEN", "should be case-insensitive");
});

test("bookCodeFromReference returns null for missing or unrecognized input", () => {
  assert.equal(bookCodeFromReference(null), null);
  assert.equal(bookCodeFromReference(""), null);
  assert.equal(bookCodeFromReference("XYZ.1.1"), null);
});

test("bookName returns the display name for a valid code, null otherwise", () => {
  assert.equal(bookName("JHN"), "John");
  assert.equal(bookName("1CO"), "1 Corinthians");
  assert.equal(bookName("XYZ"), null);
});

test("bookOrder puts books in canonical (not alphabetical) order", () => {
  assert.ok(bookOrder("GEN") < bookOrder("EXO"), "Genesis before Exodus");
  assert.ok(bookOrder("MAL") < bookOrder("MAT"), "last OT book before first NT book");
  assert.ok(bookOrder("JHN") < bookOrder("ACT"), "John before Acts");
  // Alphabetically "Amos" < "Genesis", but canonically Genesis comes first —
  // the whole point of this module over a naive .sort().
  assert.ok(bookOrder("GEN") < bookOrder("AMO"));
});

test("bookOrder sorts an unrecognized/missing code after every real book", () => {
  assert.ok(bookOrder("XYZ") > bookOrder("REV"));
  assert.ok(bookOrder(null) > bookOrder("REV"));
});
