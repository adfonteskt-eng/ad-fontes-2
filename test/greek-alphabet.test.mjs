import { test } from "node:test";
import assert from "node:assert/strict";

import { GREEK_ALPHABET, lookupLetter, breakdownWord } from "../lib/greek-alphabet.js";

test("GREEK_ALPHABET has exactly the 24 letters", () => {
  assert.equal(GREEK_ALPHABET.length, 24);
  assert.equal(GREEK_ALPHABET[0].name, "Alpha");
  assert.equal(GREEK_ALPHABET.at(-1).name, "Omega");
});

test("lookupLetter finds a letter by lowercase, uppercase, and final sigma", () => {
  assert.equal(lookupLetter("α").name, "Alpha");
  assert.equal(lookupLetter("Α").name, "Alpha");
  assert.equal(lookupLetter("σ").name, "Sigma");
  assert.equal(lookupLetter("ς").name, "Sigma");
});

test("lookupLetter returns null for a non-Greek character", () => {
  assert.equal(lookupLetter("a"), null);
  assert.equal(lookupLetter(" "), null);
});

test("breakdownWord splits a plain word with no diacritics", () => {
  const result = breakdownWord("λογος");
  assert.equal(result.length, 5);
  assert.deepEqual(result.map((l) => l.atlas.name), ["Lambda", "Omicron", "Gamma", "Omicron", "Sigma"]);
  assert.deepEqual(result.map((l) => l.char), ["λ", "ο", "γ", "ο", "ς"]);
});

test("breakdownWord distinguishes medial sigma (σ) from word-final sigma (ς)", () => {
  const medial = breakdownWord("σοφος");
  assert.equal(medial[0].char, "σ");
  assert.equal(medial[0].isFinalSigma, false);
  assert.equal(medial.at(-1).char, "ς");
  assert.equal(medial.at(-1).isFinalSigma, true);
  assert.equal(medial.at(-1).atlas.name, "Sigma");
});

test("breakdownWord attaches diacritics from a real precomposed Greek word (John 3:16's ἠγάπησεν)", () => {
  const result = breakdownWord("ἠγάπησεν");
  assert.equal(result.length, 8);

  const eta = result[0];
  assert.equal(eta.baseChar, "η");
  assert.equal(eta.atlas.name, "Eta");
  assert.ok(eta.diacritics.includes("smooth breathing (no \"h\" sound)"));

  const accentedAlpha = result[2];
  assert.equal(accentedAlpha.baseChar, "α");
  assert.equal(accentedAlpha.atlas.name, "Alpha");
  assert.ok(accentedAlpha.diacritics.includes("acute accent"));
});

test("breakdownWord returns atlas: null for a non-Greek character instead of guessing", () => {
  const result = breakdownWord("a");
  assert.equal(result.length, 1);
  assert.equal(result[0].atlas, null);
});

test("breakdownWord handles an empty or missing word", () => {
  assert.deepEqual(breakdownWord(""), []);
  assert.deepEqual(breakdownWord(undefined), []);
});
