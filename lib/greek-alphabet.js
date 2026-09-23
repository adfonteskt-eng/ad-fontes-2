// Letter-level content for Alphabet Mode (see docs/DECISIONS.md): a small,
// hand-authored atlas of the 24 Greek letters, plus a function that
// splits a real Greek surface form (as already extracted per-word by
// lib/interlinear.js's readGreekVerseWords()) into its letters and
// diacritics.
//
// Unlike lib/greek-morphology.js (which defers to STEPBible's own
// published legend because grammatical-code meaning is a real editorial
// judgment call), the shape and pronunciation of the Greek alphabet
// itself is settled, uncontroversial reference knowledge — the same kind
// of thing a printed Greek grammar's front-matter table states outright,
// not something with competing scholarly answers to get wrong. Hand-
// authoring is appropriate here the way it would not be for Scripture
// text or cross-reference judgments.

// Order matches the traditional alphabet sequence. `warning` flags a
// look-alike a beginner reading Latin script would likely misread.
export const GREEK_ALPHABET = [
  { name: "Alpha", upper: "Α", lower: "α", transliteration: "a", pronunciation: "\"ah\" as in father" },
  { name: "Beta", upper: "Β", lower: "β", transliteration: "b", pronunciation: "\"b\" as in bet" },
  { name: "Gamma", upper: "Γ", lower: "γ", transliteration: "g", pronunciation: "\"g\" as in go (before another γ, κ, ξ, or χ it nasalizes toward \"n\")" },
  { name: "Delta", upper: "Δ", lower: "δ", transliteration: "d", pronunciation: "\"d\" as in dog" },
  { name: "Epsilon", upper: "Ε", lower: "ε", transliteration: "e", pronunciation: "\"e\" as in met (short)" },
  { name: "Zeta", upper: "Ζ", lower: "ζ", transliteration: "z", pronunciation: "\"dz\" as in adze" },
  { name: "Eta", upper: "Η", lower: "η", transliteration: "ē", pronunciation: "\"ay\" as in they (long e)", warning: "Capital Η looks like Latin H, but it's a vowel, not an \"h\" sound." },
  { name: "Theta", upper: "Θ", lower: "θ", transliteration: "th", pronunciation: "\"th\" as in think" },
  { name: "Iota", upper: "Ι", lower: "ι", transliteration: "i", pronunciation: "\"ee\" as in machine", warning: "Capital Ι looks like Latin I." },
  { name: "Kappa", upper: "Κ", lower: "κ", transliteration: "k", pronunciation: "\"k\" as in kit", warning: "Capital Κ looks like Latin K." },
  { name: "Lambda", upper: "Λ", lower: "λ", transliteration: "l", pronunciation: "\"l\" as in lamp" },
  { name: "Mu", upper: "Μ", lower: "μ", transliteration: "m", pronunciation: "\"m\" as in mom", warning: "Capital Μ looks like Latin M." },
  { name: "Nu", upper: "Ν", lower: "ν", transliteration: "n", pronunciation: "\"n\" as in net", warning: "Capital Ν looks like Latin N; lowercase ν is easy to misread as a Latin v." },
  { name: "Xi", upper: "Ξ", lower: "ξ", transliteration: "x", pronunciation: "\"x\" as in box (a \"ks\" sound)" },
  { name: "Omicron", upper: "Ο", lower: "ο", transliteration: "o", pronunciation: "\"o\" as in lot (short)", warning: "Looks identical to Latin O." },
  { name: "Pi", upper: "Π", lower: "π", transliteration: "p", pronunciation: "\"p\" as in pot" },
  { name: "Rho", upper: "Ρ", lower: "ρ", transliteration: "r", pronunciation: "a lightly rolled \"r\"", warning: "Capital Ρ looks like Latin P, but it's an \"r\" sound." },
  { name: "Sigma", upper: "Σ", lower: "σ", finalLower: "ς", transliteration: "s", pronunciation: "\"s\" as in sit", warning: "Has a special final form (ς) used only at the end of a word; σ is used everywhere else." },
  { name: "Tau", upper: "Τ", lower: "τ", transliteration: "t", pronunciation: "\"t\" as in top", warning: "Capital Τ looks like Latin T." },
  { name: "Upsilon", upper: "Υ", lower: "υ", transliteration: "u/y", pronunciation: "like French \"tu\" or German \"ü\"; in the diphthongs ου (\"oo\"), αυ (\"ow\"/\"av\"), and ευ (\"eu\"/\"ev\") it takes the diphthong's sound instead", warning: "Capital Υ looks like Latin Y." },
  { name: "Phi", upper: "Φ", lower: "φ", transliteration: "ph", pronunciation: "\"f\" as in fish" },
  { name: "Chi", upper: "Χ", lower: "χ", transliteration: "ch", pronunciation: "a breathy \"kh\", like the Scottish \"loch\"", warning: "Capital Χ looks like Latin X, but it's a \"kh\" sound, not \"ks\"." },
  { name: "Psi", upper: "Ψ", lower: "ψ", transliteration: "ps", pronunciation: "\"ps\" as in oops" },
  { name: "Omega", upper: "Ω", lower: "ω", transliteration: "ō", pronunciation: "\"o\" as in note (long)" },
];

// Unicode NFD decomposes precomposed accented/breathing-marked Greek
// letters (as they appear in real tagged text, e.g. "ἠγάπησεν") into a
// bare base letter plus one or more combining marks (Unicode category
// Mn) — this is what actually lets a single lookup table above cover
// every accented form without listing each one by hand. Mark meanings
// per the standard polytonic Greek diacritic set.
const COMBINING_MARK_LABELS = {
  "́": "acute accent",
  "̀": "grave accent",
  "͂": "circumflex accent",
  "̓": "smooth breathing (no \"h\" sound)",
  "̔": "rough breathing (\"h\" sound)",
  "ͅ": "iota subscript",
  "̈": "diaeresis (pronounced as a separate syllable)",
};

function buildLetterIndex() {
  const index = new Map();
  for (const entry of GREEK_ALPHABET) {
    index.set(entry.upper, entry);
    index.set(entry.lower, entry);
    if (entry.finalLower) index.set(entry.finalLower, entry);
  }
  return index;
}

const LETTER_INDEX = buildLetterIndex();

/** Looks up a single bare Greek letter (any case/form) in the atlas, or null. */
export function lookupLetter(char) {
  return LETTER_INDEX.get(char) ?? null;
}

/**
 * Splits a real Greek surface form into its letters, each annotated with
 * its atlas entry and any diacritics carried on it. Returns
 * [{ char, baseChar, atlas, isFinalSigma, diacritics }, ...] in reading
 * order. A codepoint outside the Greek alphabet (rare, but real tagged
 * text occasionally carries punctuation) comes back with `atlas: null`
 * rather than being dropped or guessed at.
 */
export function breakdownWord(word) {
  if (!word) return [];

  const clusters = [];
  for (const ch of word.normalize("NFD")) {
    if (COMBINING_MARK_LABELS[ch] && clusters.length > 0) {
      clusters[clusters.length - 1].marks.push(ch);
    } else {
      clusters.push({ base: ch, marks: [] });
    }
  }

  return clusters.map(({ base, marks }) => {
    const atlas = lookupLetter(base);
    return {
      char: (base + marks.join("")).normalize("NFC"),
      baseChar: base,
      atlas,
      isFinalSigma: base === "ς",
      diacritics: marks.map((m) => COMBINING_MARK_LABELS[m] ?? m),
    };
  });
}
