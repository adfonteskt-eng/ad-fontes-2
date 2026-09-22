# Receipts Mode

Answers the "AI misquotes Scripture" problem directly: any text Claude's
reply presents as a direct quotation (inside double quotes) is checked
against the real, verbatim translation text `gather_passage` actually
fetched during that same turn — never against Claude's own recall of what
a verse says.

## How it works

- `lib/verify.js` — pure functions, no I/O:
  - `extractQuotedSpans(text)` finds double-quoted spans of at least 20
    characters (short quoted words like `"love"` aren't Scripture-shaped
    enough to bother checking).
  - `findQuoteSource(span, gatheredPassages)` normalizes both the quoted
    span and every gathered translation's text (casefold, strip
    punctuation, collapse whitespace) and checks for a substring match —
    substring, not equality, since a quote is very often part of a verse.
  - `verifyReplyQuotes(replyText, gatheredPassages)` ties both together:
    `{ quotes: [{ span, verified, source }], allVerified }`.
- `lib/chat.js`'s `chatTurn()` calls `verifyReplyQuotes()` once per turn,
  after the tool loop settles on a final reply, using `gatheredThisTurn`
  (the same data already surfaced to the frontend as `gathered`). Returned
  as `quoteVerification` alongside `reply`/`gathered`/etc., and persisted
  into a signed-in user's durable conversation history the same way.
- `public/app.js`'s `renderQuoteVerification()` renders nothing when there
  are no quoted spans (most replies paraphrase, not quote — a badge on
  every message would be noise). A clean pass renders a small, collapsed,
  calm confirmation. A mismatch renders open, visually flagged (the site's
  `--error` color, otherwise reserved for hard failures), naming the exact
  quoted text that didn't check out.

## What this does and does not prove

**Does**: catch a quoted span that doesn't match the real text of any
translation actually fetched this turn — the specific, documented failure
mode (a plausible-sounding but subtly wrong quotation).

**Does not**: distinguish "Claude paraphrased and I'm flagging it wrongly"
from "Claude fabricated" from "Claude quoted a real verse it never called
`gather_passage` on this turn" (so there's nothing gathered to check
against). All three currently render identically as "doesn't match." This
is a real, load-bearing limitation of a text-similarity check bolted onto
a prose-generating model, not a hidden one — see `docs/DECISIONS.md`'s
"Known limitation" section. The system prompt's existing instruction to
call `gather_passage` before quoting anything is the first line of
defense; this is the backstop for when that's followed imperfectly.

## Tests

- `test/verify.test.mjs` — 17 unit tests against hand-built fixtures
  matching `gatherPassage()`'s real return shape (extraction,
  normalization, substring matching, mixed verified/unverified replies).
- `test/chat.test.mjs` — 2 integration tests exercising the real
  `chatTurn()` path end to end (a real `gather_passage` call against a
  stubbed-but-realistic YouVersion response), one confirming a correct
  quote verifies and one confirming a corrupted quote is flagged.
- Verified live against the real dev server and a real Claude reply
  (`"Quote John 3:16 exactly..."` → real BSB text → badge renders
  correctly), and against the localStorage-restore path after a reload.
