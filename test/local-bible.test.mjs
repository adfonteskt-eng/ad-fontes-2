// lib/local-bible.js: parsing, conversion, and real lookups against the
// fetched public-domain text (skipped when data/ hasn't been fetched).
import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";

import { parseUsfmRange, convertCompleteJson, lookupPassage, LOCAL_TRANSLATIONS, translationFile } from "../lib/local-bible.js";
import { dataFile } from "../scripts/fetch-data.js";

const byAbbr = (a) => LOCAL_TRANSLATIONS.find((t) => t.abbr === a);

test("parseUsfmRange handles single verses and ranges", () => {
  assert.deepEqual(parseUsfmRange("JHN.3.16"), { book: "JHN", chapter: 3, start: 16, end: 16 });
  assert.deepEqual(parseUsfmRange("1CO.13.4-7"), { book: "1CO", chapter: 13, start: 4, end: 7 });
  assert.throws(() => parseUsfmRange("John 3:16"));
  assert.throws(() => parseUsfmRange("JHN.3.18-16"));
});

test("convertCompleteJson keeps verse text and words of Jesus, drops footnote markers", () => {
  const json = { books: [{ id: "JHN", commonName: "John", chapters: [{ chapter: { number: 3, content: [
    { type: "heading", content: ["Jesus and Nicodemus"] },
    { type: "verse", number: 3, content: ["\u00b6 Jesus answered,", { text: "Truly, truly, I tell you,", wordsOfJesus: true }, { noteId: 1 }, "end."] },
  ] } }] }] };
  const out = convertCompleteJson(json, byAbbr("WEB"));
  assert.equal(out.books.JHN, "John");
  assert.equal(out.verses["JHN.3.3"], "Jesus answered, Truly, truly, I tell you, end.");
  assert.equal(Object.keys(out.verses).length, 1, "headings are not verses");
});

const haveData = await Promise.all(LOCAL_TRANSLATIONS.map((t) => access(dataFile(translationFile(t.abbr))).then(() => true, () => false)))
  .then((all) => all.every(Boolean));

test("real BSB John 3:16 matches the published text", { skip: !haveData && "run npm run fetch-data first" }, async () => {
  const r = await lookupPassage("JHN.3.16", byAbbr("BSB"));
  assert.equal(r.reference, "John 3:16");
  assert.equal(r.content, "For God so loved the world that He gave His one and only Son, that everyone who believes in Him shall not perish but have eternal life.");
});

test("every translation returns Genesis 1:1 and a joined range", { skip: !haveData && "run npm run fetch-data first" }, async () => {
  for (const t of LOCAL_TRANSLATIONS) {
    const one = await lookupPassage("GEN.1.1", t);
    assert.match(one.content, /^In the beginning/, t.abbr);
    const range = await lookupPassage("PSA.23.1-2", t);
    assert.ok(range.reference.endsWith("23:1-2"), t.abbr);
  }
});

test("a verse a translation omits is an error for that translation only", { skip: !haveData && "run npm run fetch-data first" }, async () => {
  await assert.rejects(lookupPassage("MAT.17.21", byAbbr("BSB")), /not found in BSB/);
  const kjv = await lookupPassage("MAT.17.21", byAbbr("KJV"));
  assert.match(kjv.content, /prayer and fasting/);
});
