// lib/verify.js: the Receipts Mode quote verifier. All pure functions, no
// filesystem/network — tested against small hand-built fixtures matching
// gatherPassage()'s real return shape (see lib/gather.js).
import { test } from "node:test";
import assert from "node:assert/strict";

import { extractQuotedSpans, normalizeForComparison, findQuoteSource, verifyReplyQuotes } from "../lib/verify.js";

// --- extractQuotedSpans ---------------------------------------------------

test("extractQuotedSpans finds a long double-quoted span", () => {
  const text = 'Jesus says, "For God so loved the world that he gave his one and only Son."';
  const spans = extractQuotedSpans(text);
  assert.deepEqual(spans, ["For God so loved the world that he gave his one and only Son."]);
});

test("extractQuotedSpans ignores short quoted words (below the length floor)", () => {
  const text = 'The Greek word for "love" here is agape, not a quotation of the verse.';
  assert.deepEqual(extractQuotedSpans(text), []);
});

test("extractQuotedSpans finds multiple spans in order", () => {
  const text = '"In the beginning was the Word, and the Word was with God" comes before "and the Word was God, full of grace and truth."';
  const spans = extractQuotedSpans(text);
  assert.equal(spans.length, 2);
  assert.match(spans[0], /^In the beginning/);
  assert.match(spans[1], /^and the Word was God/);
});

test("extractQuotedSpans handles curly quotes the same as straight quotes", () => {
  const text = "Paul writes, “Love is patient, love is kind, it does not envy or boast.”";
  const spans = extractQuotedSpans(text);
  assert.equal(spans.length, 1);
  assert.match(spans[0], /^Love is patient/);
});

test("extractQuotedSpans returns [] for no quotes or empty input", () => {
  assert.deepEqual(extractQuotedSpans("No quotation marks in this sentence at all."), []);
  assert.deepEqual(extractQuotedSpans(""), []);
  assert.deepEqual(extractQuotedSpans(null), []);
});

// --- normalizeForComparison ------------------------------------------------

test("normalizeForComparison casefolds, drops punctuation, collapses whitespace", () => {
  assert.equal(
    normalizeForComparison('For God So Loved  the World, that He gave His only Son.'),
    "for god so loved the world that he gave his only son",
  );
});

test("normalizeForComparison treats curly and straight apostrophes/quotes the same", () => {
  const straight = normalizeForComparison("God's love");
  const curly = normalizeForComparison("God’s love");
  assert.equal(straight, curly);
});

// --- findQuoteSource / verifyReplyQuotes -----------------------------------

const FIXTURE_PASSAGES = [
  {
    reference: { usfm: "JHN.3.16" },
    translations: [
      { translation: { abbr: "BSB", name: "Berean Standard Bible" }, content: "For God so loved the world that He gave His one and only Son, that everyone who believes in Him shall not perish but have eternal life.", error: null },
      { translation: { abbr: "KJV", name: "King James Version" }, content: "For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.", error: null },
    ],
  },
  {
    reference: { usfm: "ROM.5.8" },
    translations: [
      { translation: { abbr: "BSB", name: "Berean Standard Bible" }, content: "But God proves His love for us in this: While we were still sinners, Christ died for us.", error: null },
      { translation: { abbr: "WEB", name: "World English Bible" }, content: null, error: "timeout" },
    ],
  },
];

test("findQuoteSource matches a substring of a gathered translation, case/punctuation-insensitive", () => {
  const result = findQuoteSource("for god so loved the world that he gave his one and only son", FIXTURE_PASSAGES);
  assert.deepEqual(result, { usfm: "JHN.3.16", translationAbbr: "BSB" });
});

test("findQuoteSource matches a partial quote (substring of a longer verse)", () => {
  const result = findQuoteSource("while we were still sinners, Christ died for us", FIXTURE_PASSAGES);
  assert.deepEqual(result, { usfm: "ROM.5.8", translationAbbr: "BSB" });
});

test("findQuoteSource skips a translation with a null/errored content field", () => {
  // WEB has no content for ROM.5.8 in the fixture -- shouldn't throw, and
  // shouldn't false-match against it.
  const result = findQuoteSource("some text not in any gathered translation at all", FIXTURE_PASSAGES);
  assert.equal(result, null);
});

test("findQuoteSource returns null for a quote that doesn't match anything gathered", () => {
  const result = findQuoteSource("this sentence was never fetched from any translation", FIXTURE_PASSAGES);
  assert.equal(result, null);
});

test("findQuoteSource returns null for an empty span", () => {
  assert.equal(findQuoteSource("", FIXTURE_PASSAGES), null);
});

test("verifyReplyQuotes: a reply that quotes real, gathered text verifies cleanly", () => {
  const reply = 'John 3:16 says, "For God so loved the world that He gave His one and only Son, that everyone who believes in Him shall not perish but have eternal life." That\'s the whole gospel in one verse.';
  const { quotes, allVerified } = verifyReplyQuotes(reply, FIXTURE_PASSAGES);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].verified, true);
  assert.deepEqual(quotes[0].source, { usfm: "JHN.3.16", translationAbbr: "BSB" });
  assert.equal(allVerified, true);
});

test("verifyReplyQuotes flags a quote that doesn't match the fetched text (the corrupted-quote case)", () => {
  // Deliberately corrupted: real verse text says "one and only Son", this
  // says "only begotten Son" attributed to the wrong wording for BSB/KJV
  // mixed together -- a plausible-sounding but not-actually-verbatim quote.
  const reply = 'Jesus said, "For God so loved the world that he sent His only Son to save all of humanity from their sins forever."';
  const { quotes, allVerified } = verifyReplyQuotes(reply, FIXTURE_PASSAGES);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].verified, false);
  assert.equal(quotes[0].source, null);
  assert.equal(allVerified, false);
});

test("verifyReplyQuotes with no quoted spans reports allVerified: true and an empty list", () => {
  const reply = "This passage is about God's love for humanity, expressed through the gift of his Son.";
  const { quotes, allVerified } = verifyReplyQuotes(reply, FIXTURE_PASSAGES);
  assert.deepEqual(quotes, []);
  assert.equal(allVerified, true);
});

test("verifyReplyQuotes handles a mix of one verified and one unverified quote", () => {
  const reply = '"For God so loved the world that He gave His one and only Son, that everyone who believes in Him shall not perish but have eternal life" is real, but "this quote was never fetched from any gathered translation at all" is not.';
  const { quotes, allVerified } = verifyReplyQuotes(reply, FIXTURE_PASSAGES);
  assert.equal(quotes.length, 2);
  assert.equal(quotes[0].verified, true);
  assert.equal(quotes[1].verified, false);
  assert.equal(allVerified, false);
});

test("verifyReplyQuotes with no gathered passages at all flags every quote as unverified", () => {
  const reply = '"For God so loved the world that He gave His one and only Son, that everyone who believes in Him shall not perish."';
  const { quotes, allVerified } = verifyReplyQuotes(reply, []);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].verified, false);
  assert.equal(allVerified, false);
});
