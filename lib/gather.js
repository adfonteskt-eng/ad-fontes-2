// Phase 1: gather primary-source material for a passage into one plain,
// JSON-serializable object — no printing, no formatting. index.js turns this
// into console output; lib/summarize.js (Phase 2) turns it into a summary; a
// future website/app/extension (Phase 3) can call gatherPassage() directly.

import { access } from "node:fs/promises";

import { commentaryUrl, fetchCommentaries } from "./commentary.js";
import { fetchWithTimeout } from "./fetch-timeout.js";
import {
  isNewTestament,
  isOldTestament,
  loadLexicon,
  parseReference,
  readGreekVerseWords,
  readHebrewVerseWords,
} from "./interlinear.js";
import { dataFile } from "../scripts/fetch-data.js";

const API_BASE = "https://api.youversion.com/v1";
// YouVersion normally responds in well under a second; 8s gives real slow-
// network headroom without leaving a user's request hanging indefinitely if
// the API stalls instead of erroring.
const TRANSLATION_TIMEOUT_MS = 8000;

// Translations to pull by default, in the order they're printed. Berean
// Standard Bible is listed first since it's what this project originally
// shipped with and is confirmed to work with a fresh app key; the others are
// widely available public-domain/open translations on YouVersion's platform.
// Override with BIBLE_IDS="id1,id2,..." in .env if your app key has access
// to a different set (or just one).
export const DEFAULT_TRANSLATIONS = [
  { id: "3034", abbr: "BSB", name: "Berean Standard Bible" },
  { id: "1", abbr: "KJV", name: "King James Version" },
  { id: "206", abbr: "WEB", name: "World English Bible" },
  { id: "12", abbr: "ASV", name: "American Standard Version" },
];

export function resolveTranslations() {
  const raw = process.env.BIBLE_IDS ?? process.env.BIBLE_ID;
  if (!raw) return DEFAULT_TRANSLATIONS;

  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => {
      const known = DEFAULT_TRANSLATIONS.find((t) => t.id === id);
      return known ?? { id, abbr: id, name: `Bible ID ${id}` };
    });
}

async function fetchPassage(usfm, { appKey, bibleId }) {
  const url = `${API_BASE}/bibles/${bibleId}/passages/${usfm}`;
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        "X-YVP-App-Key": appKey,
        Accept: "application/json",
      },
    },
    TRANSLATION_TIMEOUT_MS,
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `YouVersion API returned ${response.status} ${response.statusText}\n${body}`,
    );
  }

  return response.json();
}

/**
 * Fetches every requested translation concurrently. Each result is either
 * { translation, content, apiReference, error: null } or
 * { translation, content: null, apiReference: null, error: "message" } — a
 * failed translation never aborts the others.
 */
async function gatherTranslations(reference, appKey, translationList) {
  const settled = await Promise.allSettled(
    translationList.map((translation) =>
      fetchPassage(reference.usfm, { appKey, bibleId: translation.id }),
    ),
  );

  return translationList.map((translation, i) => {
    const result = settled[i];
    if (result.status === "fulfilled") {
      return {
        translation,
        content: result.value.content,
        apiReference: result.value.reference,
        error: null,
      };
    }
    const reason = result.reason;
    return {
      translation,
      content: null,
      apiReference: null,
      error: (reason?.message ?? String(reason)).split("\n")[0],
    };
  });
}

async function missingDataFiles(names) {
  const missing = [];
  for (const name of names) {
    try {
      await access(dataFile(name));
    } catch {
      missing.push(name);
    }
  }
  return missing;
}

// Attaches the lexicon's gloss/lemma onto a word, so downstream consumers
// (console formatting, the summarizer, a future UI) get one flat object per
// word instead of having to do a second lookup.
function mergeLexiconEntry(word, lexicon) {
  const entry = lexicon.get(word.strongs);
  return {
    ...word,
    lemma: entry?.lemma ?? null,
    gloss: entry?.gloss || word.contextGloss || null,
  };
}

async function gatherGreek(reference, { includeVariants }) {
  const files = ["TAGNT-Mat-Jhn.txt", "TAGNT-Act-Rev.txt", "TBESG.txt"];
  const missingFiles = await missingDataFiles(files);
  if (missingFiles.length > 0) {
    return {
      type: "greek",
      book: reference.book,
      words: [],
      variantCount: 0,
      hebrewVerseRef: null,
      missingFiles,
      error: null,
      source: null,
    };
  }

  const { words: allWords, sourceRef } = await readGreekVerseWords(reference);
  if (allWords.length === 0) {
    // readGreekVerseWords() already resolves the ~38 known KJV/NRSV
    // bracket-versification verses directly (see the comment above
    // parseGreekRef() in lib/interlinear.js), so reaching this branch means
    // the reference genuinely isn't tagged under either numbering. This is
    // a fallback heuristic for whatever that doesn't cover — a bug in this
    // data, a typo, or a versification quirk in some other translation
    // tradition entirely: if the previous verse in the same chapter *does*
    // have tagged Greek, say so, since "verse doesn't exist" reads as a
    // bug/typo otherwise with no other clue offered.
    const prevVerseNum = Number(reference.verse) - 1;
    let notFoundNote = "";
    if (Number.isInteger(prevVerseNum) && prevVerseNum > 0) {
      const prevRef = { ...reference, verse: String(prevVerseNum), key: `${reference.book}.${reference.chapter}.${prevVerseNum}` };
      const { words: prevWords } = await readGreekVerseWords(prevRef);
      if (prevWords.length > 0) {
        notFoundNote =
          ` ${reference.book} ${reference.chapter}:${prevVerseNum} does have tagged Greek — some translations number or` +
          ` split verses right around here differently, so this may be part of that verse under this data's` +
          ` versification rather than a separate one.`;
      }
    }
    return {
      type: "greek",
      book: reference.book,
      words: [],
      variantCount: 0,
      hebrewVerseRef: null,
      missingFiles: [],
      error: `No tagged Greek found for ${reference.key}.${notFoundNote}`,
      source: null,
    };
  }

  const shown = includeVariants
    ? allWords
    : allWords.filter((word) => word.isCriticalText);

  if (shown.length === 0) {
    // Every tagged word for this verse is a TR/Byzantine-only variant, not
    // NA28 critical text — the whole disputed ending of Mark (16:9-20) and
    // John 7:53-8:11 are the well-known cases. Without this check the
    // caller just sees an empty word list with no explanation, which reads
    // as missing data rather than "this verse's content is a manuscript
    // variant, shown only with --variants."
    return {
      type: "greek",
      book: reference.book,
      words: [],
      variantCount: allWords.length,
      hebrewVerseRef: null,
      missingFiles: [],
      error:
        `${reference.key} is tagged only in the TR/Byzantine tradition, not the NA28 critical text shown by` +
        ` default (this is how the disputed ending of Mark, John 7:53–8:11, and a few similar passages are` +
        ` marked) — pass --variants (CLI) or ?variants=true (API) to see it.`,
      source: null,
    };
  }

  const lexicon = await loadLexicon(
    shown.map((word) => word.strongs),
    "TBESG.txt",
  );

  const sourceNote = sourceRef
    ? ` (Note: this data's own versification numbers this verse ${reference.book} ${sourceRef} —` +
      ` the KJV numbers some nearby verses differently, most often by one verse.)`
    : "";

  return {
    type: "greek",
    book: reference.book,
    words: shown.map((word) => mergeLexiconEntry(word, lexicon)),
    variantCount: allWords.length - shown.length,
    hebrewVerseRef: null,
    missingFiles: [],
    error: null,
    source: `STEPBible / Tyndale House Cambridge (CC BY 4.0) — NA28 critical text${sourceNote}`,
  };
}

async function gatherHebrew(reference) {
  const files = [
    "TAHOT-Gen-Deu.txt",
    "TAHOT-Jos-Est.txt",
    "TAHOT-Job-Sng.txt",
    "TAHOT-Isa-Mal.txt",
    "TBESH.txt",
  ];
  const missingFiles = await missingDataFiles(files);
  if (missingFiles.length > 0) {
    return {
      type: "hebrew",
      book: reference.book,
      words: [],
      variantCount: 0,
      hebrewVerseRef: null,
      missingFiles,
      error: null,
      source: null,
    };
  }

  const { words, hebrewVerseRef } = await readHebrewVerseWords(reference);
  if (words.length === 0) {
    return {
      type: "hebrew",
      book: reference.book,
      words: [],
      variantCount: 0,
      hebrewVerseRef: null,
      missingFiles: [],
      error: `No tagged Hebrew found for ${reference.key}.`,
      source: null,
    };
  }

  const lexicon = await loadLexicon(
    words.map((word) => word.strongs),
    "TBESH.txt",
  );

  return {
    type: "hebrew",
    book: reference.book,
    words: words.map((word) => mergeLexiconEntry(word, lexicon)),
    variantCount: 0,
    // Set when Hebrew versification differs from English for this verse —
    // most often a psalm superscription counted as part of the Hebrew verse
    // numbering, which offsets everything after it by one. e.g. "48.2" for
    // Psa.48.1, meaning what's printed here as English v.1 is Hebrew v.2.
    hebrewVerseRef,
    missingFiles: [],
    error: null,
    source: "STEPBible / Tyndale House Cambridge (CC BY 4.0) — Leningrad Codex, Qere-corrected",
  };
}

async function gatherOriginalLanguage(reference, { includeVariants }) {
  if (isNewTestament(reference.book)) {
    return gatherGreek(reference, { includeVariants });
  }
  if (isOldTestament(reference.book)) {
    return gatherHebrew(reference);
  }
  return {
    type: "unsupported",
    book: reference.book,
    words: [],
    variantCount: 0,
    hebrewVerseRef: null,
    missingFiles: [],
    error: null,
    source: null,
  };
}

async function gatherCommentary(reference) {
  const url = commentaryUrl(reference);
  if (!url) {
    return {
      url: null,
      entries: [],
      error: `No commentary source mapped for ${reference.book}.`,
    };
  }

  try {
    const result = await fetchCommentaries(reference);
    if (result.entries.length === 0) {
      return {
        url: result.url,
        entries: [],
        error: `No commentary text found for ${reference.key} at ${result.url}. The page format may have changed, or this verse just isn't covered.`,
      };
    }
    return { url: result.url, entries: result.entries, error: null };
  } catch (error) {
    return { url, entries: [], error: `Could not fetch commentary: ${error.message}` };
  }
}

const SKIPPED_COMMENTARY = { url: null, entries: [], error: null, skipped: true };

async function gatherPassageUncached(
  usfm,
  { appKey, includeVariants = false, includeCommentary = true, translations } = {},
) {
  const reference = parseReference(usfm);
  const translationList = translations ?? resolveTranslations();

  const [translationResults, originalLanguage, commentary] = await Promise.all([
    gatherTranslations(reference, appKey, translationList),
    gatherOriginalLanguage(reference, { includeVariants }),
    includeCommentary ? gatherCommentary(reference) : Promise.resolve(SKIPPED_COMMENTARY),
  ]);

  return { reference, translations: translationResults, originalLanguage, commentary };
}

// --- In-memory result cache --------------------------------------------
// gatherPassageUncached() does real work every call: a full-book scan of a
// multi-MB STEPBible file, a biblehub fetch, and one YouVersion fetch per
// translation. The same reference gets asked for repeatedly in normal use —
// a user revisiting a verse, the chat agent looking a verse up again later
// in a long conversation, several people checking John 3:16 the same day.
//
// This cache is deliberately not forever: STEPBible's original-language data
// is static for the life of the process, but translations/commentary come
// from live external APIs that can fail transiently (a timeout, a momentary
// 5xx). Caching those failures permanently would turn a blip into a
// standing bug, so entries expire after CACHE_TTL_MS and just get
// re-fetched next time instead. appKey isn't part of the cache key — this
// app only ever runs with one server-wide YVP_APP_KEY (see server.js), not
// per-request keys, so it can't affect the result.
//
// The cache stores the in-flight promise, not just the resolved value, so
// concurrent requests for the same not-yet-cached reference (e.g. the chat
// agent calling gather_passage on a verse it's about to discuss, while the
// UI is also rendering that same verse) share one fetch instead of each
// kicking off their own redundant work.
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CACHE_MAX_ENTRIES = 200;
const gatherCache = new Map(); // key -> { expiresAt, promise }

function cacheKey(usfm, { includeVariants, includeCommentary, translations }) {
  const translationKey = (translations ?? resolveTranslations()).map((t) => t.id).join(",");
  return `${usfm}|v=${includeVariants}|c=${includeCommentary}|t=${translationKey}`;
}

function pruneCache() {
  const now = Date.now();
  for (const [key, entry] of gatherCache) {
    if (entry.expiresAt <= now) gatherCache.delete(key);
  }
  // Still oversized after clearing expired entries (a burst of unique
  // references within one TTL window) — evict the oldest until back under
  // the cap. Map iterates in insertion order, so the first key is oldest.
  while (gatherCache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = gatherCache.keys().next().value;
    gatherCache.delete(oldestKey);
  }
}

/**
 * Gathers everything ad-fontes knows how to gather for one reference:
 * translations, original-language interlinear, and commentary — run
 * concurrently. Nothing here prints anything; see index.js (and now
 * server.js) for that.
 *
 * includeCommentary lets a caller skip the biblehub fetch entirely rather
 * than fetching it and discarding it — index.js's --no-commentary and
 * server.js's ?commentary=false both use this instead of just not printing
 * the result.
 *
 * Results are cached in-memory for CACHE_TTL_MS (see above) — call
 * clearGatherCache() in tests, or if you need to force a fresh fetch.
 */
export async function gatherPassage(
  usfm,
  { appKey, includeVariants = false, includeCommentary = true, translations } = {},
) {
  const key = cacheKey(usfm, { includeVariants, includeCommentary, translations });
  const cached = gatherCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }

  const promise = gatherPassageUncached(usfm, { appKey, includeVariants, includeCommentary, translations });
  gatherCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, promise });
  pruneCache();

  try {
    return await promise;
  } catch (error) {
    // Don't let a thrown error (e.g. an invalid reference) sit in the cache
    // for 15 minutes — remove it so the next call gets a clean attempt.
    gatherCache.delete(key);
    throw error;
  }
}

export function clearGatherCache() {
  gatherCache.clear();
}
