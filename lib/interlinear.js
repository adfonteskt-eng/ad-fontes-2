// Parses the STEPBible tagged Greek NT (TAGNT), tagged Hebrew OT (TAHOT), and
// the matching brief lexicons (TBESG for Greek, TBESH for Hebrew).
//
// All of these are tab-separated text with a long prose header before the
// data rows, so every parser here skips anything that doesn't look like a
// data row.

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

// TBESG and TBESH ("Translators Brief lexicon of Extended Strongs", one for
// Greek and one for Hebrew) share the same column layout.
const BRIEF_LEXICON = {
  strongs: 0, // "G0025" / "H0430G"
  lemma: 3, // "ἀγαπάω" / "אֱלֹהִים"
  transliteration: 4, // "agapaō" / "elohim"
  gloss: 6, // "to love"
};

const MAT_JHN_BOOKS = new Set(["Mat", "Mrk", "Luk", "Jhn"]);

const NT_BOOKS = new Set([
  ...MAT_JHN_BOOKS,
  "Act", "Rom", "1Co", "2Co", "Gal", "Eph", "Php", "Col", "1Th", "2Th",
  "1Ti", "2Ti", "Tit", "Phm", "Heb", "Jas", "1Pe", "2Pe", "1Jn", "2Jn",
  "3Jn", "Jud", "Rev",
]);

// TAHOT is split into four files by book range (the same split STEPBible
// ships, because a single Hebrew OT file is too big for GitHub).
const OT_FILES = [
  { file: "TAHOT-Gen-Deu.txt", books: new Set(["Gen", "Exo", "Lev", "Num", "Deu"]) },
  {
    file: "TAHOT-Jos-Est.txt",
    books: new Set([
      "Jos", "Jdg", "Rut", "1Sa", "2Sa", "1Ki", "2Ki", "1Ch", "2Ch", "Ezr", "Neh", "Est",
    ]),
  },
  { file: "TAHOT-Job-Sng.txt", books: new Set(["Job", "Psa", "Pro", "Ecc", "Sng"]) },
  {
    file: "TAHOT-Isa-Mal.txt",
    books: new Set([
      "Isa", "Jer", "Lam", "Ezk", "Dan", "Hos", "Jol", "Amo", "Oba", "Jon",
      "Mic", "Nam", "Hab", "Zep", "Hag", "Zec", "Mal",
    ]),
  },
];

// YouVersion sends "JHN.3.16"; the STEPBible files write "Jhn.3.16". Numbered
// books ("1CO", "1co", "1Co") all need to end up as "1Co" — a plain
// capitalize-first-letter breaks on these because the leading character is a
// digit, not a letter (this was silently broken for every numbered book
// before this fix: 1–3 Samuel/Kings/Chronicles, 1–2 Corinthians/Thessalonians/
// Timothy/Peter/John).
function normalizeBook(code) {
  const match = code.match(/^(\d)?([A-Za-z]+)$/);
  if (!match) return code;
  const [, digit = "", letters] = match;
  return digit + letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase();
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
    // STEPBible files write "Jhn.3.16"; the YouVersion API wants "JHN.3.16".
    key: `${book}.${chapter}.${verse}`,
    usfm: `${book.toUpperCase()}.${chapter}.${verse}`,
  };
}

export function isNewTestament(book) {
  return NT_BOOKS.has(book);
}

export function isOldTestament(book) {
  return OT_FILES.some((entry) => entry.books.has(book));
}

function tagntFileFor(book) {
  return dataFile(
    MAT_JHN_BOOKS.has(book) ? "TAGNT-Mat-Jhn.txt" : "TAGNT-Act-Rev.txt",
  );
}

function tahotFileFor(book) {
  const entry = OT_FILES.find((e) => e.books.has(book));
  return entry ? dataFile(entry.file) : null;
}

// "οὕτως (houtōs)" -> { surface, transliteration }
function splitGreek(field) {
  const match = field.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (!match) return { surface: field.trim(), transliteration: "" };
  return { surface: match[1].trim(), transliteration: match[2].trim() };
}

/**
 * Reads every tagged Greek word for one verse.
 *
 * The reference field carries a witness marker ("Jhn.3.16#11=ko"). An uppercase
 * letter means the word stands in that family's main text; lowercase means it is
 * a variant reading. "N" is the NA28/critical text, which is what modern English
 * translations follow — so words without an uppercase N are flagged as variants
 * rather than silently mixed in.
 */
export async function readGreekVerseWords(reference) {
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

// TAHOT column positions, for the per-word "data rows" (the lines that start
// with e.g. "Gen.1.1#01=L"). Each verse also has several summary lines before
// these (a word-per-line gloss, a grammar line, a variant-flag line) which
// don't match that prefix and are skipped automatically by the same
// startsWith/seenVerse scan used for Greek.
const TAHOT = {
  ref: 0, // "Gen.1.1#01=L"
  hebrew: 1, // "בְּ/רֵאשִׁ֖ית" (slash separates prefix/root/suffix)
  transliteration: 2, // "be./re.Shit"
  translation: 3, // "in/ beginning"
  dStrongs: 4, // "H9003/{H7225G}" (compound: prefix + root in braces)
  grammar: 5,
  rootStrongs: 8, // "H7225G" — the clean lookup key for the lexicon
};

// The Hebrew/translation/transliteration columns use "/" to mark where a
// prefix, root, and suffix were glued together for translation purposes
// (e.g. "the/ earth", "ha./'A.retz"). Stripping it reconstructs the plain
// reading.
function joinMorphemes(field) {
  return (field ?? "").replace(/[/\\]/g, "").trim();
}

// Pulls a lexicon-ready Strong's number out of a TAHOT row. Column 8 ("Root
// dStrong+Instance") is normally already exactly this, e.g. "H7225G" or
// "H1961_A". If it's ever blank, fall back to the last {...} group in the
// dStrongs column, which wraps the root the same way.
function extractRootStrongs(columns) {
  const direct = (columns[TAHOT.rootStrongs] ?? "").trim();
  if (direct) return direct;

  const braced = (columns[TAHOT.dStrongs] ?? "").match(/\{([GH]\d+[A-Z]?)\}/g);
  if (braced && braced.length > 0) {
    return braced[braced.length - 1].replace(/[{}]/g, "");
  }
  return "";
}

/**
 * Reads every tagged Hebrew word for one verse. Unlike the Greek data, TAHOT
 * doesn't mark critical-text vs. variant readings the same way — it records
 * manuscript variants (Qere/Ketiv, Aleppo, BHS, etc.) but each word position
 * still gets exactly one row, so there's no filtering to do.
 */
export async function readHebrewVerseWords(reference) {
  const { book, key } = reference;
  const path = tahotFileFor(book);
  if (!path) return [];

  const words = [];
  let seenVerse = false;

  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!line.startsWith(key)) {
        if (seenVerse) break;
        continue;
      }

      const columns = line.split("\t");
      const refField = columns[TAHOT.ref] ?? "";

      // Guard against "Gen.1.1" matching "Gen.1.10".
      if (refField.split("#")[0] !== key) {
        if (seenVerse) break;
        continue;
      }

      seenVerse = true;

      words.push({
        surface: joinMorphemes(columns[TAHOT.hebrew]),
        transliteration: joinMorphemes(columns[TAHOT.transliteration]),
        strongs: extractRootStrongs(columns),
        morphology: (columns[TAHOT.grammar] ?? "").trim(),
        contextGloss: joinMorphemes(columns[TAHOT.translation]),
      });
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  return words;
}

// Data rows start with a Strong's number; the file's prose header has lines
// beginning with "G" or "H" too (e.g. "Gender is F=Female..."), so require a
// digit right after the letter.
const DATA_ROW = /^[GH]\d/;

// The lexicon is keyed on plain numbers ("G3754"), but the tagged text
// sometimes carries a disambiguating letter ("G3754G") for a sense that Strong
// didn't split, or (for Hebrew) an "_A"/"_B" instance suffix for a word used
// more than once in the same verse. Those forms have no lexicon row of their
// own, so fall back to the base number rather than silently missing the entry.
function baseStrongs(strongs) {
  const match = strongs.match(/^([GH]\d+)/);
  return match ? match[1] : strongs;
}

/**
 * Looks up short definitions for a set of Strong's numbers in one pass over a
 * brief lexicon (TBESG for Greek, TBESH for Hebrew). The lexicon lists some
 * numbers more than once (G0001G, G0001H); the first entry is the primary
 * one, so later duplicates are ignored.
 *
 * Returns a Map keyed by the number as it appeared in the tagged text, so
 * callers can look up with what they already have.
 */
export async function loadLexicon(strongsNumbers, lexiconFile = "TBESG.txt") {
  // base number -> the forms the caller asked about ("G3754" -> {"G3754G"})
  const wanted = new Map();
  for (const strongs of strongsNumbers) {
    if (!strongs) continue;
    const base = baseStrongs(strongs);
    if (!wanted.has(base)) wanted.set(base, new Set());
    wanted.get(base).add(strongs);
  }

  const entries = new Map();
  if (wanted.size === 0) return entries;

  const stream = createReadStream(dataFile(lexiconFile), { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const resolved = new Set();

  try {
    for await (const line of lines) {
      if (!DATA_ROW.test(line)) continue;

      const columns = line.split("\t");
      const strongs = columns[BRIEF_LEXICON.strongs];

      if (!wanted.has(strongs) || resolved.has(strongs)) continue;
      resolved.add(strongs);

      const entry = {
        strongs,
        lemma: (columns[BRIEF_LEXICON.lemma] ?? "").trim(),
        transliteration: (columns[BRIEF_LEXICON.transliteration] ?? "").trim(),
        gloss: (columns[BRIEF_LEXICON.gloss] ?? "").trim(),
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
