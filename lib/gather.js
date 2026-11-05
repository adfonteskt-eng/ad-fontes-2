// Phase 1: gather primary-source material for a passage into one plain,
// JSON-serializable object — no printing, no formatting. index.js turns this
// into console output; lib/summarize.js (Phase 2) turns it into a summary; a
// future website/app/extension (Phase 3) can call gatherPassage() directly.

import { access } from "node:fs/promises";

import { commentaryUrl, fetchCommentaries } from "./commentary.js";
import { TTLCache } from "./ttl-cache.js";
import {
  classifyVariantSignificance,
  isNewTestament,
  isOldTestament,
  loadLexicon,
  parseReference,
  readGreekVerseWords,
  readHebrewVerseWords,
  VARIANT_SIGNIFICANCE,
} from "./interlinear.js";
import { getMorphologyIndex } from "./greek-morphology.js";
import { breakdownWord } from "./greek-alphabet.js";
import { dataFile } from "../scripts/fetch-data.js";
import { LOCAL_TRANSLATIONS, lookupPassage } from "./local-bible.js";

// On-screen translations come from local, public-domain text (see
// lib/local-bible.js for why this no longer calls the YouVersion Platform
// API). Override the set with BIBLE_IDS="BSB,KJV" in .env.
export const DEFAULT_TRANSLATIONS = LOCAL_TRANSLATIONS.map(({ id, abbr, name }) => ({ id, abbr, name }));

export function resolveTranslations() {
  const raw = process.env.BIBLE_IDS ?? process.env.BIBLE_ID;
  if (!raw) return DEFAULT_TRANSLATIONS;

  const chosen = raw
    .split(",")
    .map((id) => id.trim().toUpperCase())
    .map((id) => DEFAULT_TRANSLATIONS.find((t) => t.id === id))
    .filter(Boolean);
  // Old YouVersion numeric ids (e.g. "3034") no longer match anything;
  // fall back to the full default set rather than showing no translations.
  return chosen.length > 0 ? chosen : DEFAULT_TRANSLATIONS;
}

/**
 * Fetches every requested translation concurrently. Each result is either
 * { translation, content, apiReference, error: null } or
 * { translation, content: null, apiReference: null, error: "message" } — a
 * failed translation never aborts the others.
 */
async function gatherTranslations(reference, translationList) {
  const settled = await Promise.allSettled(
    translationList.map((translation) => lookupPassage(reference.usfm, translation)),
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

// Alphabet Mode groundwork (see docs/DECISIONS.md): attaches a plain-
// English explanation of the word's morphology code (from STEPBible's own
// TEGMC legend, via lib/greek-morphology.js) and a letter-by-letter
// breakdown of its surface form (lib/greek-alphabet.js) onto a Greek word.
// Hebrew isn't covered here — Hebrew's grammar-code scheme and alphabet
// are a separate, later addition, not this pass's scope.
// `morphologyIndex` is null when data/TEGMC.txt hasn't been fetched;
// `morphologyExplanation` is then null too rather than blocking gathering
// the interlinear text itself, which doesn't depend on it.
// Manuscript variant "how much this matters" layer (spec item 9): attaches
// a plain-English significance note (see lib/interlinear.js's
// VARIANT_SIGNIFICANCE, sourced from STEPBible's own TAGNT documentation)
// unless the word is in the plain "agreement" band — the ~94% baseline
// case with nothing to explain, so null rather than noise on every
// ordinary word.
function attachVariantSignificance(word) {
  const category = classifyVariantSignificance(word.witnesses);
  return category === "agreement" ? null : { category, ...VARIANT_SIGNIFICANCE[category] };
}

function enrichGreekWord(word, morphologyIndex) {
  return {
    ...word,
    morphologyExplanation: morphologyIndex?.get(word.morphology) ?? null,
    letterBreakdown: breakdownWord(word.surface),
    variantSignificance: attachVariantSignificance(word),
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
  const morphologyIndex = await getMorphologyIndex();

  const sourceNote = sourceRef
    ? ` (Note: this data's own versification numbers this verse ${reference.book} ${sourceRef} —` +
      ` the KJV numbers some nearby verses differently, most often by one verse.)`
    : "";

  return {
    type: "greek",
    book: reference.book,
    words: shown.map((word) => enrichGreekWord(mergeLexiconEntry(word, lexicon), morphologyIndex)),
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
        error: `No commentary found for ${reference.key}.`,
      };
    }
    return { url: result.url, entries: result.entries, error: null };
  } catch (error) {
    return { url, entries: [], error: `Could not fetch commentary: ${error.message}` };
  }
}

const SKIPPED_COMMENTARY = { url: null, entries: [], error: null, skipped: true };

const SKIPPED_ORIGINAL_LANGUAGE = {
  type: "skipped",
  book: null,
  words: [],
  variantCount: 0,
  hebrewVerseRef: null,
  missingFiles: [],
  error: null,
  source: null,
};

async function gatherPassageUncached(
  usfm,
  { appKey, includeVariants = false, includeCommentary = true, includeTranslations = true, includeOriginalLanguage = true, translations } = {},
) {
  const reference = parseReference(usfm);
  const translationList = translations ?? resolveTranslations();

  const [translationResults, originalLanguage, commentary] = await Promise.all([
    includeTranslations ? gatherTranslations(reference, translationList) : Promise.resolve([]),
    includeOriginalLanguage ? gatherOriginalLanguage(reference, { includeVariants }) : Promise.resolve(SKIPPED_ORIGINAL_LANGUAGE),
    includeCommentary ? gatherCommentary(reference) : Promise.resolve(SKIPPED_COMMENTARY),
  ]);

  return { reference, translations: translationResults, originalLanguage, commentary };
}

// --- In-memory result cache --------------------------------------------
// gatherPassageUncached() does real work every call: a full-book scan of a
// multi-MB STEPBible file, a biblehub fetch, and a local text lookup per
// translation. The same reference gets asked for repeatedly in normal use —
// a user revisiting a verse, the chat agent looking a verse up again later
// in a long conversation, several people checking John 3:16 the same day.
//
// This cache is deliberately not forever: STEPBible's original-language data
// is static for the life of the process, but translations/commentary come
// can fail transiently (a biblehub timeout, a data file not yet fetched). Caching those failures permanently would turn a blip into a
// standing bug, so entries expire after CACHE_TTL_MS and just get
// re-fetched next time instead. appKey is still accepted for
// older callers but no longer used: translations are local text now.
//
// The cache stores the in-flight promise, not just the resolved value, so
// concurrent requests for the same not-yet-cached reference (e.g. the chat
// agent calling gather_passage on a verse it's about to discuss, while the
// UI is also rendering that same verse) share one fetch instead of each
// kicking off their own redundant work.
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CACHE_MAX_ENTRIES = 200;
const gatherCache = new TTLCache({ ttlMs: CACHE_TTL_MS, maxEntries: CACHE_MAX_ENTRIES });

function cacheKey(usfm, { includeVariants, includeCommentary, includeTranslations, includeOriginalLanguage, translations }) {
  const translationKey = (translations ?? resolveTranslations()).map((t) => t.id).join(",");
  return `${usfm}|v=${includeVariants}|c=${includeCommentary}|tr=${includeTranslations}|ol=${includeOriginalLanguage}|t=${translationKey}`;
}

/**
 * Gathers everything ad-fontes knows how to gather for one reference:
 * translations, original-language interlinear, and commentary — run
 * concurrently. Nothing here prints anything; see index.js (and now
 * server.js) for that.
 *
 * includeCommentary/includeTranslations/includeOriginalLanguage each let a
 * caller skip that whole fetch entirely rather than fetching it and
 * discarding it — index.js's --no-commentary and server.js's
 * ?commentary=false use includeCommentary; lib/chat.js's gather_passage
 * tool (see its `sections` parameter) uses all three, so a narrow question
 * ("what's the Greek word here?") can gather just the one section that
 * actually answers it instead of the full bundle every time.
 *
 * Results are cached in-memory for CACHE_TTL_MS (see above) — call
 * clearGatherCache() in tests, or if you need to force a fresh fetch.
 */
export async function gatherPassage(
  usfm,
  { appKey, includeVariants = false, includeCommentary = true, includeTranslations = true, includeOriginalLanguage = true, translations } = {},
) {
  const key = cacheKey(usfm, { includeVariants, includeCommentary, includeTranslations, includeOriginalLanguage, translations });
  const cached = gatherCache.get(key);
  if (cached) return cached;

  const promise = gatherPassageUncached(usfm, { appKey, includeVariants, includeCommentary, includeTranslations, includeOriginalLanguage, translations });
  gatherCache.set(key, promise);

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
