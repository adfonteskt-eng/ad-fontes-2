// Receipts Mode: a programmatic check that any text Claude presents as a
// direct Scripture quotation in its own prose actually matches the real,
// verbatim translation text `gather_passage` fetched this turn — never
// trusting Claude's own recall of what a verse says, the same "don't
// invent it, fetch it" discipline lib/gather.js already applies to the
// data itself, extended to the model's PROSE about that data.
//
// What this deliberately does not claim to do: distinguish "Claude
// paraphrased" from "Claude fabricated" from "Claude quoted a real verse
// it never called gather_passage on this turn." A fuzzy string match can
// only confirm or fail to confirm a quoted span against text actually in
// hand — see docs/DECISIONS.md's "Known limitation" section. That's still
// a real, useful backstop: it catches the specific, documented failure
// mode (a plausible-sounding but subtly wrong quotation) without
// pretending to catch everything a determined fabrication could do.

// Matches text between any pairing of straight or curly double quotes.
// Single quotes are deliberately excluded — "God's love" would otherwise
// register as a quoted span on the apostrophe alone, and short incidental
// quoted words ("faith", 'grace') aren't what this is for. The length
// floor (20 chars) filters out short quoted words/phrases that aren't
// really Scripture-quotation-shaped, without being so high it misses a
// short but genuine verse fragment.
const QUOTE_SPAN_PATTERN = /["“”]([^"“”]{20,500})["“”]/g;
const MIN_QUOTE_LENGTH = 20;

/**
 * Finds every substring of `text` that reads as a direct quotation (inside
 * double quotes, long enough to plausibly be a Scripture excerpt rather
 * than an incidental quoted word). Returns the spans in the order they
 * appear, each trimmed. Pure function, no I/O — exported standalone for
 * testing against fixture reply text.
 */
export function extractQuotedSpans(text) {
  if (!text) return [];
  const spans = [];
  for (const match of text.matchAll(QUOTE_SPAN_PATTERN)) {
    const span = match[1].trim();
    if (span.length >= MIN_QUOTE_LENGTH) spans.push(span);
  }
  return spans;
}

/**
 * Normalizes text for a verbatim-ish comparison: casefolds, drops
 * punctuation (including curly quotes/dashes translations render
 * differently from each other), and collapses whitespace. Two renderings
 * of "the same words" — different punctuation styles, a translation using
 * a curly apostrophe where another uses straight — should compare equal;
 * genuinely different wording should not.
 */
export function normalizeForComparison(text) {
  return (text ?? "")
    .toLowerCase()
    .replace(/[.,;:!?"“”'’‘()[\]—–-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Checks one quoted span against every translation actually gathered this
 * turn, across every passage. A span "verifies" if it appears as a
 * substring of some translation's normalized text — substring, not
 * equality, since a quote is very often part of a longer verse rather than
 * the whole thing. Returns the first match found (reference + translation
 * abbreviation), or null if no gathered translation contains it.
 */
export function findQuoteSource(span, gatheredPassages) {
  const normalizedSpan = normalizeForComparison(span);
  if (!normalizedSpan) return null;

  for (const passage of gatheredPassages ?? []) {
    for (const t of passage.translations ?? []) {
      if (!t.content) continue;
      if (normalizeForComparison(t.content).includes(normalizedSpan)) {
        return { usfm: passage.reference.usfm, translationAbbr: t.translation.abbr };
      }
    }
  }
  return null;
}

/**
 * Verifies every quoted span in a reply against the passages gathered this
 * turn. Returns { quotes, allVerified }: `quotes` is one entry per quoted
 * span found (`{ span, verified, source }, source is { usfm,
 * translationAbbr } when verified or null when not); `allVerified` is
 * true when there were no unverified quotes AND at least the reply was
 * actually checked (an empty `quotes` array trivially has allVerified:
 * true — no quotes to be wrong about — which callers should treat as
 * "nothing to flag," not "confirmed accurate").
 */
export function verifyReplyQuotes(replyText, gatheredPassages) {
  const spans = extractQuotedSpans(replyText);
  const quotes = spans.map((span) => {
    const source = findQuoteSource(span, gatheredPassages);
    return { span, verified: Boolean(source), source };
  });
  return { quotes, allVerified: quotes.every((q) => q.verified) };
}
