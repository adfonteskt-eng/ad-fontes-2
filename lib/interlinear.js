// Parses the STEPBible tagged Greek NT (TAGNT) and Greek lexicon (TBESG).
//
// Both are tab-separated text with a long prose header before the data rows,
// so every parser here skips anything that doesn't look like a data row.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { dataFile } from "../scripts/fetch-data.js";

// TAGNT column positions (verified against the file, not the docs).
const TAGNT = {
  ref: 0, // "Jhn.3.16#01=NKO"
  greek: 1, // "οὕτως (houtōs)"
  contextGloss: 2, // "Thus" — how this word is rendered here
  strongsMorph: 3, // "G3779=ADV"
};

// TBESG column positions.
const TBESG = {
  strongs: 0, // "G0025"
  lemma: 3, // "ἀγαπάω"
  transliteration: 4, // "agapaō"
  gloss: 6, // "to love"
};

const MAT_JHN_BOOKS = new Set(["Mat", "Mrk", "Luk", "Jhn"]);

const NT_BOOKS = new Set([
  ...MAT_JHN_BOOKS,
  "Act", "Rom", "1Co", "2Co", "Gal", "Eph", "Php", "Col", "1Th", "2Th",
  "1Ti", "2Ti", "Tit", "Phm", "Heb", "Jas", "1Pe", "2Pe", "1Jn", "2Jn",
  "3Jn", "Jud", "Rev",
]);

// YouVersion sends "JHN.3.16"; TAGNT writes "Jhn.3.16".
function normalizeBook(code) {
  return code.charAt(0).toUpperCase() + code.slice(1).toLowerCase();
}

export function parseReference(usfm) {
  const [rawBook, chapter, verse] = usfm.split(".");
  if (!rawBook || !chapter || !verse) {
    throw new Error(
      `Could not parse reference "${usfm}". Expected USFM like JHN.3.16.`,
    );
  }

  const book = normalizeBook(rawBook);
  return {
    book,
    chapter,
    verse,
    // TAGNT writes "Jhn.3.16"; the YouVersion API wants "JHN.3.16".
    key: `${book}.${chapter}.${verse}`,
    usfm: `${book.toUpperCase()}.${chapter}.${verse}`,
  };
}

export function isNewTestament(book) {
  return NT_BOOKS.has(book);
}

function tagntFileFor(book) {
  return dataFile(
    MAT_JHN_BOOKS.has(book) ? "TAGNT-Mat-Jhn.txt" : "TAGNT-Act-Rev.txt",
  );
}

// "οὕτως (houtōs)" -> { surface, transliteration }
function splitGreek(field) {
  const match = field.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (!match) return { surface: field.trim(), transliteration: "" };
  return { surface: match[1].trim(), transliteration: match[2].trim() };
}

/**
 * Reads every tagged word for one verse.
 *
 * The reference field carries a witness marker ("Jhn.3.16#11=ko"). An uppercase
 * letter means the word stands in that family's main text; lowercase means it is
 * a variant reading. "N" is the NA28/critical text, which is what modern English
 * translations follow — so words without an uppercase N are flagged as variants
 * rather than silently mixed in.
 */
export async function readVerseWords(reference) {
  const { book, key } = reference;
  const path = tagntFileFor(book);

  const words = [];
  let seenVerse = false;

  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!line.startsWith(key)) {
        // Rows are grouped by verse, so once we're past ours we can stop.
        if (seenVerse) break;
        continue;
      }

      const columns = line.split("\t");
      const refField = columns[TAGNT.ref] ?? "";

      // Guard against "Jhn.3.1" matching "Jhn.3.16".
      const [refPart, witnesses = ""] = refField.split("=");
      if (refPart.split("#")[0] !== key) {
        if (seenVerse) break;
        continue;
      }

      seenVerse = true;

      const [strongs = "", morphology = ""] = (
        columns[TAGNT.strongsMorph] ?? ""
      ).split("=");
      const { surface, transliteration } = splitGreek(
        columns[TAGNT.greek] ?? "",
      );

      words.push({
        surface,
        transliteration,
        strongs: strongs.trim(),
        morphology: morphology.trim(),
        contextGloss: (columns[TAGNT.contextGloss] ?? "").trim(),
        isCriticalText: witnesses.includes("N"),
        witnesses,
      });
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  return words;
}

// The lexicon is keyed on plain numbers ("G3754"), but the tagged text
// sometimes carries a disambiguating letter ("G3754G") for a sense that Strong
// didn't split. Those suffixed forms have no lexicon row of their own, so fall
// back to the base number rather than silently missing the entry.
function baseStrongs(strongs) {
  const match = strongs.match(/^([GH]\d+)/);
  return match ? match[1] : strongs;
}

// Data rows start with a Strong's number; the file's prose header has lines
// beginning with "G" too ("Gender is F=Female..."), so require a digit.
const DATA_ROW = /^[GH]\d/;

/**
 * Looks up short definitions for a set of Strong's numbers in one pass over the
 * lexicon. The lexicon lists some numbers more than once (G0001G, G0001H); the
 * first entry is the primary one, so later duplicates are ignored.
 *
 * Returns a Map keyed by the number as it appeared in the tagged text, so
 * callers can look up with what they already have.
 */
export async function loadLexicon(strongsNumbers) {
  // base number -> the forms the caller asked about ("G3754" -> {"G3754G"})
  const wanted = new Map();
  for (const strongs of strongsNumbers) {
    const base = baseStrongs(strongs);
    if (!wanted.has(base)) wanted.set(base, new Set());
    wanted.get(base).add(strongs);
  }

  const entries = new Map();
  if (wanted.size === 0) return entries;

  const stream = createReadStream(dataFile("TBESG.txt"), { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const resolved = new Set();

  try {
    for await (const line of lines) {
      if (!DATA_ROW.test(line)) continue;

      const columns = line.split("\t");
      const strongs = columns[TBESG.strongs];

      if (!wanted.has(strongs) || resolved.has(strongs)) continue;
      resolved.add(strongs);

      const entry = {
        strongs,
        lemma: (columns[TBESG.lemma] ?? "").trim(),
        transliteration: (columns[TBESG.transliteration] ?? "").trim(),
        gloss: (columns[TBESG.gloss] ?? "").trim(),
      };

      for (const form of wanted.get(strongs)) {
        entries.set(form, entry);
      }

      if (resolved.size === wanted.size) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  return entries;
}
