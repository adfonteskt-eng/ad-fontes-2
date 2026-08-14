// Canonical Bible book order — the order books actually appear in the
// Bible (Old Testament, then New Testament), not alphabetical. Used for the
// "previous conversations, filtered by book of the Bible" menu (see
// lib/chat.js's conversation persistence and server.js's
// GET /api/conversations?sort=book) — PostgREST has no idea what order
// "Genesis, Exodus, Leviticus..." is supposed to be in, so that sort
// happens here, in application code, against this list.
//
// USFM 3-letter book codes, matching what's used everywhere else in this
// project (see lib/daily-passage.js, lib/gather.js) — this is the standard
// USFM/Paratext book ID list.
export const BIBLE_BOOKS = [
  // Old Testament
  { usfm: "GEN", name: "Genesis" },
  { usfm: "EXO", name: "Exodus" },
  { usfm: "LEV", name: "Leviticus" },
  { usfm: "NUM", name: "Numbers" },
  { usfm: "DEU", name: "Deuteronomy" },
  { usfm: "JOS", name: "Joshua" },
  { usfm: "JDG", name: "Judges" },
  { usfm: "RUT", name: "Ruth" },
  { usfm: "1SA", name: "1 Samuel" },
  { usfm: "2SA", name: "2 Samuel" },
  { usfm: "1KI", name: "1 Kings" },
  { usfm: "2KI", name: "2 Kings" },
  { usfm: "1CH", name: "1 Chronicles" },
  { usfm: "2CH", name: "2 Chronicles" },
  { usfm: "EZR", name: "Ezra" },
  { usfm: "NEH", name: "Nehemiah" },
  { usfm: "EST", name: "Esther" },
  { usfm: "JOB", name: "Job" },
  { usfm: "PSA", name: "Psalms" },
  { usfm: "PRO", name: "Proverbs" },
  { usfm: "ECC", name: "Ecclesiastes" },
  { usfm: "SNG", name: "Song of Songs" },
  { usfm: "ISA", name: "Isaiah" },
  { usfm: "JER", name: "Jeremiah" },
  { usfm: "LAM", name: "Lamentations" },
  { usfm: "EZK", name: "Ezekiel" },
  { usfm: "DAN", name: "Daniel" },
  { usfm: "HOS", name: "Hosea" },
  { usfm: "JOL", name: "Joel" },
  { usfm: "AMO", name: "Amos" },
  { usfm: "OBA", name: "Obadiah" },
  { usfm: "JON", name: "Jonah" },
  { usfm: "MIC", name: "Micah" },
  { usfm: "NAM", name: "Nahum" },
  { usfm: "HAB", name: "Habakkuk" },
  { usfm: "ZEP", name: "Zephaniah" },
  { usfm: "HAG", name: "Haggai" },
  { usfm: "ZEC", name: "Zechariah" },
  { usfm: "MAL", name: "Malachi" },
  // New Testament
  { usfm: "MAT", name: "Matthew" },
  { usfm: "MRK", name: "Mark" },
  { usfm: "LUK", name: "Luke" },
  { usfm: "JHN", name: "John" },
  { usfm: "ACT", name: "Acts" },
  { usfm: "ROM", name: "Romans" },
  { usfm: "1CO", name: "1 Corinthians" },
  { usfm: "2CO", name: "2 Corinthians" },
  { usfm: "GAL", name: "Galatians" },
  { usfm: "EPH", name: "Ephesians" },
  { usfm: "PHP", name: "Philippians" },
  { usfm: "COL", name: "Colossians" },
  { usfm: "1TH", name: "1 Thessalonians" },
  { usfm: "2TH", name: "2 Thessalonians" },
  { usfm: "1TI", name: "1 Timothy" },
  { usfm: "2TI", name: "2 Timothy" },
  { usfm: "TIT", name: "Titus" },
  { usfm: "PHM", name: "Philemon" },
  { usfm: "HEB", name: "Hebrews" },
  { usfm: "JAS", name: "James" },
  { usfm: "1PE", name: "1 Peter" },
  { usfm: "2PE", name: "2 Peter" },
  { usfm: "1JN", name: "1 John" },
  { usfm: "2JN", name: "2 John" },
  { usfm: "3JN", name: "3 John" },
  { usfm: "JUD", name: "Jude" },
  { usfm: "REV", name: "Revelation" },
];

const ORDER_BY_USFM = new Map(BIBLE_BOOKS.map((book, index) => [book.usfm, index]));
const NAME_BY_USFM = new Map(BIBLE_BOOKS.map((book) => [book.usfm, book.name]));

/** Extracts the 3-letter USFM book code from a full reference like "JHN.3.16", or null if unrecognized. */
export function bookCodeFromReference(reference) {
  if (!reference) return null;
  const code = reference.split(".")[0]?.toUpperCase();
  return NAME_BY_USFM.has(code) ? code : null;
}

/** Display name for a USFM book code, e.g. "JHN" -> "John". Returns null for an unrecognized code. */
export function bookName(usfmCode) {
  return NAME_BY_USFM.get(usfmCode) ?? null;
}

/**
 * Canonical sort position for a USFM book code (0 = Genesis, 65 = Revelation).
 * Unrecognized/missing codes sort last, after Revelation — so conversations
 * with no identifiable book yet (a topical chat with nothing gathered)
 * appear at the end of a "by book" listing rather than breaking the sort.
 */
export function bookOrder(usfmCode) {
  return ORDER_BY_USFM.get(usfmCode) ?? BIBLE_BOOKS.length;
}
