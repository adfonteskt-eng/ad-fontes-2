// Pulls a handful of public-domain commentaries for one verse from
// biblehub.com's per-verse commentary page, which aggregates dozens of
// out-of-copyright commentaries on a single page per reference.
//
// This is the one piece of ad-fontes that scrapes HTML instead of parsing a
// downloaded data file (there's no clean, keyless bulk-commentary API), so
// it's the most likely thing to break if biblehub changes its markup. If it
// ever comes back empty, that's the first place to look.

import { fetchWithTimeout } from "./fetch-timeout.js";

// A full commentary page is a real page load (several commentaries' worth of
// HTML), so this gets more slack than the JSON-API timeouts elsewhere, but
// it still needs a ceiling so a stalled response doesn't hang gatherPassage.
const COMMENTARY_TIMEOUT_MS = 10000;

// USFM-ish 3-letter book code (matching lib/interlinear.js) -> biblehub's
// lowercase, underscore-separated book slug used in its URLs.
const BOOK_SLUGS = {
  Gen: "genesis", Exo: "exodus", Lev: "leviticus", Num: "numbers", Deu: "deuteronomy",
  Jos: "joshua", Jdg: "judges", Rut: "ruth", "1Sa": "1_samuel", "2Sa": "2_samuel",
  "1Ki": "1_kings", "2Ki": "2_kings", "1Ch": "1_chronicles", "2Ch": "2_chronicles",
  Ezr: "ezra", Neh: "nehemiah", Est: "esther", Job: "job", Psa: "psalms", Pro: "proverbs",
  Ecc: "ecclesiastes", Sng: "song_of_solomon", Isa: "isaiah", Jer: "jeremiah",
  Lam: "lamentations", Ezk: "ezekiel", Dan: "daniel", Hos: "hosea", Jol: "joel",
  Amo: "amos", Oba: "obadiah", Jon: "jonah", Mic: "micah", Nam: "nahum", Hab: "habakkuk",
  Zep: "zephaniah", Hag: "haggai", Zec: "zechariah", Mal: "malachi",
  Mat: "matthew", Mrk: "mark", Luk: "luke", Jhn: "john", Act: "acts", Rom: "romans",
  "1Co": "1_corinthians", "2Co": "2_corinthians", Gal: "galatians", Eph: "ephesians",
  Php: "philippians", Col: "colossians", "1Th": "1_thessalonians", "2Th": "2_thessalonians",
  "1Ti": "1_timothy", "2Ti": "2_timothy", Tit: "titus", Phm: "philemon", Heb: "hebrews",
  Jas: "james", "1Pe": "1_peter", "2Pe": "2_peter", "1Jn": "1_john", "2Jn": "2_john",
  "3Jn": "3_john", Jud: "jude", Rev: "revelation",
};

// The exact section-heading text biblehub prints above each commentary's
// text for a given verse. These have to be the *full* names — the "Jump to:"
// nav strip at the top of the page uses short abbreviations instead ("MHC",
// "Barnes", "JFB"...) with the full name only in a hover title, which is
// stripped out along with the rest of the HTML tags/attributes — so matching
// on the full name avoids colliding with the nav strip.
//
// Picked for full Bible (OT+NT) coverage and being genuinely different takes:
// a plain narrative one (Matthew Henry Concise), a classic evangelical one
// (JFB), a detail-oriented one (Barnes), an older exhaustive one (Gill), and
// the marginal notes of the 1599 Geneva Bible.
const COMMENTARIES = [
  { name: "Matthew Henry (Concise)", heading: "Matthew Henry's Concise Commentary" },
  { name: "Jamieson-Fausset-Brown", heading: "Jamieson-Fausset-Brown Bible Commentary" },
  { name: "Barnes' Notes", heading: "Barnes' Notes on the Bible" },
  { name: "Gill's Exposition", heading: "Gill's Exposition of the Entire Bible" },
  { name: "Geneva Study Bible", heading: "Geneva Study Bible" },
];

const MAX_CHARS = 1400;

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    // Numeric character references — biblehub quotes Hebrew/Greek inline in
    // commentary text (e.g. Barnes citing רֵאשִׁית) as &#1512; / &#x5E8;
    // rather than named entities. Decode these before named entities so a
    // literal "&" produced here can't be mistaken for the start of another
    // entity, and decode &amp; last for the same reason.
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&rsquo;|&lsquo;|&apos;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&amp;/g, "&")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function commentaryUrl(reference) {
  const slug = BOOK_SLUGS[reference.book];
  if (!slug) return null;
  return `https://biblehub.com/commentaries/${slug}/${reference.chapter}-${reference.verse}.htm`;
}

/**
 * Fetches biblehub's commentary page for one verse and slices out the
 * commentaries in COMMENTARIES by finding each one's heading text and
 * cutting to the next heading found on the page.
 *
 * Returns { url, entries }, where entries is only the commentaries actually
 * found (a commentary set doesn't necessarily cover every verse).
 */
export async function fetchCommentaries(reference) {
  const url = commentaryUrl(reference);
  if (!url) return { url: null, entries: [] };

  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; ad-fontes/1.0; +https://github.com/STEPBible/STEPBible-Data)",
        Accept: "text/html",
      },
    },
    COMMENTARY_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(
      `biblehub.com returned ${response.status} ${response.statusText}`,
    );
  }

  const text = stripHtml(await response.text());

  const hits = [];
  for (const commentary of COMMENTARIES) {
    const at = text.indexOf(commentary.heading);
    if (at !== -1) {
      hits.push({ ...commentary, at, end: at + commentary.heading.length });
    }
  }
  hits.sort((a, b) => a.at - b.at);

  const entries = hits.map((hit, i) => {
    const stop = i + 1 < hits.length ? hits[i + 1].at : text.length;
    let body = text.slice(hit.end, stop).trim();
    let truncated = false;
    if (body.length > MAX_CHARS) {
      body = body.slice(0, MAX_CHARS).trimEnd();
      truncated = true;
    }
    return { name: hit.name, body, truncated };
  });

  return { url, entries };
}
