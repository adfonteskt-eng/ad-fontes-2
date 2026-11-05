// Public-domain commentary for one verse, from AO Lab's Free Use Bible API
// (bible.helloao.org), a JSON API serving public-domain commentaries per
// chapter. This replaced scraping biblehub.com's HTML commentary pages
// (Nov 2026): a documented API is sturdier than slicing a web page by its
// headings, and the source's terms allow commercial use.
//
// Some commentaries are verse-by-verse (Gill, Clarke, JFB); Matthew Henry
// writes one section per passage. For a verse with no entry of its own,
// the section that contains it (the nearest earlier entry in the chapter)
// is used, and `section` says which verses that section covers.

import { fetchWithTimeout } from "./fetch-timeout.js";

const API_BASE = "https://bible.helloao.org/api/c";
const COMMENTARY_TIMEOUT_MS = 10000;
const MAX_CHARS = 1400;

// Matthew Henry, JFB and Gill carry over from the biblehub set; Clarke is
// added; Keil-Delitzsch covers the Old Testament only.
export const COMMENTARIES = [
  { id: "matthew-henry", name: "Matthew Henry" },
  { id: "jamieson-fausset-brown", name: "Jamieson-Fausset-Brown" },
  { id: "john-gill", name: "Gill's Exposition" },
  { id: "adam-clarke", name: "Adam Clarke" },
  { id: "keil-delitzsch", name: "Keil & Delitzsch", otOnly: true },
];

const OT_BOOKS = new Set(
  "GEN EXO LEV NUM DEU JOS JDG RUT 1SA 2SA 1KI 2KI 1CH 2CH EZR NEH EST JOB PSA PRO ECC SNG ISA JER LAM EZK DAN HOS JOL AMO OBA JON MIC NAM HAB ZEP HAG ZEC MAL".split(" "),
);

function usfmBook(reference) {
  return reference.book.toUpperCase();
}

/** Link for "Sources" in the UI: the chapter's Matthew Henry JSON. */
export function commentaryUrl(reference) {
  if (!reference?.book || !reference?.chapter) return null;
  return `${API_BASE}/matthew-henry/${usfmBook(reference)}/${reference.chapter}.json`;
}

// Per-chapter cache: one chapter file serves every verse in it. Capped so a
// long-running process can't grow without bound.
const chapterCache = new Map();
const CHAPTER_CACHE_MAX = 300;

async function fetchChapter(commentaryId, book, chapter) {
  const key = `${commentaryId}/${book}/${chapter}`;
  if (chapterCache.has(key)) return chapterCache.get(key);
  const promise = (async () => {
    const response = await fetchWithTimeout(`${API_BASE}/${key}.json`, { headers: { Accept: "application/json" } }, COMMENTARY_TIMEOUT_MS);
    if (response.status === 404) return null; // not covered (e.g. a book this commentary skips)
    if (!response.ok) throw new Error(`Free Use Bible API returned ${response.status} ${response.statusText}`);
    return response.json();
  })();
  promise.catch(() => chapterCache.delete(key));
  chapterCache.set(key, promise);
  if (chapterCache.size > CHAPTER_CACHE_MAX) chapterCache.delete(chapterCache.keys().next().value);
  return promise;
}

export function clearCommentaryCache() {
  chapterCache.clear();
}

function entryText(item) {
  return (item.content ?? [])
    .map((piece) => (typeof piece === "string" ? piece : piece?.text ?? ""))
    .join(" ")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Picks the entry for `verse` from one commentary chapter: the exact verse
 * if present, otherwise the nearest earlier section. Exported for tests.
 */
export function pickEntry(chapterJson, verse) {
  const entries = (chapterJson?.chapter?.content ?? [])
    .filter((item) => item?.type === "verse" && Number.isInteger(item.number))
    .sort((a, b) => a.number - b.number);
  const v = Number(verse);
  let index = -1;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].number <= v) index = i;
    else break;
  }
  if (index === -1) return null;
  const hit = entries[index];
  const body = entryText(hit);
  if (!body) return null;
  if (hit.number === v) return { body, section: null };
  const next = entries[index + 1];
  const last = next ? next.number - 1 : chapterJson?.chapter?.numberOfVerses ?? chapterJson?.numberOfVerses ?? null;
  return { body, section: last && last !== hit.number ? `verses ${hit.number}–${last}` : `from verse ${hit.number}` };
}

/**
 * Returns { url, entries } for one verse, where entries is
 * [{ name, body, truncated, section }] for the commentaries that cover it.
 * Each commentary fails independently; throws only if all of them failed
 * with errors (not merely "doesn't cover this verse").
 */
export async function fetchCommentaries(reference) {
  const book = usfmBook(reference);
  const list = COMMENTARIES.filter((c) => !c.otOnly || OT_BOOKS.has(book));
  const settled = await Promise.allSettled(list.map((c) => fetchChapter(c.id, book, reference.chapter)));

  const entries = [];
  const errors = [];
  settled.forEach((result, i) => {
    if (result.status === "rejected") {
      errors.push(result.reason?.message ?? String(result.reason));
      return;
    }
    const picked = pickEntry(result.value, reference.verse);
    if (!picked) return;
    let body = picked.body;
    let truncated = false;
    if (body.length > MAX_CHARS) {
      body = body.slice(0, MAX_CHARS).trimEnd();
      truncated = true;
    }
    entries.push({ name: list[i].name, body, truncated, section: picked.section });
  });

  if (entries.length === 0 && errors.length > 0 && errors.length === list.length) {
    throw new Error(errors[0]);
  }
  return { url: commentaryUrl(reference), entries };
}
