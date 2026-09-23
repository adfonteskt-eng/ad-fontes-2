# Decisions log

Recorded as I go, per the "don't stop to ask, record reasonable calls"
instruction. Newest at the top.

## 2026-09-21 — Pacing: build Phase 2 features in priority order across
multiple turns, not all at once, in one honest pass

The incoming spec is genuinely a multi-week roadmap (13 features plus a
full Playwright visual/accessibility/security QA pass across a 9,500-line
app). Attempting to fake-complete all of it in a single response would mean
either shipping untested code or hand-waving the QA section — both worse
than doing fewer things well. Decision: work strictly in the spec's own
priority order, ship each feature with real tests and a real `docs/`
usage note before starting the next, and give a plain-text summary at each
stopping point (already instructed). This session: architecture doc (this
file) + Phase 2 Feature 1 (Receipts Mode verifier). Remaining features are
listed under "Not yet built" below with their actual blockers, not silently
dropped.

## Architecture (Phase 1 deliverable)

Minimal, additive to what exists — nothing below requires rewriting a
working module, only adding new ones and light integration points.

```
                         ┌─────────────────────────┐
                         │   public/ (UI, no build) │
                         └────────────┬────────────┘
                                      │ fetch/SSE (existing)
                         ┌────────────▼────────────┐
                         │   server.js (routing)    │
                         └────────────┬────────────┘
                                      │
                    ┌─────────────────▼──────────────────┐
                    │   lib/chat.js — orchestration loop  │
                    │   (existing: 8 tools, history mgmt) │
                    └───┬──────┬──────┬──────┬──────┬─────┘
                        │      │      │      │      │
              ┌─────────▼┐ ┌───▼───┐┌─▼────┐┌▼─────┐┌▼──────────┐
              │gather.js │ │interl-││cross-││geogra││ NEW:      │
              │(text)    │ │inear  ││refs  ││phy   ││ verify.js │
              │          │ │(lex/  ││      ││(maps)││(citations)│
              │          │ │orig-  ││      ││      ││           │
              │          │ │lang)  ││      ││      ││           │
              └────┬─────┘ └───┬───┘└──┬───┘└──┬───┘└─────┬─────┘
                   │           │       │       │          │
              ┌────▼───────────▼───────▼───────▼──────────▼────┐
              │         ttl-cache.js (existing, shared)         │
              └──────────────────────────────────────────────────┘
```

- **Provider interfaces**: already exist, one function per concern
  (`gatherPassage`, `searchLexicon`/`findStrongsOccurrences`,
  `findCrossReferences`, `resolvePlace`). New features get new files in
  this same shape (one focused module, one or two exported functions, its
  own test file) rather than growing an existing file past its own
  concern. `lib/verify.js` (below) is the first of these.
- **Citation/verification layer (NEW)**: `lib/verify.js`. Does not call any
  API itself — pure functions over data `chatTurn()` already has in hand
  (the reply text + `gatheredThisTurn`, which already holds every
  translation Claude actually fetched this turn). Two responsibilities:
  1. `extractQuotedSpans(replyText)` — find substrings Claude's reply
     presents as a direct quote (text inside `"..."`/`"..."`/`'...'`,
     length-gated so short incidental quoted words don't trigger false
     positives).
  2. `verifyQuotes(quotedSpans, gatheredPassages)` — for each span, fuzzy-
     normalize (casefold, strip punctuation, collapse whitespace) and
     check it against every translation's text actually gathered this
     turn. Returns each span tagged `verified` (matches some gathered
     translation) or `unverified` (doesn't match anything gathered this
     turn — could be a real quote from a passage Claude *didn't* call
     `gather_passage` on, a paraphrase Claude framed as a quote, or a
     genuine fabrication; the layer cannot distinguish these, and says so).
  This is a real limitation of a text-based verifier bolted onto a prose-
  generating model, not a hidden one — see "Known limitation" below.
- **Caching**: existing `lib/ttl-cache.js`, reused as-is. The verifier adds
  no new cache since it's pure computation over already-fetched data.
- **LLM orchestration**: existing `lib/chat.js`, extended (not replaced) —
  verification runs on `finalReply` after the tool loop ends, before
  returning to `server.js`, in the same place `gatheredThisTurn` is already
  assembled.
- **UI**: existing `public/app.js`, extended with a citation-chip renderer
  that reuses the same `<details>`/card visual language already used for
  `.source-passage`/`.cross-ref-diagram`/`.map-diagram` blocks, for visual
  consistency with what's already shipped.

## Known limitation of the verifier (documented per the spec's own "if
blocked, implement the closest safe version and document why" rule)

A fuzzy string-match verifier cannot tell "Claude paraphrased" from "Claude
fabricated" from "Claude quoted a real verse it didn't call gather_passage
on this turn." What it CAN do, reliably: confirm that any span Claude
*presents* as an exact quote *is* exact against the real, fetched text for
whatever passages were actually gathered this turn — which is exactly the
data integrity risk the spec is naming (a plausible-sounding but wrong
quotation). It cannot verify a quote from a passage never gathered at all.
Mitigation shipped alongside it: the system prompt already tells Claude to
call `gather_passage` for anything it's about to quote; the verifier is the
backstop for when that instruction is followed imperfectly, not a
replacement for it.

## Design decisions on specific spec items

- **Light/dark mode**: the spec asks for it; the existing site is a single
  deliberately-chosen warm "aged parchment" light palette (see
  `public/style.css`'s own `:root` comment) that went through multiple
  design-taste rounds earlier in this project's life. Building a dark
  variant is a real visual-design decision (new palette values, not a
  mechanical `prefers-color-scheme` flip), not a QA fix — flagging rather
  than guessing at colors. Not built this session.
- **Depth slider / Tradition Lens persistence**: both need a per-user
  setting. `profiles` table (Supabase) already holds paid-tier prefs
  (`is_paid`, `agent_name`) — the natural place to add `depth_level` and
  `home_tradition` columns when those features are built, following the
  existing migration pattern in `supabase/schema.sql` (additive `alter
  table ... add column if not exists`, never a destructive change).
- **Playwright for QA**: the spec explicitly asks for it; it does not
  exist in this repo today (zero devDependencies). Adding it is a real
  dependency decision on a project whose README explicitly brags about
  "nearly no npm dependencies." Decision: add it as a **devDependency only**
  (never shipped to production, doesn't affect the deployed bundle or
  Render build) when the QA phase actually starts, and say so in the
  commit message rather than adding it silently now before it's used.

## 2026-09-22 — Alphabet Mode groundwork shipped; deck/quiz still deferred

Built the word-level foundation for spec item 2: `lib/greek-morphology.js`
parses STEPBible's own TEGMC legend (real CC BY 4.0 data, fetched by
`scripts/fetch-data.js`) into plain-English explanations of Robinson-style
morphology codes (e.g. "V-AAI-3S" → "Verb Aorist Active Indicative 3rd
Singular"), and `lib/greek-alphabet.js` is a hand-authored 24-letter Greek
atlas (name/transliteration/pronunciation/beginner look-alike warnings)
with a `breakdownWord()` that splits a real surface form into its letters
and diacritics via Unicode NFD decomposition. Hand-authoring the alphabet
itself (not sourcing it from a dataset) is deliberate and different from
how this project treats Scripture text or grammar-code meanings: the
shape of the Greek alphabet is settled, non-interpretive reference
knowledge, not something with competing scholarly answers to get wrong —
see `lib/greek-alphabet.js`'s own header comment for the reasoning.

Both are wired into `lib/gather.js`'s `gatherGreek()` (new
`enrichGreekWord()`), so every Greek word `gatherPassage()` returns now
carries `morphologyExplanation` and `letterBreakdown` alongside the
existing lemma/gloss. The frontend (`public/app.js`) reveals this per
word as a native `<details>` in the interlinear table's Word cell —
click-to-expand, no JS event wiring needed, same disclosure pattern as
`.commentary-entry`. Verified live: sent a real chat message ("What does
John 3:16 mean?"), confirmed the interlinear table renders 25 real Greek
words, and confirmed clicking one (μονογενῆ) shows its real STEPBible
grammar explanation and a correct letter-by-letter breakdown including a
flagged circumflex accent.

One honest data-quality finding surfaced along the way: TEGMC.txt's own
entry for "V-PMO-3P" is malformed in the source file itself (a leftover
multi-column debug row instead of the normal four-line block), so that
one legitimate code resolves to `null` rather than a decoded explanation
— documented in `lib/greek-morphology.js`'s own comment rather than
hand-patched, consistent with this whole feature's "don't fabricate, say
what you don't have" stance.

Explicitly out of scope for this pass, same reasoning as before this was
started (see "Not yet built" below, item 2): the personal saved-word deck
(needs a new Supabase table), spaced-repetition scheduling, and Hebrew
letter/grammar coverage (Hebrew uses a different alphabet and a different
STEPBible grammar-code scheme entirely — a separate future addition, not
a gap in this one).

## 2026-09-23 — Depth slider (Everyday/Student/Scholar) shipped

Built spec item 3 following the plan already recorded above: added
`profiles.depth_level` (text, default `'everyday'`, check-constrained to
the three values) via the existing additive-migration pattern, and a
matching `DEPTH_LEVELS`/`DEFAULT_DEPTH_LEVEL`/`isValidDepthLevel` in
`lib/supabase.js` (kept there rather than in `lib/chat.js` specifically to
avoid a circular import — `lib/chat.js` already imports `getPaidProfile`
from `lib/supabase.js`). `getPaidProfile()` now also returns `depthLevel`,
normalized server-side so an invalid/legacy stored value can never reach
the system prompt.

`lib/chat.js`'s `buildSystemPrompt()` takes a `depthLevel` and picks one of
three paragraphs (`DEPTH_LEVEL_PARAGRAPHS`) instructing Claude how
technical to be; "everyday" reproduces this app's one existing voice
unchanged, so nobody who's never touched the slider sees any behavior
change. `chatTurn()` resolves the effective level as: an explicit
per-message override (validated by `server.js` before being passed
through) if present, else the signed-in user's own stored default, else
"everyday" for an anonymous request — and reports back which one actually
applied.

Frontend: a three-button segmented control (not a literal
`<input type="range">`, since there are exactly three named levels, not a
continuous scale) above the chat form, working for anonymous visitors via
localStorage and additionally persisted to `profiles.depth_level` for a
signed-in user via `PUT /api/preferences` (free — no `is_paid` gate,
unlike `agentName`/`readingPlanRemindersOptIn` in that same endpoint).
Verified live: switched to "Scholar" and asked "What does monogenes mean
in John 3:16?" — the reply engaged with the *monogenēs*-vs-*gennaō*
etymology debate, cited occurrence data by Strong's number, and referenced
Hebrews 11's disambiguating usage, a visibly different register than the
same verse's "Everyday" answer earlier in the same session. Reload-
persistence of the localStorage copy also confirmed live.

## 2026-09-23 — Tradition Lens (Settled/Common view/Debated) shipped

Resolved the open design question recorded earlier (curated fixed dataset
vs. live Claude-generated positions with named-source grounding) in favor
of the latter, for the reason already given: there's no real dataset of
"which tradition holds which position" the way there is for cross-
references or Bible geocoding, so a hand-curated fixed set would only ever
cover a handful of pre-chosen topics and go stale. Instead,
`lib/chat.js`'s new `TRADITION_LENS_PARAGRAPH` instructs Claude to
explicitly label a point "Settled," "Common view," or "Debated" when a
passage's meaning genuinely splits along denominational/confessional
lines (not just individual commentators), and — critically — to name at
least two real traditions and ground each in something real (a
confession, a catechism, a named theologian, a denomination's stated
teaching) or say plainly it doesn't have one, rather than inventing a
position. This is deliberately kept as prose Claude writes, not a
separately-parsed UI badge: consensus-level is inherently a judgment
call, not a checkable fact the way a quoted verse is, and forcing a
sentinel format out of free-form writing risks silent parsing failures or
constraining Claude's voice for no real benefit — inconsistent with this
app's existing "write like you're talking" design principle.

Added `profiles.home_tradition` (nullable, no universal default — unlike
depth level, "prefer not to say" is a common, legitimate answer here) via
the same additive-migration + check-constraint pattern as depth_level,
plus `HOME_TRADITIONS`/`isValidHomeTradition`/`setHomeTradition` in
`lib/supabase.js`, and a `homeTradition` field on `getPaidProfile()`. When
set, `buildSystemPrompt()` adds one line asking Claude to note where the
user's own tradition stands on a Debated point specifically (without
implying it's the one correct answer) — same real-source discipline as
any other named tradition. Free for every signed-in user, no `is_paid`
gate. Frontend: a `<select>` in the account menu (auto-saves on change,
no separate Save button needed the way agentName's text field has one) —
placed there rather than as a per-message control like the depth slider,
since a home tradition is a one-time identity setting, not something
toggled per question.

Verified live (anonymous — see the note below on why signed-in wasn't):
asked "Do all Christian traditions agree on what happens in communion /
the Lord's Supper?" and got back an explicit "**Debated** is the right
label here... not just individual commentators differing," followed by
four real positions each grounded correctly — Catholic transubstantiation
(Fourth Lateran Council 1215, Trent Session XIII), Lutheran sacramental
union (Augsburg Confession Article X, the Marburg Colloquy), Reformed
real spiritual presence (Calvin's Institutes 4.17, Westminster Confession
29.7), and Zwinglian memorialism — plus a correct tie-back to which of
the actually-gathered commentaries (Gill, Matthew Henry, JFB) leaned
which direction. Did not attempt to live-verify the signed-in
persistence path (the account menu's select, PUT /api/preferences) end to
end: doing so would require signing up a real test account, and account
creation is outside what I'll do unattended (see this project's own
safety rules on prohibited actions). That path is covered instead by
`test/supabase.test.mjs`'s `setHomeTradition`/`getPaidProfile` tests and
`test/chat.test.mjs`'s stubbed-Supabase system-prompt tests, both of
which exercise the real PostgREST request/response contract, not just
this module's own internals.

## 2026-09-23 — Passage Briefing card shipped

Added `generate_passage_briefing`, a new base tool (always available, not
paid-gated) alongside `gather_passage`/`find_cross_references`/
`generate_map`. It's structurally different from every other tool in
`lib/chat.js`: there's no dataset behind genre/traditional-author/
approximate-date/book-structure the way there is for cross-references or
geocoding, so this tool does no server-side lookup at all — it exists
purely to force Claude's own background knowledge into a fixed, renderable
shape instead of leaving it as prose. `runPassageBriefingTool()` validates
the required fields (reference, genre, traditionalAuthor, approximateDate,
structureNote — `setting` is optional) and caps each field's length, then
attaches a `disclosure` string ("General background from the model's own
knowledge, not verified against a dataset") that `lib/chat.js`'s JSDoc and
the frontend both carry through explicitly — same "don't let structure
impersonate verified fact" reasoning as Tradition Lens. A genuinely
geographic setting is left to the separate, real `generate_map` tool
rather than duplicated here.

Frontend: a `.passage-briefing` card (reusing the existing `.source-passage`
chrome) with labeled rows and the disclosure rendered as a visually
distinct dashed-border note, not buried in a footnote. Wired through
`chatTurn()`'s return value, the persisted conversation `render_log`
(opaque JSON, so no `lib/supabase.js` changes needed), and both the live
and restored-from-localStorage render paths, the same way `crossReferences`/
`maps` already were.

Verified live: asked "I've never read the book of James before... give me
an overview" and got a real card — genre ("Wisdom literature / General
epistle"), authorship correctly noting the minority critical-scholarship
challenge to traditional attribution, a dated range with the traditional/
critical split spelled out, and a structure summary citing real chapter
divisions — plus the disclosure line rendered distinctly underneath.
Confirmed it survives a reload via the localStorage restore path, and
that the base tool count text (now seven/nine instead of six/eight)
updated consistently everywhere it's referenced.

## 2026-09-23 — Word-Study Web shipped

Resolved the open blocker recorded earlier (sense-clustering is an
interpretive judgment call with no dataset backing it) the same way as
Tradition Lens and the Passage Briefing card: split the feature into a
fully-grounded part and an optional, validated, disclosed part, rather
than picking one extreme (skip clustering entirely, or let Claude invent
it unchecked).

Grounded part: `lib/interlinear.js`'s `findStrongsOccurrences()` now also
returns `byBook` — a real per-book frequency tally computed from every
occurrence (not just the capped subset returned to Claude), sorted in
canonical Bible order via the existing `bookOrder()`/`bookName()` helpers
in `lib/bible-books.js`. This needed no new tool — `find_occurrences`
already scans the full tagged text; the tally was sitting right there
before the result got capped to `limit`.

Interpretive part: a new tool, `label_word_senses`, lets Claude group an
already-returned word study's occurrences into named senses. What keeps
this honest isn't the labels (unverifiable — Claude's own reading) but
the membership: `runLabelWordSensesTool()` rejects the *entire* call
outright, with no partial acceptance, if any referenced verse wasn't
actually among that Strong's number's real `find_occurrences` result this
turn (tracked in `chatTurn()`'s new `wordStudiesThisTurn` Map, threaded
into `runTool()` as read-only validation context — the loop itself does
the actual mutation, keeping the tool functions otherwise pure). A
fabricated or mistyped reference can't sneak into the chart; Claude gets
a clear, correctable error instead. `label_word_senses` is explicitly
optional in its own tool description — not every word needs distinct
senses called out.

Frontend: a `.word-study-web` card with a real horizontal bar chart (plain
HTML/CSS, not SVG — a variable-length book list didn't need one) for
`byBook`, and either the sense groups (each captioned as "the model's own
reading... not something the dataset itself labels") or a plain clickable
occurrence list when no grouping was requested. Occurrence buttons reuse
the existing click-to-ask wiring (`.word-study-list-item` added to
`CLICK_TO_ASK_SELECTOR`) rather than introducing new event plumbing.

Verified live in one real conversation: asked for a word study on agapē
(G0026) — got a real 116-occurrence chart across every NT book it
appears in (1 John highest at 18, matching that letter's well-known
emphasis on love). A follow-up asking to "actually group those
occurrences into a few named senses" produced four real, coherent groups
("God's and Christ's love for people," "Love among believers," "Love as
virtue/fruit of the Spirit," "Love growing cold or absent") built only
from verses the chart had already shown, with the disclosure rendered
underneath. Confirmed both cards, including all four sense groups,
survive a reload via the localStorage restore path.

## Not yet built (spec items, honestly tracked, not silently dropped)

In spec priority order, each with why it's not done yet:

2. Alphabet Mode — letter-level groundwork (atlas + per-word grammar/letter
   breakdown) is done as of 2026-09-22, see above. Still missing: a
   tap-to-save personal deck and a spaced-repetition scheduler, both of
   which need a new Supabase table; and Hebrew coverage (different
   alphabet, different grammar-code scheme).
3. ~~Depth slider~~ — done as of 2026-09-23, see above.
4. ~~Tradition Lens~~ — done as of 2026-09-23, see above.
5. ~~Passage Briefing card~~ — done as of 2026-09-23, see above.
6. ~~Word-Study Web~~ — done as of 2026-09-23, see above.
7. Cross-Reference Constellation quote/allusion/thematic distinction — the
   openbible.info dataset has no such field; would need a second,
   separately-sourced dataset or an honest "we don't distinguish these"
   disclosure if left as-is.
8. Observe→Interpret→Apply scaffold — pure UI/prompt feature, no data
   blockers, straightforward to build next.
9. Manuscript variant "how much this matters" plain-English layer — the
   variant detection already exists in `lib/interlinear.js`; needs a
   short, curated significance note per variant type, not per-instance.
10. (Voices Through History) — effectively already shipped; not re-listed.
11. Study Trail + export — export plumbing exists (`lib/export.js`); needs
    a session-path recorder. Reel Kit needs an image-generation decision
    (canvas/SVG-to-PNG vs. an external service) not yet made.
12. Select-anywhere popover — pure frontend feature, no backend blocker.

**Built since this was first written:**
13. Sources & Licenses page (`/sources`) — done 2026-09-22. Static content,
    no data blocker; wired the same way every other standalone page is.
