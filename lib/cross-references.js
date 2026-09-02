// Real, curated cross-references between passages — backs the
// find_cross_references chat tool (lib/chat.js) and the cross-reference
// diagram the frontend draws from its results (public/app.js). Deliberately
// NOT "whatever connections Claude thinks of" — those already show up in
// its prose when it notices them. This is a second, independent source: a
// licensed dataset someone else curated, so a diagram of "verses connected
// to this one" reflects real scholarly cross-referencing (chiefly the
// 19th-century Treasury of Scripture Knowledge) rather than the model's own
// possibly-mistaken recall of what connects to what.
//
// Source: openbible.info's cross-reference dataset, CC BY 4.0, ~345,000
// verse-pair connections each with a "votes" relevance score (higher =
// more commonly cross-referenced by the underlying sources). Fetched into
// data/cross-references.txt by scripts/fetch-data.js's
// downloadCrossReferences() — see that file's header comment for the
// licensing note and why it's fetched fresh rather than committed.

import { access, readFile } from "node:fs/promises";

import { dataFile } from "../scripts/fetch-data.js";
import { BIBLE_BOOKS } from "./bible-books.js";

export const CROSS_REFS_FILE = "cross-references.txt";

// openbible.info's own book abbreviations (as they appear in the file,
// e.g. "1Cor", "Song", "Ps") -> this project's USFM 3-letter codes. Built
// by inspecting every distinct abbreviation actually present in the real
// downloaded file — all 66 books are covered, so an unrecognized code in a
// future re-download would signal the file's format changed, not just a
// missed edge case.
const OPENBIBLE_ABBR_TO_USFM = {
  Gen: "GEN", Exod: "EXO", Lev: "LEV", Num: "NUM", Deut: "DEU",
  Josh: "JOS", Judg: "JDG", Ruth: "RUT", "1Sam": "1SA", "2Sam": "2SA",
  "1Kgs": "1KI", "2Kgs": "2KI", "1Chr": "1CH", "2Chr": "2CH", Ezra: "EZR",
  Neh: "NEH", Esth: "EST", Job: "JOB", Ps: "PSA", Prov: "PRO",
  Eccl: "ECC", Song: "SNG", Isa: "ISA", Jer: "JER", Lam: "LAM",
  Ezek: "EZK", Dan: "DAN", Hos: "HOS", Joel: "JOL", Amos: "AMO",
  Obad: "OBA", Jonah: "JON", Mic: "MIC", Nah: "NAM", Hab: "HAB",
  Zeph: "ZEP", Hag: "HAG", Zech: "ZEC", Mal: "MAL",
  Matt: "MAT", Mark: "MRK", Luke: "LUK", John: "JHN", Acts: "ACT",
  Rom: "ROM", "1Cor": "1CO", "2Cor": "2CO", Gal: "GAL", Eph: "EPH",
  Phil: "PHP", Col: "COL", "1Thess": "1TH", "2Thess": "2TH", "1Tim": "1TI",
  "2Tim": "2TI", Titus: "TIT", Phlm: "PHM", Heb: "HEB", Jas: "JAS",
  "1Pet": "1PE", "2Pet": "2PE", "1John": "1JN", "2John": "2JN", "3John": "3JN",
  Jude: "JUD", Rev: "REV",
};

const VALID_USFM = new Set(BIBLE_BOOKS.map((b) => b.usfm));

// "Gen.1.1" -> { usfm: "GEN.1.1", book: "GEN", chapter: 1, verse: 1 }, or
// null if the book abbreviation isn't recognized / the shape is wrong.
function parseOpenBibleRef(raw) {
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [rawBook, rawChapter, rawVerse] = parts;
  const usfmBook = OPENBIBLE_ABBR_TO_USFM[rawBook];
  if (!usfmBook || !VALID_USFM.has(usfmBook)) return null;
  const chapter = Number(rawChapter);
  const verse = Number(rawVerse);
  if (!Number.isInteger(chapter) || !Number.isInteger(verse)) return null;
  return { usfm: `${usfmBook}.${chapter}.${verse}`, book: usfmBook, chapter, verse };
}

// A "To Verse" field is either a single ref ("Gen.1.1") or a same-book
// range ("Ps.148.4-Ps.148.5") — verified against the real file that ranges
// never span books, and the "From Verse" side is never itself a range.
// Returns { start, end } (both parsed refs; end === start for a
// non-range), or null if either side fails to parse.
function parseOpenBibleToField(raw) {
  const dash = raw.indexOf("-");
  if (dash === -1) {
    const start = parseOpenBibleRef(raw);
    return start ? { start, end: start } : null;
  }
  const start = parseOpenBibleRef(raw.slice(0, dash));
  const end = parseOpenBibleRef(raw.slice(dash + 1));
  return start && end ? { start, end } : null;
}

// Compact, USFM-flavored display string for a (possibly range) reference —
// "PSA.148.4" for a single verse, "PSA.148.4-5" for a same-chapter range,
// "JHN.1.1-2.2" for a range that crosses a chapter boundary (verified this
// never crosses a book in the real data, but chapter boundaries do occur).
export function formatCrossRefRange(start, end) {
  if (start.usfm === end.usfm) return start.usfm;
  if (start.chapter === end.chapter) return `${start.usfm}-${end.verse}`;
  return `${start.usfm}-${end.chapter}.${end.verse}`;
}

/**
 * Parses openbible.info's cross-references.txt into a flat list of
 * { fromUsfm, toStart, toEnd, toDisplay, votes }. Skips the header/comment
 * line and any row either side fails to parse — reports how many were
 * skipped via `skipped` rather than either throwing or silently losing
 * rows, same "don't kill the whole feature over a few bad lines" spirit as
 * lib/bible-search.js's parseBsbText(). Exported standalone so this can be
 * tested against a small fixture string, not the real ~345,000-row file.
 */
export function parseCrossReferencesText(raw) {
  const rows = [];
  let skipped = 0;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("From Verse")) continue;

    const [fromRaw, toRaw, votesRaw] = trimmed.split("\t");
    if (!fromRaw || !toRaw || votesRaw === undefined) {
      skipped++;
      continue;
    }

    const from = parseOpenBibleRef(fromRaw);
    const to = parseOpenBibleToField(toRaw);
    const votes = Number(votesRaw);
    if (!from || !to || !Number.isFinite(votes)) {
      skipped++;
      continue;
    }

    rows.push({
      fromUsfm: from.usfm,
      toStart: to.start.usfm,
      toEnd: to.end.usfm,
      toDisplay: formatCrossRefRange(to.start, to.end),
      votes,
    });
  }

  return { rows, skipped };
}

/**
 * Builds a bidirectional index from parsed rows: a verse mentioned on
 * either side of a pair should surface the other side. openbible.info only
 * stores each pair once (in whichever direction its sources implied), so
 * looking a verse up on its "to" side needs its own reverse map, keyed by
 * the start of a "to" range — a range's later verses aren't separately
 * indexed, on the same "index the anchor, not every verse it spans"
 * reasoning as most concordance-style tools. Returns a single
 * Map<usfm, Array<{ reference, votes }>>, deduplicated so a pair that
 * happens to be listed in both directions (rare, but not guaranteed absent)
 * doesn't show up twice.
 */
export function buildCrossReferenceIndex(rows) {
  const index = new Map();

  function add(key, reference, votes) {
    if (!index.has(key)) index.set(key, new Map());
    const byReference = index.get(key);
    const existingVotes = byReference.get(reference);
    if (existingVotes === undefined || votes > existingVotes) {
      byReference.set(reference, votes);
    }
  }

  for (const row of rows) {
    add(row.fromUsfm, row.toDisplay, row.votes);
    add(row.toStart, row.fromUsfm, row.votes);
  }

  const result = new Map();
  for (const [key, byReference] of index) {
    result.set(
      key,
      [...byReference.entries()]
        .map(([reference, votes]) => ({ reference, votes }))
        .sort((a, b) => b.votes - a.votes),
    );
  }
  return result;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;

/**
 * Looks up cross-references for one verse against an already-built index —
 * pure function, separated from findCrossReferences()'s file loading/
 * caching so it's directly testable. Returns { results, totalCount }:
 * totalCount is the true match count so a well-connected verse (John 3:16
 * has dozens) is honestly reported as such rather than silently truncated
 * with no sign there's more, same convention as find_occurrences.
 */
export function lookupCrossReferences(index, usfmReference, { limit = DEFAULT_LIMIT } = {}) {
  const all = index.get(usfmReference) ?? [];
  const cappedLimit = Math.max(1, Math.min(limit, MAX_LIMIT));
  return { results: all.slice(0, cappedLimit), totalCount: all.length };
}

let cachedIndex = null; // Map<usfm, [{reference, votes}]> once loaded — whole dataset, load once per process

/** True once data/cross-references.txt has actually been downloaded (see scripts/fetch-data.js). */
export async function isCrossReferencesAvailable() {
  try {
    await access(dataFile(CROSS_REFS_FILE));
    return true;
  } catch {
    return false;
  }
}

async function loadIndex() {
  if (cachedIndex) return cachedIndex;

  const raw = await readFile(dataFile(CROSS_REFS_FILE), "utf8");
  const { rows, skipped } = parseCrossReferencesText(raw);
  if (skipped > 0) {
    console.warn(`lib/cross-references.js: skipped ${skipped} unparseable row(s) in data/cross-references.txt`);
  }

  cachedIndex = buildCrossReferenceIndex(rows);
  return cachedIndex;
}

/**
 * Cross-references for one verse (USFM-style reference, e.g. "JHN.3.16"),
 * highest-voted first. Throws a clear, catchable error (code
 * "CROSS_REFERENCES_NOT_DOWNLOADED") rather than a raw ENOENT if
 * data/cross-references.txt hasn't been fetched yet — same spirit as
 * lib/bible-search.js's searchBibleText().
 */
export async function findCrossReferences(usfmReference, options = {}) {
  if (!(await isCrossReferencesAvailable())) {
    const error = new Error("Cross-references data not downloaded on the server yet — run `npm run fetch-data`.");
    error.code = "CROSS_REFERENCES_NOT_DOWNLOADED";
    throw error;
  }
  const index = await loadIndex();
  return lookupCrossReferences(index, usfmReference, options);
}

/** Drops the cached index — for tests only (a real process loads it once and keeps it). */
export function clearCrossReferencesCache() {
  cachedIndex = null;
}
