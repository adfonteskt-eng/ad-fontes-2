// Parses the STEPBible tagged Greek NT (TAGNT), tagged Hebrew OT (TAHOT), and
// the matching brief lexicons (TBESG for Greek, TBESH for Hebrew).
//
// All of these are tab-separated text with a long prose header before the
// data rows, so every parser here skips anything that doesn't look like a
// data row.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { dataFile } from "../scripts/fetch-data.js";
import { TTLCache } from "./ttl-cache.js";

// searchLexicon()/findStrongsOccurrences() only ever read local static
// STEPBible files — no live network involved, so unlike lib/gather.js's
// cache there's no "don't cache a transient failure forever" concern here.
// This cache exists purely for repeat-query speed: a common Strong's number
// like G2532 ("kai", and) takes a real, noticeable full-file scan (~265ms)
// every time, and the same keyword/number is a realistic thing for the chat
// agent to look up more than once — across turns in one conversation, or
// across entirely different conversations asking about the same word. A
// long TTL is fine since the underlying files never change during the
// process's lifetime; it's here mainly to bound memory over a long-running
// server, not to guard against staleness.
const LEXICON_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const LEXICON_CACHE_MAX_ENTRIES = 300;
const lexiconSearchCache = new TTLCache({ ttlMs: LEXICON_CACHE_TTL_MS, maxEntries: LEXICON_CACHE_MAX_ENTRIES });
const occurrenceCache = new TTLCache({ ttlMs: LEXICON_CACHE_TTL_MS, maxEntries: LEXICON_CACHE_MAX_ENTRIES });

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

// TAGNT has its own dual-versification marker, independent of and shaped
// differently from TAHOT's Hebrew one: "PrimaryRef[AltRef]". Per the file's
// own header ("Reference: Versification as used by NRSV. Differences are
// marked in square brackets for KJV..."), the un-bracketed ref follows NRSV
// versification (which most modern translations, including this app's
// defaults other than KJV, generally track); the bracket marks where KJV's
// numbering lands instead — e.g. "2Co.13.13[13.14]" is NRSV's 13:13, KJV's
// 13:14. Found via a real-data sweep: 38 verses across both TAGNT files,
// e.g. 2Co.13.12-13, Php.1.16-17 (a two-verse swap in both directions), and
// — unlike every other case, which stays within one chapter —
// Rev.12.18[13.1], where NRSV's last verse of chapter 12 is KJV's first
// verse of chapter 13. That cross-chapter case is why the scan below is
// bounded to the whole book rather than just one chapter: a verse-or-
// chapter-scoped fast path would miss it depending on which numbering the
// lookup used.
//
// A handful of these bracket pairs create a genuine ambiguity: e.g. both
// "2Co.13.12[13.13]" (NRSV 12, KJV 13) and "2Co.13.13[13.14]" (NRSV 13, KJV
// 14) exist, so a lookup for "13.13" could mean either "NRSV's own v.13" or
// "verse 12 under its KJV alt-number." Whenever a row's own primary ref
// directly matches what was asked, that's used and any coincidental
// alt-ref match elsewhere in the book is ignored — see the comment at the
// bottom of readGreekVerseWords() for why merging both would be wrong.
function parseGreekRef(refField) {
  const [rawRefPart, witnesses = ""] = refField.split("=");
  const refNoWordNum = rawRefPart.split("#")[0];
  const altMatch = refNoWordNum.match(/\[([^\]]*)\]/)?.[1] ?? null;
  const primaryRef = refNoWordNum.replace(/\[[^\]]*\]/, "");
  return { primaryRef, altMatch, witnesses };
}

// TAGNT interleaves a handful of non-word summary lines between each
// verse's word rows — a blank tab-separated spacer, "# Book.ch.vs",
// "#_Translation", "#_Word=Grammar", "#_Significant variant" — none of
// which start with any book prefix. A per-word data row always starts with
// "Book.chapter.verse#wordNum=...", so this distinguishes "we've hit a
// summary line, keep scanning this book" from "we've reached the next
// book's rows, stop" — the two look identical under a plain
// startsWith(bookPrefix) check, which is what made the book-wide scan
// below break after only the first verse until this was added. (See
// BIBLE_DATA_ROW further down, shared with the word-study scanners.)

/**
 * Reads every tagged Greek word for one verse. Returns { words, sourceRef },
 * where sourceRef is set only when the verse was found via its bracketed
 * KJV-numbering alt-ref rather than its primary (NRSV-style) one — i.e. the
 * requested numbering and this data's own (NRSV) numbering for this verse
 * differ. sourceRef is "chapter.verse" in the data's own numbering, for
 * surfacing to the user (see gatherGreek() in lib/gather.js).
 *
 * The reference field also carries a witness marker ("Jhn.3.16#11=ko"). An
 * uppercase letter means the word stands in that family's main text;
 * lowercase means it is a variant reading. "N" is the NA28/critical text,
 * which is what modern English translations follow — so words without an
 * uppercase N are flagged as variants rather than silently mixed in.
 */
export async function readGreekVerseWords(reference) {
  const { book, key } = reference;
  const path = tagntFileFor(book);
  const bookPrefix = `${book}.`;

  // Kept separate rather than merged as they're found: a requested key can
  // legitimately be some OTHER verse's bracketed alt-ref (e.g. looking up
  // "2Co.13.13" collides with "2Co.13.12[13.13]"'s alt) while *also* being
  // its own real primary ref elsewhere in the book ("2Co.13.13[13.14]"'s
  // primary is literally "2Co.13.13"). If both were pushed into one array,
  // the two unrelated verses' words would get silently concatenated into
  // one garbled result. A verse's own primary numbering always wins when
  // it exists; the alt-ref match is only a fallback for when it doesn't.
  const primaryWords = [];
  const altWords = [];
  let altSourceRef = null;
  let inBook = false;

  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!line.startsWith(bookPrefix)) {
        // Only a *data row* for some other book means we've actually left
        // this one — a summary line for this same book doesn't start with
        // the book prefix either, but isn't the end of the book's rows.
        if (inBook && BIBLE_DATA_ROW.test(line)) break;
        continue;
      }
      inBook = true;

      const columns = line.split("\t");
      const { primaryRef, altMatch, witnesses } = parseGreekRef(columns[TAGNT.ref] ?? "");
      const altRef = altMatch ? `${book}.${altMatch}` : null;

      const matchesPrimary = primaryRef === key;
      const matchesAlt = !matchesPrimary && altRef === key;
      if (!matchesPrimary && !matchesAlt) continue;

      const [strongs = "", morphology = ""] = (
        columns[TAGNT.strongsMorph] ?? ""
      ).split("=");
      const { surface, transliteration } = splitGreek(
        columns[TAGNT.greek] ?? "",
      );

      const word = {
        surface,
        transliteration,
        strongs: strongs.trim(),
        morphology: morphology.trim(),
        contextGloss: (columns[TAGNT.contextGloss] ?? "").trim(),
        isCriticalText: witnesses.includes("N"),
        witnesses,
      };

      if (matchesPrimary) {
        primaryWords.push(word);
      } else {
        altWords.push(word);
        if (!altSourceRef) altSourceRef = primaryRef.split(".").slice(1).join(".");
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  // Primary always wins outright over alt when both exist, rather than
  // merging: e.g. "2Co.13.12[13.13]" (NRSV 12, KJV alt 13) and
  // "2Co.13.13[13.14]" (NRSV 13, KJV alt 14) both exist, so a lookup for
  // "13.13" matches verse 12's KJV alt-ref *and* verse 13's own primary
  // ref — two unrelated NRSV verses that happen to collide on "13" for
  // unrelated reasons. Merging them would silently concatenate two
  // different verses' words into one garbled result. Preferring the direct
  // primary match is the one case that's unambiguous: this is one real
  // downside worth naming — for cases that are a genuine content *split*
  // rather than a coincidental numbering collision (Rev.12.18[13.1] is
  // NRSV's tail of ch.12 that KJV counts as the start of 13:1, sitting
  // alongside NRSV's own, separate 13:1), this returns only the direct
  // primary match and not the earlier alt-matched fragment too — a
  // deliberately conservative choice given there's no reliable way from
  // the data alone to tell "collision" from "split" apart.
  return primaryWords.length > 0
    ? { words: primaryWords, sourceRef: null }
    : { words: altWords, sourceRef: altWords.length > 0 ? altSourceRef : null };
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
//
// The braced group's inner pattern has to accept the same two suffix forms
// baseStrongs() (below) already documents handling: a disambiguating letter
// with no separator ("G3754G") and a Hebrew "_A"/"_B" instance suffix with
// an underscore ("H1961_A"). Missing the underscore form here isn't just
// cosmetic — since \{...\} requires the whole braced span to match, a brace
// like "{H1961_A}" wouldn't match at all under the old pattern, so this
// fallback would return "" instead of a usable (if imperfect) number.
function extractRootStrongs(columns) {
  const direct = (columns[TAHOT.rootStrongs] ?? "").trim();
  if (direct) return direct;

  const braced = (columns[TAHOT.dStrongs] ?? "").match(/\{([GH]\d+[A-Z]?(?:_[A-Z])?)\}/g);
  if (braced && braced.length > 0) {
    return braced[braced.length - 1].replace(/[{}]/g, "");
  }
  return "";
}

// Most refs are plain "Gen.1.1#01=L". But wherever Hebrew versification
// differs from English — most commonly a psalm with a superscription, which
// Hebrew counts as part of the verse numbering and English translations
// don't, offsetting everything after it by one — TAHOT writes the ref as
// "Psa.48.1(48.2)#01=L": English reference, then the Hebrew chapter.verse in
// parentheses. Comparing against the plain English key requires stripping
// that parenthetical first; it's captured separately so callers can surface
// "this is Hebrew 48:2" rather than just silently using the Hebrew text.
function parseRef(refField, key) {
  const rawRefPart = refField.split("#")[0];
  const hebrewAlt = rawRefPart.match(/\(([^)]*)\)/)?.[1] ?? null;
  const refPart = rawRefPart.replace(/\([^)]*\)/, "");
  return { matches: refPart === key, hebrewAlt };
}

/**
 * Reads every tagged Hebrew word for one verse. Unlike the Greek data, TAHOT
 * doesn't mark critical-text vs. variant readings the same way — it records
 * manuscript variants (Qere/Ketiv, Aleppo, BHS, etc.) but each word position
 * still gets exactly one row, so there's no filtering to do.
 *
 * Returns { words, hebrewVerseRef }, where hebrewVerseRef is null unless
 * Hebrew versification differs from English for this verse (see parseRef).
 */
export async function readHebrewVerseWords(reference) {
  const { book, key } = reference;
  const path = tahotFileFor(book);
  if (!path) return { words: [], hebrewVerseRef: null };

  const words = [];
  let seenVerse = false;
  let hebrewVerseRef = null;

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
      const { matches, hebrewAlt } = parseRef(refField, key);

      // Guard against "Gen.1.1" matching "Gen.1.10", and against a dual-
      // versification ref for a *different* verse ("Psa.48.10(48.11)")
      // sharing the "Psa.48.1" prefix used for the fast startsWith check.
      if (!matches) {
        if (seenVerse) break;
        continue;
      }

      seenVerse = true;
      if (hebrewAlt && !hebrewVerseRef) hebrewVerseRef = hebrewAlt;

      const surface = joinMorphemes(columns[TAHOT.hebrew]);

      // Qere/Ketiv variants ("Q(K)" in the ref field) are sometimes encoded
      // as two rows: an empty placeholder (no Hebrew text at all — column 1
      // is blank, column 2 is literally "[ ]") immediately followed by a
      // second Q(K) row carrying the actual reading. Found via a real-data
      // sweep across Judges, Ruth, Samuel, Kings, Chronicles, Isaiah,
      // Jeremiah, Lamentations, and Ezekiel — e.g. Jdg.16.25#02. Displaying
      // the empty one as its own "word" produced a blank cell with "[ ]" as
      // its gloss in the middle of an otherwise normal interlinear row, so
      // skip anything that resolves to no actual Hebrew text — it isn't a
      // displayable word.
      if (!surface) continue;

      words.push({
        surface,
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

  return { words, hebrewVerseRef };
}

// A per-word data row in either TAGNT or TAHOT always starts with
// "Book.chapter.verse" (optionally followed by "(alt)" or "[alt]" for the
// dual-versification cases). Every other line type in these files — prose
// header lines, the repeated column-header row, and the several summary/
// gloss lines TAGNT and TAHOT both interleave between verses ("# Book.ch.vs",
// "#_Translation", "#_Word=Grammar"/"#_Word+Grammar", "#_Significant
// variant", "#_Book.ch.vs" continuation blocks) — starts with "#", a space,
// or a tab, none of which match this. Shared by the word-study scanners
// below, which (unlike readGreekVerseWords/readHebrewVerseWords) need to
// tell data rows from non-data rows across a whole file rather than
// filtering by one target reference.
const BIBLE_DATA_ROW = /^[A-Za-z0-9]+\.\d+\.\d+/;

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

// "Jhn.3.16" (the internal file-key form) -> "JHN.3.16" (the USFM-ish form
// used everywhere else in this app — reference.usfm, YouVersion, the UI).
function toDisplayRef(key) {
  const [book, ...rest] = key.split(".");
  return [book.toUpperCase(), ...rest].join(".");
}

/**
 * Searches the brief lexicons (TBESG for Greek, TBESH for Hebrew) for
 * entries whose English gloss or transliteration contains a keyword — e.g.
 * searchLexicon("love") surfaces G0025 (agapaō), G5368 (phileō), G2065
 * (erōtaō used relationally), and any Hebrew equivalents, each with its own
 * gloss. This is what grounds a topical question ("what does Scripture say
 * about love?") in the actual lexicon data instead of the model's own
 * training-data memory of which words exist — the next step is usually
 * findStrongsOccurrences() on whichever number looks most relevant.
 *
 * Case-insensitive substring match, not fuzzy/stemmed — "faith" won't find
 * "believe". Returns { results, totalCount }; results is capped at `limit`
 * but totalCount reflects every match found, so a caller (or the model)
 * knows when a search was broad enough to truncate.
 */
export async function searchLexicon(keyword, { testament = "both", limit = 15 } = {}) {
  const term = keyword.trim().toLowerCase();
  if (!term) return { results: [], totalCount: 0 };

  const key = `${term}|${testament}|${limit}`;
  const cached = lexiconSearchCache.get(key);
  if (cached) return cached;

  const promise = searchLexiconUncached(term, { testament, limit });
  lexiconSearchCache.set(key, promise);
  try {
    return await promise;
  } catch (error) {
    lexiconSearchCache.delete(key);
    throw error;
  }
}

async function searchLexiconUncached(term, { testament, limit }) {
  const files = [];
  if (testament === "greek" || testament === "both") files.push("TBESG.txt");
  if (testament === "hebrew" || testament === "both") files.push("TBESH.txt");

  const results = [];
  for (const file of files) {
    const stream = createReadStream(dataFile(file), { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!DATA_ROW.test(line)) continue;

        const columns = line.split("\t");
        const gloss = (columns[BRIEF_LEXICON.gloss] ?? "").trim();
        const transliteration = (columns[BRIEF_LEXICON.transliteration] ?? "").trim();
        if (!gloss.toLowerCase().includes(term) && !transliteration.toLowerCase().includes(term)) {
          continue;
        }

        results.push({
          strongs: columns[BRIEF_LEXICON.strongs],
          lemma: (columns[BRIEF_LEXICON.lemma] ?? "").trim(),
          transliteration,
          gloss,
        });
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  return { results: results.slice(0, limit), totalCount: results.length };
}

// Pulls the raw Strong's number a TAGNT row is tagged with, before the
// baseStrongs() normalization — mirrors the parsing readGreekVerseWords()
// already does inline, factored out so the word-study scanner can reuse it
// without duplicating the split/trim logic.
function extractGreekStrongs(columns) {
  const [strongs = ""] = (columns[TAGNT.strongsMorph] ?? "").split("=");
  return strongs.trim();
}

async function scanGreekFileForStrongs(file, targetBase, hits) {
  const stream = createReadStream(dataFile(file), { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!BIBLE_DATA_ROW.test(line)) continue;

      const columns = line.split("\t");
      const strongs = extractGreekStrongs(columns);
      if (!strongs || baseStrongs(strongs) !== targetBase) continue;

      const { primaryRef } = parseGreekRef(columns[TAGNT.ref] ?? "");
      const { surface } = splitGreek(columns[TAGNT.greek] ?? "");
      hits.push({
        reference: toDisplayRef(primaryRef),
        surface,
        gloss: (columns[TAGNT.contextGloss] ?? "").trim(),
      });
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function scanHebrewFileForStrongs(file, targetBase, hits) {
  const stream = createReadStream(dataFile(file), { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!BIBLE_DATA_ROW.test(line)) continue;

      const columns = line.split("\t");
      const strongs = extractRootStrongs(columns);
      if (!strongs || baseStrongs(strongs) !== targetBase) continue;

      const surface = joinMorphemes(columns[TAHOT.hebrew]);
      if (!surface) continue; // Qere/Ketiv placeholder row — see readHebrewVerseWords()

      const refField = columns[TAHOT.ref] ?? "";
      const primaryRef = refField.split("#")[0].replace(/\([^)]*\)/, "");
      hits.push({
        reference: toDisplayRef(primaryRef),
        surface,
        gloss: joinMorphemes(columns[TAHOT.translation]),
      });
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/**
 * Finds every verse containing a given Strong's number — a real word study,
 * grounded in the actual tagged text rather than the model's memory of
 * where a word "probably" appears. Scans both TAGNT files for a Greek
 * number (G-prefixed) or all four TAHOT files for a Hebrew one (H-prefixed);
 * there's no index telling you in advance which book a word falls in, so a
 * lookup has to check the whole testament's data.
 *
 * Matches by base number (baseStrongs()), so "G0025" also finds "G0025G"-
 * style disambiguated senses and Hebrew "H1961_A"/"H1961_B" instance
 * variants — the same normalization loadLexicon() already relies on.
 *
 * Returns { occurrences, totalCount, error }. occurrences is capped at
 * `limit` (default 20); totalCount is the real total even when truncated,
 * so a very common word (e.g. Greek "kai", G2532, "and") is honestly
 * reported as extremely common rather than silently cut down to 20 results
 * with no indication there's more.
 */
export async function findStrongsOccurrences(strongsNumber, { limit = 20 } = {}) {
  const target = baseStrongs((strongsNumber ?? "").trim().toUpperCase());
  const key = `${target}|${limit}`;
  const cached = occurrenceCache.get(key);
  if (cached) return cached;

  const promise = findStrongsOccurrencesUncached(target, strongsNumber, limit);
  occurrenceCache.set(key, promise);
  try {
    return await promise;
  } catch (error) {
    occurrenceCache.delete(key);
    throw error;
  }
}

async function findStrongsOccurrencesUncached(target, strongsNumber, limit) {
  const isGreek = target.startsWith("G");
  const isHebrew = target.startsWith("H");

  if (!isGreek && !isHebrew) {
    return {
      occurrences: [],
      totalCount: 0,
      error: `"${strongsNumber}" doesn't look like a Strong's number (expected it to start with G or H, e.g. "G0025" or "H0157").`,
    };
  }

  const hits = [];
  if (isGreek) {
    for (const file of ["TAGNT-Mat-Jhn.txt", "TAGNT-Act-Rev.txt"]) {
      await scanGreekFileForStrongs(file, target, hits);
    }
  } else {
    for (const file of ["TAHOT-Gen-Deu.txt", "TAHOT-Jos-Est.txt", "TAHOT-Job-Sng.txt", "TAHOT-Isa-Mal.txt"]) {
      await scanHebrewFileForStrongs(file, target, hits);
    }
  }

  return { occurrences: hits.slice(0, limit), totalCount: hits.length, error: null };
}
