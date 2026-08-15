// Full-text search across the whole Bible's English text — distinct from
// lib/interlinear.js's searchLexicon()/findStrongsOccurrences(): those are
// word-study tools keyed off an exact Strong's number in the tagged
// original-language data, which only works when the concept maps cleanly
// onto one underlying Greek/Hebrew word. This is a blunter, more familiar
// "which verses contain these words" search over ordinary English verse
// text — for a remembered phrase or idiom ("still small voice", "peace
// that passes understanding") that a Strong's-number search wouldn't
// surface on its own.
//
// Indexed from the Berean Standard Bible's own text (bereanbible.com/
// bsb.txt), fetched into data/bsb.txt by scripts/fetch-data.js's
// downloadBsb(). Deliberately built from that independent, directly-
// sourced copy rather than from BSB text cached out of the YouVersion
// Platform API — even though BSB is also one of the translations
// lib/gather.js fetches live from YouVersion for on-screen display. Why
// the two paths don't share a source: the YouVersion Platform Terms of Use
// (https://platform.youversion.com/terms) license "YV IP" — the API and
// Developer Tools themselves — for use *within this app*, and separately
// prohibit using YV IP to "create or provide services that replicate or
// compete with... the YouVersion Bible App." A bulk local index built by
// caching every verse pulled from that API is a plausible reading of
// exactly that — YouVersion's own Bible App has full-text search as a core
// feature, and building a persisted, complete, independently-searchable
// copy of the whole Bible from their API output looks a lot like
// replicating that, not just displaying a verse a user already asked for.
// The BSB's own text, dedicated to the public domain (CC0) and downloaded
// directly from its own distributor, sidesteps the question entirely: it
// was never YV IP to begin with, so none of the above restrictions apply
// to it. See README -> Full-text search for the fuller writeup.

import { access, readFile } from "node:fs/promises";

import { dataFile } from "../scripts/fetch-data.js";
import { BIBLE_BOOKS } from "./bible-books.js";

export const BSB_FILE = "bsb.txt";

// bsb.txt's own book names match this project's BIBLE_BOOKS names almost
// everywhere ("Genesis", "1 Corinthians", ...) -- these are the exceptions
// spotted in the header/opening rows of the real file. If a future
// download ever uses a name not covered here, parseBsbText() skips that
// line and reports it via the returned unrecognizedBookNames rather than
// either crashing the whole index or silently mis-filing verses under the
// wrong book -- see loadIndex()'s console.warn below for where that
// surfaces at runtime.
const BOOK_NAME_ALIASES = {
  "song of solomon": "SNG",
  psalm: "PSA",
  psalms: "PSA",
  revelation: "REV",
  "revelation of jesus christ": "REV",
};

const USFM_BY_NAME = new Map();
for (const book of BIBLE_BOOKS) USFM_BY_NAME.set(book.name.toLowerCase(), book.usfm);
for (const [name, usfm] of Object.entries(BOOK_NAME_ALIASES)) {
  if (!USFM_BY_NAME.has(name)) USFM_BY_NAME.set(name, usfm);
}

// "Genesis 1:1" / "1 Corinthians 13:4" / "Song of Solomon 1:1" -> book
// name, chapter, verse. The book-name group is greedy on purpose: `.*`
// consumes as much as possible before backtracking to find the trailing
// " <chapter>:<verse>", which is exactly what's needed for multi-word book
// names -- no Bible book name itself ends in "<space><digits>:<digits>",
// so there's no ambiguity for this to backtrack into.
const REF_PATTERN = /^(.*)\s(\d+):(\d+)$/;

/**
 * Parses bsb.txt's own format (a couple of header lines, then one
 * "Book Chapter:Verse<TAB>Text" line per verse) into
 * { verses, unrecognizedBookNames }. `verses` is
 * [{ usfm, book, chapter, verse, text }] in file order, which is canonical
 * Bible order (Genesis first, Revelation last). Exported standalone,
 * separate from the file-reading in loadIndex() below, so tests can cover
 * the parsing logic against a small fixture string instead of the real
 * multi-megabyte download.
 */
export function parseBsbText(raw) {
  const verses = [];
  const unrecognizedBookNames = new Set();

  for (const line of raw.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue; // header/blank/malformed line -- skip, don't throw
    const refPart = line.slice(0, tab).trim();
    const text = line.slice(tab + 1).trim();
    if (!refPart || !text) continue;

    const match = refPart.match(REF_PATTERN);
    if (!match) continue;
    const [, rawBookName, chapter, verse] = match;

    const usfm = USFM_BY_NAME.get(rawBookName.toLowerCase());
    if (!usfm) {
      unrecognizedBookNames.add(rawBookName);
      continue;
    }

    verses.push({
      usfm: `${usfm}.${chapter}.${verse}`,
      book: usfm,
      chapter: Number(chapter),
      verse: Number(verse),
      text,
    });
  }

  return { verses, unrecognizedBookNames: [...unrecognizedBookNames] };
}

// Lowercase word tokens only -- apostrophes kept (so "God's" tokenizes as
// one word, not split at the apostrophe) but surrounding punctuation
// stripped. Good enough for exact-word lookups; see searchVerses()'s own
// comment on why this is deliberately not stemmed/fuzzy.
function tokenize(text) {
  return text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

/**
 * Builds a token -> Set(verse index) inverted index from a parsed verses
 * array. Exported for direct testing alongside searchVerses().
 */
export function buildInvertedIndex(verses) {
  const index = new Map();
  verses.forEach((v, i) => {
    for (const token of new Set(tokenize(v.text))) {
      if (!index.has(token)) index.set(token, new Set());
      index.get(token).add(i);
    }
  });
  return index;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * Finds every verse containing ALL of the words in `query` (AND across
 * words; a verse either has every query word somewhere in it or it isn't a
 * match at all) — exact tokens, not stemmed or fuzzy, so "love" won't also
 * match "loved"/"loving". Deliberately simple over deliberately clever:
 * this is a keyword search, not phrase-order or relevance-ranked search —
 * results come back in canonical Bible order (Genesis -> Revelation, via
 * the verses array's own order), which reads predictably like a
 * concordance rather than a relevance score that's hard to reason about
 * without real usage data to tune it against. A genuine v2 upgrade
 * (stemming, phrase matching, ranking) is easy to layer on top of this
 * same inverted index later if it turns out to matter.
 *
 * Pure function over an already-built { verses, index } — separated from
 * searchBibleText() below (which owns loading/caching that pair from disk)
 * so this logic is testable directly against a small hand-built fixture,
 * no filesystem involved.
 */
export function searchVerses(verses, index, query, { limit = DEFAULT_LIMIT } = {}) {
  const tokens = [...new Set(tokenize(query ?? ""))];
  if (tokens.length === 0) return [];

  let matches = null;
  for (const token of tokens) {
    const set = index.get(token) ?? new Set();
    matches = matches === null ? new Set(set) : new Set([...matches].filter((i) => set.has(i)));
    if (matches.size === 0) break;
  }

  const cappedLimit = Math.max(1, Math.min(limit, MAX_LIMIT));
  return [...(matches ?? [])]
    .sort((a, b) => a - b)
    .slice(0, cappedLimit)
    .map((i) => {
      const v = verses[i];
      return { usfm: v.usfm, book: v.book, chapter: v.chapter, verse: v.verse, text: v.text };
    });
}

let cachedIndex = null; // { verses, index } once loaded — the whole Bible's worth, so load once per process

/** True once data/bsb.txt has actually been downloaded (see scripts/fetch-data.js's downloadBsb()). */
export async function isBibleTextAvailable() {
  try {
    await access(dataFile(BSB_FILE));
    return true;
  } catch {
    return false;
  }
}

async function loadIndex() {
  if (cachedIndex) return cachedIndex;

  const raw = await readFile(dataFile(BSB_FILE), "utf8");
  const { verses, unrecognizedBookNames } = parseBsbText(raw);
  if (unrecognizedBookNames.length > 0) {
    // Not fatal -- the rest of the Bible still indexes and searches fine,
    // same "skip the bad row, don't kill the whole feature" reasoning as
    // gatherPassage()'s per-translation error handling. Surfaces here
    // (server log) rather than being silently swallowed, since it signals
    // BOOK_NAME_ALIASES above needs an update.
    console.warn(
      `lib/bible-search.js: ${unrecognizedBookNames.length} unrecognized book name(s) in data/bsb.txt, skipped entirely: ${unrecognizedBookNames.join(", ")}`,
    );
  }

  cachedIndex = { verses, index: buildInvertedIndex(verses) };
  return cachedIndex;
}

/**
 * Full-text search across the whole Bible (BSB text) for verses containing
 * every word in `query` — see searchVerses() above for the matching
 * semantics. Throws a clear, catchable error (code "BSB_NOT_DOWNLOADED")
 * rather than a raw ENOENT if data/bsb.txt hasn't been fetched yet — same
 * "friendly, specific message" spirit as lib/gather.js's missing-STEPBible-
 * data handling — so a caller (lib/chat.js's tool wrapper) can turn it into
 * something Claude can explain to the user instead of a generic 500.
 */
export async function searchBibleText(query, options = {}) {
  if (!(await isBibleTextAvailable())) {
    const error = new Error("Full Bible text not downloaded on the server yet — run `npm run fetch-data`.");
    error.code = "BSB_NOT_DOWNLOADED";
    throw error;
  }
  const { verses, index } = await loadIndex();
  return searchVerses(verses, index, query, options);
}

/** Drops the cached index — for tests only (a real process loads it once and keeps it). */
export function clearBibleSearchCache() {
  cachedIndex = null;
}
