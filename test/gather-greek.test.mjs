// Alphabet Mode groundwork (see docs/DECISIONS.md): confirms gatherPassage()
// attaches a real morphology explanation and letter breakdown onto each
// Greek word, on top of the existing lexicon gloss/lemma merge. Reads real
// local data (data/TAGNT-Mat-Jhn.txt, TBESG.txt, TEGMC.txt — already
// fetched by `npm run fetch-data`); no network involved, so fetch is
// stubbed to throw on any call to catch an accidental real request.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { gatherPassage, clearGatherCache } from "../lib/gather.js";

let realFetch;

before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`unexpected network fetch in gather-greek test: ${url}`);
  };
});

after(() => {
  globalThis.fetch = realFetch;
});

test("gatherPassage attaches morphologyExplanation and letterBreakdown to Greek words", async () => {
  clearGatherCache();
  const result = await gatherPassage("JHN.3.16", {
    translations: [],
    includeCommentary: false,
  });

  const greek = result.originalLanguage;
  assert.equal(greek.type, "greek");
  assert.equal(greek.error, null);
  assert.ok(greek.words.length > 0);

  for (const word of greek.words) {
    assert.ok("morphologyExplanation" in word);
    assert.ok(Array.isArray(word.letterBreakdown));
    assert.ok(word.letterBreakdown.length > 0);
    for (const letter of word.letterBreakdown) {
      assert.ok(typeof letter.char === "string" && letter.char.length > 0);
    }
  }

  // "ἠγάπησεν" (loved) is a real word in this verse tagged V-AAI-3S —
  // confirm its explanation is STEPBible's real one, not a guess.
  const loved = greek.words.find((w) => w.morphology === "V-AAI-3S");
  assert.ok(loved, "expected to find the V-AAI-3S tagged word in John 3:16");
  assert.equal(loved.morphologyExplanation.shortLabel, "Verb Aorist Active Indicative 3rd Singular");
  assert.equal(loved.letterBreakdown[0].atlas.name, "Eta");

  // Ordinary NA28-critical-text words (the vast majority) are the plain
  // "agreement" band -- nothing to explain, so null rather than noise.
  assert.equal(loved.variantSignificance, null);
});

test("gatherPassage attaches a real variantSignificance note to a genuine manuscript variant word (John 3:16's TR/Byzantine-only 'his')", async () => {
  clearGatherCache();
  const result = await gatherPassage("JHN.3.16", {
    translations: [],
    includeCommentary: false,
    includeVariants: true,
  });

  const greek = result.originalLanguage;
  const variant = greek.words.find((w) => w.isCriticalText === false);
  assert.ok(variant, "expected to find the non-critical-text variant word once includeVariants is true");
  assert.ok(variant.variantSignificance, "a real manuscript variant should get a real significance note, not null");
  assert.ok(["ancientDiffersFromTraditional", "traditionalOnly", "ancientOnly", "otherOnly"].includes(variant.variantSignificance.category));
  assert.equal(typeof variant.variantSignificance.note, "string");
  assert.ok(variant.variantSignificance.note.length > 0);
});

