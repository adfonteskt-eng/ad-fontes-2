// Local, public-domain Bible text for the translations shown alongside a
// gathered passage (BSB, KJV, WEB, ASV).
//
// Why local instead of the YouVersion Platform API: YouVersion's Platform
// requires non-commercial use (no ads, paywalls or subscriptions) and
// removes apps that break that rule (help.youversion.com, "How To Sign Up
// For Platform"). Ad Fontes has a paid tier, and every translation it was
// pulling from YouVersion is public domain anyway, so the same text is
// served from files fetched at build time instead (see
// scripts/fetch-data.js's downloadTranslations()). Source: AO Lab's Free
// Use Bible API (bible.helloao.org), which serves only public-domain and
// openly licensed texts and allows commercial use.
//
// Data file shape (data/bible-<ABBR>.json), written by fetch-data:
//   { abbr, name, source, books: { JHN: "John", ... }, verses: { "JHN.3.16": "For God so loved ..." } }
import { readFile, access } from "node:fs/promises";
import { dataFile } from "../scripts/fetch-data.js";

export const LOCAL_TRANSLATIONS = [
  { id: "BSB", abbr: "BSB", name: "Berean Standard Bible", sourceId: "BSB" },
  { id: "KJV", abbr: "KJV", name: "King James Version", sourceId: "eng_kjv" },
  { id: "WEB", abbr: "WEB", name: "World English Bible", sourceId: "ENGWEBP" },
  { id: "ASV", abbr: "ASV", name: "American Standard Version", sourceId: "eng_asv" },
];

export function translationFile(abbr) {
  return `bible-${abbr}.json`;
}

const loaded = new Map(); // abbr -> Promise<data>

async function loadTranslation(abbr) {
  if (!loaded.has(abbr)) {
    const promise = (async () => {
      const path = dataFile(translationFile(abbr));
      try {
        await access(path);
      } catch {
        throw new Error(`${translationFile(abbr)} is missing. Run \`npm run fetch-data\` to download it.`);
      }
      return JSON.parse(await readFile(path, "utf8"));
    })();
    // Don't cache a failure: a later fetch-data run should be picked up.
    promise.catch(() => loaded.delete(abbr));
    loaded.set(abbr, promise);
  }
  return loaded.get(abbr);
}

/**
 * Splits "JHN.3.16" or "JHN.3.16-18" into { book, chapter, start, end }.
 * Exported for tests.
 */
export function parseUsfmRange(usfm) {
  const match = /^([1-3]?[A-Z]{2,3})\.(\d+)\.(\d+)(?:-(\d+))?$/i.exec(String(usfm).trim());
  if (!match) throw new Error(`Could not parse reference "${usfm}". Expected USFM like JHN.3.16.`);
  const [, book, chapter, start, end] = match;
  const startNum = Number(start);
  const endNum = end ? Number(end) : startNum;
  if (endNum < startNum) throw new Error(`Reference "${usfm}" has a range that runs backwards.`);
  return { book: book.toUpperCase(), chapter: Number(chapter), start: startNum, end: endNum };
}

async function defaultLookup(usfm, translation) {
  const data = await loadTranslation(translation.abbr);
  const { book, chapter, start, end } = parseUsfmRange(usfm);
  const parts = [];
  for (let v = start; v <= end; v++) {
    const text = data.verses[`${book}.${chapter}.${v}`];
    if (text) parts.push(text);
  }
  if (parts.length === 0) {
    throw new Error(`${usfm} not found in ${translation.abbr}.`);
  }
  const bookName = data.books[book] ?? book;
  const reference = start === end ? `${bookName} ${chapter}:${start}` : `${bookName} ${chapter}:${start}-${end}`;
  return { content: parts.join(" "), reference };
}

let lookupImpl = defaultLookup;

/** Returns { content, reference } for one passage in one translation, or throws. */
export function lookupPassage(usfm, translation) {
  return lookupImpl(usfm, translation);
}

/** Test hook: replace the lookup (pass null to restore the real one). */
export function setPassageLookupForTests(fn) {
  lookupImpl = fn ?? defaultLookup;
}

/** Test hook: forget loaded files. */
export function clearLocalBibleCache() {
  loaded.clear();
}

/**
 * Converts one Free Use Bible API complete.json into the compact shape
 * above. Exported so scripts/fetch-data.js and tests share one parser.
 */
export function convertCompleteJson(json, translation) {
  const books = {};
  const verses = {};
  for (const book of json.books ?? []) {
    books[book.id] = book.commonName ?? book.name ?? book.id;
    for (const ch of book.chapters ?? []) {
      const chapter = ch.chapter ?? ch;
      for (const item of chapter.content ?? []) {
        if (item?.type !== "verse") continue;
        const text = (item.content ?? [])
          .map((piece) => {
            if (typeof piece === "string") return piece;
            if (piece && typeof piece.text === "string") return piece.text;
            if (piece?.lineBreak) return " ";
            return ""; // footnote markers, headings and the like
          })
          .join(" ")
          .replace(/\u00b6/g, " ") // KJV pilcrow paragraph marks
          .replace(/\s+/g, " ")
          .replace(/\s+([,.;:!?’”)])/g, "$1")
          .trim();
        if (!text) continue;
        const key = `${book.id}.${chapter.number}.${item.number}`;
        verses[key] = verses[key] ? `${verses[key]} ${text}` : text;
      }
    }
  }
  return { abbr: translation.abbr, name: translation.name, source: `https://bible.helloao.org/api/${translation.sourceId}/complete.json`, books, verses };
}
