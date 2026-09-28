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

## 2026-09-23 — Cross-Reference Constellation's type distinction shipped
(multi-hop graph expansion still deferred)

Item 7 had two separate gaps (see docs/STATE.md): the quotation/allusion/
thematic distinction, and "isn't a full interactive graph beyond the
current focus-verse-plus-connections radial view." Only the first is
done this pass — see below for why the second is deliberately left for
later rather than rushed in alongside it.

Resolved the type-distinction blocker exactly like Word-Study Web's
sense-clustering (same shape, adapted): the CONNECTIONS are already real,
dataset-backed data (openbible.info); which of quotation/allusion/
thematic a connection is isn't encoded there at all, so a second tool,
`label_cross_reference_types`, lets Claude classify connections a prior
`find_cross_references` call already returned this turn.
`runLabelCrossReferenceTypesTool()` rejects the whole call, no partial
acceptance, if any reference wasn't actually in that real result — same
"wrong is worse than incomplete, so reject and let Claude retry" policy
as `label_word_senses`. Implementation mirrors that feature closely
enough that `crossReferencesThisTurn` (previously an array + a dedup
Set) became a `Map` keyed by focus verse, the same restructuring
`wordStudiesThisTurn` already needed, so a later type-labeling call can
look up and mutate the real diagram in place.

Frontend: each cross-reference list item gets an optional italic type tag
— deliberately plain text, not a solid badge like `.map-certainty-tag`'s
real identified/disputed distinction, so Claude's own read doesn't
visually outrank data that actually came from the dataset — plus a
disclosure line when anything's been typed.

Verified live: asked for Matthew 1:23's cross-references classified by
type, and got Isaiah 7:14 (the verse Matthew explicitly quotes) correctly
labeled "quotation," John 1:1 and Genesis 3:15 labeled "allusion," and
the remaining thematic Psalm/Isaiah parallels labeled "thematic" — a
theologically correct classification on the first real request, not a
cherry-picked retry. Confirmed the diagram and its type tags survive a
reload.

**Explicitly deferred**: turning the current "one focus verse plus its
direct connections" radial view into a genuinely explorable multi-hop
graph (click a connection to expand its own connections, building out a
bigger constellation) is a real, separate UI/interaction feature — new
client-side graph-layout logic and likely new state management, not a
system-prompt or single-tool addition like everything else in this
session's pass. Not started; flagged honestly rather than folded into
this commit as if it were done.

## 2026-09-23 — Observe→Interpret→Apply scaffold shipped

The simplest feature in this pass, matching its own "pure UI/prompt
feature, no data blockers" characterization exactly: a new
`OIA_PARAGRAPH` in `lib/chat.js`'s system prompt, same shape as the
existing sermon-outline-mode paragraph right above it (structure lives
entirely in the instruction, no new tool, no new data). The one real
decision: unlike the sermon outline (Pro-gated, `isPaid` check), this is
free for every user regardless of account status — Observe/Interpret/
Apply is a personal or small-group study habit, not a leader-facing
deliverable meant to be preached from, so gating it the same way would
have been the wrong call, not just an oversight. Updated the "write like
you're talking, prose not headers" paragraph's exception list to also
cover an OIA request, alongside the sermon-outline exception already
there.

Verified live (anonymous, unpaid session, confirming the free-for-
everyone decision): asked for an OIA study on James 1:19-20 and got a
correctly three-part-labeled, well-grounded answer — Observe noticed the
real Greek repetition (*orgē* in both "slow to anger" and "wrath of
man"), Interpret cited JFB's and Barnes' and Gill's actual comments by
name, and Apply stayed appropriately non-prescriptive per the
instruction rather than handing down a single mandated takeaway.

## 2026-09-23 — Manuscript variant "how much this matters" layer shipped

Best surprise of this whole pass: the "curated significance note per
variant type" this item's blocker called for already exists, written by
STEPBible themselves, sitting in the header of the exact TAGNT files this
project already reads (`data/TAGNT-Mat-Jhn.txt`'s own documentation of
its witness-marker scheme, CC BY 4.0 — quoted at length in
`lib/interlinear.js`'s new comment). No new dataset, no new fetch, and no
model-generated content at all was needed for this one — a first for this
whole batch of "closest safe version" features, and the cleanest possible
version: the note itself is exactly as licensed and sourced as the rest
of this project's data, not an interpretive layer on top of it.

`classifyVariantSignificance()` reduces a word's witness marker (e.g.
"NKO", "N(k)O", "ko") to one of five bands STEPBible's own header
documents (with real NT-wide counts): plain agreement (~94% of words),
Ancient-differs-from-Traditional, Traditional-only, Ancient-only, and
other-editions-only. The header gives five illustrative example patterns,
explicitly not exhaustive ("..." on one row) — the real data has ~20
distinct literal patterns, so the classifier implements the *general
rule* those five examples embody (bare/capital vs. parenthesized/
lowercase vs. absent, for N and K independently) rather than a lookup
table, and was checked against every one of the ~20 real patterns found
by scanning the actual file.

Wired into `lib/gather.js`'s existing `enrichGreekWord()` (same function
Alphabet Mode's morphology/letter breakdown already uses) as
`variantSignificance` — null for the plain-agreement band (nothing to
say about the ~94% baseline case), a real `{ category, label, note }`
otherwise. One thing this surfaced that the *existing* red/hidden variant
flagging in `public/app.js` doesn't currently catch: a word can be a
genuine, worth-knowing KJV-vs-modern difference (the
"ancientDiffersFromTraditional" band, e.g. "N(k)O") while still counting
as NA28 critical text and therefore never being flagged or hidden today
— this layer surfaces that case too, not just the two bands
(Traditional-only, other-only) that were already visually flagged.

Frontend reuses Alphabet Mode's existing per-word `<details>` breakdown
panel rather than adding new UI — the note appears there, styled with a
left accent border, when present. Verified live: asked about Matthew
5:32, clicked ἀπολύων (tagged "N(k)O" in the real data, not currently
flagged by the existing red/hidden variant treatment since it *is*
NA28 text), and got the correct "Ancient text differs from the
Traditional (KJV) text" note rendered inline with its morphology.

## 2026-09-23 — Study Trail shipped; Reel Kit shipped with the
image-generation decision resolved (client-side SVG → canvas → PNG)

**Study Trail.** The "session-path recorder" this item's blocker named
turned out to already exist in substance, the same way the manuscript-
variant significance data did: every structured artifact a study session
touches (gathered passages, cross-references, maps, passage briefings,
word studies) is already persisted per-turn on a conversation's
`render_log` — most of it added by earlier features *in this same
session's pass* (Passage Briefing, Word-Study Web, Cross-Reference
types). So Study Trail needed no new recording mechanism at all: a new
`studyTrailExportModel()` in `lib/export.js` just walks that existing log
and distills it into an ordered, deduplicated (first-occurrence-wins)
list of "stops" — one entry per distinct passage/cross-reference-lookup/
map/briefing/word-study actually touched, in the order they first came
up. It reuses every existing renderer (`renderAsText`/Markdown/PDF/docx)
unchanged, since they only ever consume the generic `{title, meta,
blocks}` shape — zero new rendering code. Wired into `server.js`'s
existing `GET /api/export/:type/:id` as a fourth `:type=trail` value
alongside outline/note/conversation, same Pro gate, same everything.
Frontend: a second labeled export row right next to the existing
whole-conversation export control, not a separate UI section, since it's
genuinely the same feature with a different distillation. Verified with
unit tests covering every artifact type, dedup across turns, and the
empty-trail fallback message; the real signed-in export round trip
itself isn't live-tested for the same reason `home_tradition`/
`depth_level`'s signed-in paths weren't — creating a real test account is
outside what I'll do unattended.

**Reel Kit — the image-generation decision.** Chose client-side SVG →
canvas → PNG download, no server-side rendering and no third-party
service, for reasons specific to this project: this app already draws
its map and cross-reference diagrams as inline SVG in the browser (real,
established precedent, not a new pattern); a server-side image library
(node-canvas, sharp, etc.) would be exactly the kind of heavy, native-
binary dependency this project's README already brags about having none
of, and a real new Render-deploy risk; and a third-party image-generation
service would mean ongoing cost and a new data flow (sending Scripture
text to a third party) for something a browser already does for free.
The one thing server-side rendering would have bought — pixel-perfect
custom-font control — doesn't matter here, since the card's fonts are
already plain web-safe serif/sans stacks with no custom `@font-face` to
begin with.

Implementation (`public/app.js`): `buildShareCardSvg()` builds a
1080×1920 (vertical "story" ratio, matching what "Reel" actually implies)
SVG card — verse text, reference, translation abbreviation, an "ad
fontes" wordmark — using the real hex values from `style.css`'s `:root`
palette (hardcoded, since a detached `<img>` never resolves CSS custom
properties). `downloadShareCard()` loads that SVG into an `Image`, draws
it onto an offscreen `<canvas>`, and downloads the canvas as a PNG via
the same Blob-URL-plus-throwaway-`<a download>` trick `triggerExport()`
already uses for file exports. A "Share as image" button sits under each
translation; verse text is read back out of the already-rendered,
already-verbatim `<p>` at click time — never re-typed, re-fetched, or
model-generated, so the card can never drift from the real gathered
text. Deliberately NOT read from a `data-*` attribute: `escapeHtml()`
(used everywhere else in this file for attribute values) doesn't escape
literal quote characters, which real Scripture dialogue very often
contains — embedding verse text in a quoted HTML attribute that way
would have been a real attribute-breaking/injection bug. Free for
everyone, signed in or not, unlike Study export — this does zero server
work, so there's no cost basis for gating it.

Verified live: rendered a real card for Matthew 5:32 and for John 3:16,
confirmed correct text wrapping and layout at the real target size,
confirmed the canvas→PNG step actually produces a valid, non-trivial PNG
blob (140KB for a two-sentence verse), and confirmed a verse containing
a literal `"` renders correctly in the SVG text (unlike a data-attribute
approach would have).

**Explicitly deferred**: a true multi-card/multi-slide "kit" (batching
several cards from a whole Study Trail at once, or a carousel) — this
pass ships the single-card generator, the actual value-generating unit,
and leaves batching for later, the same "ship the focused slice, defer
the bigger UI feature honestly" call as the Cross-Reference multi-hop
graph.

## 2026-09-23 — Select-anywhere popover shipped (all 13 Phase 2 items now
addressed)

Pure frontend, exactly as flagged — no backend, no new data, no tool.
Selecting real text anywhere inside `<main>` (a translation, the
interlinear, commentary, a briefing, Claude's own reply — everywhere
except the chat form itself, where a selection is just normal text
editing) shows a small floating "Ask about this" button positioned over
the selection; clicking it does exactly what every other click-to-ask
control in this app already does (cross-reference verses, map markers,
word-study occurrences) — fills the chat input and focuses it, this time
with arbitrary selected text instead of a designated reference.

Listens on `selectionchange` rather than `mouseup` specifically so it
works the same for a touch long-press selection on mobile as a mouse
drag on desktop, debounced since `selectionchange` fires continuously
during a drag. Popover hides on scroll (a stale position is worse than
none), on an outside click, and after use.

Verified live: a real mouse-drag selection inside a translation showed
the popover positioned correctly above the selected text; clicking it
filled the chat input with the selected text and focused it; selecting
text inside the chat textarea itself correctly showed no popover at all;
and the same drag-select-and-ask flow works cleanly at mobile width
(375px) without overflowing the viewport.

This closes out every item in the spec's Phase 2 priority list (1
through 13) — see the tracker below for the final status of each.

## 2026-09-24 — Phase 3 QA started: Playwright + axe-core, first batch
(navigation, accessibility, core chat flow) shipped, one real bug found
and fixed

**Playwright setup.** Added `@playwright/test` as this project's one
QA-only devDependency (pre-approved for exactly this point — see the
2026-09-21 pacing entry above). Installed with
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` and configured with
`channel: "chrome"` so it drives the real, already-installed Google
Chrome on this machine rather than downloading its own bundled Chromium —
verified standalone (`chromium.launch({ channel: "chrome" })` against a
data: URL) before writing a single real test, matching this project's own
"verify the sanctioned tool actually works before relying on it" habit.
`playwright.config.js`'s `webServer` block starts and stops the real
`node server.js` declaratively around the whole test run (port 3100, to
avoid clashing with anyone's real local dev server on 3000) — no manually
backgrounded process for a future session to find still running.

**Second QA-only dependency, not pre-approved, added and documented per
this session's own "use your judgment, document it" instruction**:
`@axe-core/playwright`, for accessibility scanning. Not explicitly named
in the original QA instructions, but hand-checking contrast ratios and
ARIA structure across a dozen pages isn't a serious substitute for the
standard tool built for exactly this, which Playwright's own docs
recommend pairing with itself. Small, pure JS, no browser download of its
own — same "QA-only, never touches production" boundary as Playwright
itself.

**Real accounts are out of scope for this QA pass**, for the same reason
they were out of scope during Phase 2's own live verification: creating a
real Supabase test account is a prohibited unattended action under this
session's standing safety rules. Everything gated on being signed-in/paid
is checked at the signed-out/free-tier level (does the lock/upsell state
render correctly) rather than with a real authenticated round trip — see
`qa/CHECKLIST.md`'s tooling-decisions section for the full reasoning.

**First real finding, found and fixed**: `#chat-input`'s only accessible
name came from its `placeholder` attribute, which `clearInputPlaceholder()`
blanks the moment a first message is sent — meaning a screen-reader user
lost the field's name entirely partway through a real conversation, not
on first load. A plain "does the home page pass axe" check couldn't have
caught this (the placeholder is still present then); a real chat-flow
scan, on a page state after an actual message, did. Fixed with a
permanent `aria-label="Message"` on the textarea, independent of
placeholder state. Full writeup in `qa/BUGS.md`.

**Real-API budget**: chat-flow tests hit the real Anthropic API and cost
real tokens (this is a live, billed app — see docs/STATE.md), so
`qa/tests/chat-flow.spec.js` is deliberately a small, representative
sample (3 tests: a bare-reference gather, a word study, a cross-reference
lookup) rather than one test per feature. Every individual tool's own
logic already has real unit-test coverage with stubbed Anthropic
responses in `test/chat.test.mjs`; the E2E layer's job is confirming the
real integration renders correctly, not re-proving each tool's logic a
second time. Passage Briefing, Observe/Interpret/Apply, Reel Kit,
Alphabet Mode, the manuscript-variant layer, and the select-anywhere
popover were each already verified live with screenshots during their own
implementation earlier this session (see this file's own 2026-09-22/23
entries for the specifics) and aren't re-verified here just to spend more
real API calls proving the same ground twice — `qa/CHECKLIST.md` marks
each of these explicitly rather than silently, so "not yet automated" and
"never verified at all" stay clearly distinguishable at a glance.

21/21 Playwright tests passing (13 navigation, 5 accessibility, 3 chat
flow) plus the full existing 335-test unit suite, unaffected.
Word-study-request timing needed a more generous timeout (100s, not the
initial 45s) once actually measured — a real multi-tool chain
(search_lexicon → find_occurrences) genuinely takes over a minute
sometimes, not a bug, just an under-estimated assumption in the test
itself.

## 2026-09-24 — Phase 3 QA, second batch: responsive + security, one more
real bug found and fixed

**Responsive** (`qa/tests/responsive.spec.js`, 3/3 passing): checked for
horizontal overflow at 320/375/768/1024/1440px on the home view and on a
loaded conversation — one real chat call reused across every breakpoint
via `setViewportSize`, not five separate calls. Clean at every
breakpoint, including a cross-reference SVG diagram the test's own real
request happened to trigger (confirming the radial chart itself, not
just text content, survives 320px). No findings.

**Security** (`qa/tests/security.spec.js`, 9/9 passing). One test-
authoring mistake surfaced and corrected along the way, not a real bug:
`GET /api/outlines` returns 200 with `{ outlines: [], locked: true }` for
an anonymous request rather than 401 — this is `server.js`'s own
documented "still 200, upsell is not an error" design (same pattern as
`/api/reading-plans`), not a leak; the test was rewritten to check for
exactly that shape (empty data, `locked: true`) instead of asserting the
wrong status code.

**Real finding, found and fixed**: no security response headers were set
on any route at all — no `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, or `Content-Security-Policy`, confirmed with a plain
`curl -D -` while writing the header-check test (not something axe or a
functional test would surface, since it's about HTTP headers, not page
content). Added the three headers that are safe to set unconditionally
(`nosniff`, `DENY`, `strict-origin-when-cross-origin`) globally, via one
`res.setHeader()` call at the top of `server.js`'s request handler —
Node merges headers set this way into whatever a specific route's
`writeHead()` call later specifies, so this needed touching only one
place rather than every `res.writeHead()` site in the file. Deliberately
did **not** add a real `Content-Security-Policy`: this app has no build
step and relies on inline `<script>`/`<style>` throughout
`public/index.html` by design, so a real CSP needs either
`'unsafe-inline'` (defeating most of its own point) or a nonce-based
rework of every inline tag — real, separate work deserving its own
careful pass and testing, not something to bolt on inside a QA pass.
Recorded as an open recommendation for `qa/REPORT.md`, not silently
dropped. Full writeup of both findings in `qa/BUGS.md`.

32/32 Playwright tests now passing across five spec files (navigation,
accessibility, chat flow, responsive, security), plus the full existing
335-test unit suite, unaffected by either header change or the
`aria-label` fix from the previous batch.

## 2026-09-24 — the deferred real Content-Security-Policy, built: a
nonce-based CSP, generated per request

Follow-up to the previous entry's explicitly-deferred recommendation.
Audited first rather than assumed (see the fuller comment at
`buildContentSecurityPolicy()` in `server.js`): `public/index.html` has
*zero* inline `<script>` or `<style>` **tags** — every script is
`src="..."` (three same-origin, one from the jsdelivr CDN for
supabase-js) and all CSS is the external `style.css`. So there was
nothing to literally "stamp a nonce onto" in the sense of an inline
block. What the audit *did* turn up: two real inline `style="..."`
**attributes**, written into HTML strings in `public/app.js` and
inserted via `innerHTML` — the cross-reference SVG edges' stroke-width/
opacity (`renderCrossReferenceSvg`) and the word-study chart's bar width
(`renderWordStudyChart`). Nonces cover `<style>`/`<script>` *elements*,
never inline style *attributes* — there's no CSP mechanism that allow-
lists a specific `style="..."` value the way a nonce allow-lists a whole
`<script>` tag (CSP3's `'unsafe-hashes'` can hash a *static* attribute
value, which doesn't help here since these are computed per-request
numbers, not fixed strings). The actual fix: both were changed to render
as plain `data-*` attributes instead, with the real value applied via the
CSSOM (`el.style.width = ...`) after the markup lands in the DOM — a new
`applyComputedStyles()` in `app.js`, called from `appendCrossReference-
Diagrams()`/`appendWordStudies()` right after `innerHTML` is set. This is
what let `style-src` end up as plain `'self'`, no `'unsafe-inline'`
needed at all — a stricter policy than "add a CSP" alone would have
gotten without this extra step.

**The mechanism**: `server.js`'s `serveStatic()` now special-cases
`index.html` (`serveIndexHtml()`): a fresh nonce
(`randomBytes(16).toString("base64")`) is generated per request — never
cached, never reused, since a reused nonce is a replayable one — every
real `<script>` tag in the file gets `nonce="..."` stamped on via a
regex targeting `<script` followed by whitespace or `>` (so it doesn't
depend on the file's exact current attribute-spacing), and the identical
value goes into a `Content-Security-Policy` response header built by
`buildContentSecurityPolicy(nonce)`. Every other static asset (the .js/
.css/.png files themselves) is served unchanged, with no CSP header —
CSP governs the *document*, not each individual subresource response.

**Full directive-by-directive audit** (each checked against what this
app actually does, not assumed):
- `script-src 'nonce-{X}' 'strict-dynamic' https:` — nonce is the real
  trust anchor; `strict-dynamic` is currently inert future-proofing
  (confirmed nothing dynamically injects a `<script>` today) that avoids
  a silent break if that ever changes; `https:` is the standard CSP2
  fallback for a nonce-aware-but-strict-dynamic-unaware browser, ignored
  entirely by anything that understands `strict-dynamic`. Deliberately
  **no** `'unsafe-inline'` fallback: every browser that understands a
  nonce ignores `'unsafe-inline'` in the same directive anyway, and
  omitting it avoids a naive scanner flagging it as a false-positive
  weak point.
- `style-src 'self'` — no nonce, no `'unsafe-inline'`, made possible by
  the two attribute-to-CSSOM conversions above.
- `img-src 'self' blob:` — `blob:` is real, not padding: Reel Kit's
  `downloadShareCard()` loads a generated SVG into an `<img>` via a
  `blob:` URL before drawing it to a canvas.
- `connect-src 'self'` **plus the real, live `SUPABASE_URL`** when
  configured — `public/auth.js`'s supabase-js client talks to that origin
  directly from the browser for Auth REST calls, not through this
  server, so it has to be allow-listed explicitly; it's operator config
  (an env var this deploy's own admin set), read the same way
  `/api/config` already exposes it, not user input needing extra
  sanitizing.
- `worker-src 'self'` — explicit rather than left to the
  `script-src`/`child-src` fallback chain, specifically because that
  fallback ambiguity is exactly the kind of thing that works in some
  browsers and silently breaks the PWA's service-worker registration in
  others.
- `base-uri 'none'`, `form-action 'self'` (checked: every real form in
  this app is JS-intercepted via `event.preventDefault()`, so this never
  actually fires — `'self'` rather than `'none'` in case that ever
  changes), `frame-ancestors 'none'` (the modern CSP equivalent of the
  `X-Frame-Options: DENY` already sent for every response),
  `object-src 'none'`.

**Regression tests** (`test/server.test.mjs`, real HTTP requests against
a real running server, same as every other test in that file — not
assumed from reading the source): a fresh nonce per request; the exact
same nonce on every real `<script>` tag in the body, checked by parsing
what actually came back over the wire; two concurrent requests get two
different nonces; `/chat` (an SPA-shell route) gets the same treatment,
not just `/`; no `'unsafe-inline'` or bare `*` in `script-src`;
`frame-ancestors`/`object-src` both locked down; a plain static asset
gets no CSP header at all; the three baseline security headers from the
previous QA batch still ride alongside the new CSP header. 40/40 passing
(6 new).

**Live, page-by-page verification that nothing silently broke** — the
real risk this task named explicitly: a missed inline tag doesn't crash
anything visible, it just gets silently blocked, which only shows up as
a `securitypolicyviolation` event (or, inconsistently, a console
message) — never a non-200 response or an obvious rendering failure. Two
layers, not one:
1. A new `qa/tests/csp.spec.js` registers a real
   `securitypolicyviolation` listener via `page.addInitScript()` (so
   nothing during initial load can be missed) on every static page (`/`,
   `/today`, `/plans`, `/outlines`, `/subscription`, `/sources`), on a
   hard-refresh direct navigation to each (confirming the nonce actually
   regenerates per request rather than being cached), on opening the
   site menu (exercises `auth.js`'s Supabase client setup), on the
   service worker's real registration promise (confirms `worker-src`
   didn't silently break PWA installability), and on the exact blob:→
   `<img>` path Reel Kit uses (confirms `img-src blob:` actually works,
   without needing a real chat message on screen to click a real button).
   10/10 passing, zero violations anywhere.
2. `chat-flow.spec.js`'s existing three real-Anthropic-call tests were
   extended (not duplicated at extra real-API cost) to also assert zero
   CSP violations, and — specifically for the two CSSOM-refactored
   spots — to read back `el.style.width` / `el.style.strokeWidth` /
   `el.style.opacity` and confirm they hold real, non-empty computed
   values, not just "no violation happened" but "the chart still looks
   like a chart." All three still passing.
3. Manually, independently, via the sandboxed Browser pane (a separate
   browser context from Playwright's own Chrome instance) rather than
   trusting the automated suite alone: navigated to every one of the six
   static pages and read the real console on each — zero messages,
   every time. Opened the site menu live and screenshotted it (correctly
   rendered, including a restored prior conversation). Fetched `/` with
   a plain `curl -D -` against the real dev server (real `.env`, real
   configured Supabase project) and confirmed the live header contains
   the actual project's Supabase origin correctly interpolated into
   `connect-src`, not just a placeholder.

42/42 Playwright tests passing (10 new), full 341-test unit suite
(6 new) unaffected.

**One infrastructure flake found and fixed along the way, unrelated to
the CSP itself**: running the full 42-test suite with Playwright's
default multi-worker parallelism produced one transient failure in
`responsive.spec.js`'s overflow check — several concurrent real browsers
plus several concurrent real Anthropic calls against the one shared dev
server caused a reflow blip at the exact moment that test measured
`scrollWidth`. Confirmed as a timing artifact, not a real CSS bug, by
re-running that exact test alone (passed cleanly, repeatedly). Since this
suite's whole design already centers on one shared real server and real,
rate-limited external APIs, `playwright.config.js` now pins `workers: 1`
— slower wall-clock time, but a suite whose entire point is trustworthy
results against a real backend shouldn't also be racing itself. Full
42/42 passing, repeatedly, once serialized.

## 2026-09-24 — Source chips: a Perplexity-style citation strip, evolving
Receipts Mode's quote badge rather than sitting beside it

Competitive research (YouVersion, Blue Letter Bible, Logos) came back with
one clear, high-leverage UI gap: none of them show *how well-grounded* a
reply is before you click into it. Blue Letter Bible's cross-references are
a flat sidebar list; YouVersion's Notes are polished but buried; Logos has
real depth but a steep learning curve. The brief asked for a Perplexity-
style fix — small labeled citation chips, a visible "N sources" count,
tap-to-preview the excerpt — applied broadly (translations, commentary,
cross-references, word studies), evolving Receipts Mode's existing
verified/flagged quote badge into the new pattern instead of building a
second, parallel citation system next to it.

**The real design fork, flagged rather than guessed on**: how to generate
the chips at all.

- *Option A — parse Claude's own prose for inline citation markers*, the
  literal Perplexity match: the model emits "[1]", "[2]" correlated to
  specific claims, the frontend parses them out and resolves them against
  real source data. Rejected. This app's entire design philosophy —
  Tradition Lens, Passage Briefing's disclosure, Word-Study Web's validated
  sense-clustering, Receipts Mode itself — is "never present something as
  grounded unless it's checked against real data." Trusting the model to
  correctly correlate a citation marker to the right source index is a new,
  unvalidated failure mode (wrong index, inconsistent citing, drift) for a
  UI-only improvement. Not worth it.
- *Option B — synthesize chips from data already gathered this turn*
  (`gathered.translations`, `.commentary.entries`, `.originalLanguage`,
  `crossReferences`, `wordStudies`, `briefings`) — no prose parsing at all.
  **Chosen.** Every chip traces to something the app already fetched and
  already trusts; the "hover/tap preview" requirement is satisfied by
  reusing this app's one existing disclosure interaction (click/tap — no
  new hover-only affordance needed for touch parity) rather than a second
  mechanism. Consistent with how the Reel Kit and Tradition Lens forks were
  resolved earlier this session: the safer, already-grounded version wins
  over the more literal competitor-match.

**Implementation** (`public/app.js`'s `buildSourceChips`/`renderSourceChips`,
replacing the old standalone `renderQuoteVerification`): one chip per
distinct source for a turn — quote-verification chips first (the strongest
trust signal), then translations, original-language text, commentary
entries, cross-reference sets, and word studies, in the same order the full
source cards below already render in. Passage Briefing chips are visually
distinguished (dashed border, same convention `.map-marker-disputed`
already uses for "not fully verified") since that's the one card with no
real dataset behind it. Chips are plain `<button>`s sharing one preview
panel below the strip, not individually-expanding `<details>` — with many
small chips in a wrapping flex row, letting each expand its own content
inline reflows the whole line unpredictably; one shared panel is
predictable and identical on touch and pointer.

**A real bug found during live verification, fixed same-session**: the
first version generated one chip per translation/commentary *per gathered
passage*. A passage-briefing-style reply (e.g. "brief me on the book of
James, plus cross-references and a word study") calls `gather_passage`
once per verse it cites — a dozen or more times for a whole-book request —
and since this app always fetches the same fixed translation set and the
same fixed five commentaries for every passage, that produced ~100
near-duplicate "BSB"/"WEB"/"Barnes' Notes" chips, drowning the one useful
verified/flagged signal. Fixed by deduping chips by `(kind, label)`,
keeping the first passage's excerpt (tagged with its reference) as the
preview; confirmed live (see below) that a 12-passage James briefing went
from ~100 chips to the correct 13 distinct ones. A hard display cap (14)
plus a plain-text "N more below" note was added on top as a safety net for
genuinely distinct sources (e.g. many different cross-reference lookups in
one turn) that dedup can't collapse.

**Verified live** (sandboxed Browser pane, real dev server): a restored
Matthew 5:32 conversation (15 real chips, including six real flagged-quote
chips from Receipts Mode) rendered correctly after a stale service-worker
cache was cleared (a real gotcha hit during this verification — this app's
PWA service worker was serving the previous `app.js` until explicitly
unregistered, which is worth remembering for any future frontend change
verified against a long-running local server); click-to-preview toggling
correctly shows exactly one panel at a time; a live real-Anthropic call
("brief me on James, plus cross-references and a word study on faith")
triggered the dedup bug, which was fixed and re-verified live producing 13
correct chips across all five chip kinds (verified quote, flagged quote,
source, background); confirmed no horizontal overflow at 320px.

**Depth slider audit (Priority 2)**: already a prominent, always-visible
segmented control directly above the chat input (`#depth-control`,
`public/app.js`) — not buried in a menu. No change needed; this was a
verify-not-broken check, not a gap.

**Regression tests**: `qa/tests/source-chips.spec.js` (4 new tests) seeds
`localStorage` directly with a synthetic `chatLogData` entry in the exact
shape `saveChatState()` writes, then loads the page so the real
`restoreChatState()` → `renderChatLog()` → `renderSourceChips()` path runs
against deterministic fixture data — no Anthropic cost, and the only
practical way to regression-test the dedup/cap logic itself (reproducing a
12-gathered-passage reply via a real API call every test run would be
slow, costly, and non-deterministic). Covers: correct chip count/kinds for
a mixed-source reply, click-to-preview toggling, the dedup fix (12 passages
→ 4 chips), and the display cap (20 distinct cross-refs → 14 chips + an
overflow note). `qa/tests/chat-flow.spec.js`'s existing real-call Genesis
1:1 test was extended with two assertions (strip visible, first chip
non-empty) at zero extra API cost, confirming the real integration path
too, not just the synthetic-fixture one.

## 2026-09-24 — My Notes: a standalone page, closing a real audited gap

Priority 2 of the same design/UX brief asked to confirm Notes and the
Depth slider are genuinely easy to find, not buried — direct answers to
two competitors' named weaknesses (YouVersion's buried Notes, Logos's
overwhelming-for-beginners problem).

**Depth slider**: already a prominent, always-visible segmented control
directly above the chat input (`#depth-control`). Verified, not changed —
this was a check, not a gap.

**Notes**: a real gap, confirmed by audit before writing any code. Notes
were only ever rendered inline, one `.notes-section` per gathered passage
(`renderNotesSection` in `public/app.js`) — there was no way to browse
everything you'd ever saved in one place, unlike My Outlines' own page.
`GET /api/notes` even required a `ref` query param, so the data layer
itself had no "list everything" shape yet. That's exactly the "buried"
failure mode the competitive research named in YouVersion, just with a
different UI (contextual instead of a hidden menu) producing the same
practical outcome: you can only find a note again by remembering, and
revisiting, the exact passage you wrote it on.

**Built**: a standalone My Notes page, mirroring My Outlines' existing
page/menu/data-loading pattern as closely as possible rather than
inventing a new one:
- `lib/supabase.js`'s `listNotes(userId, reference)` — `reference` is now
  optional (omitted, it lists every note for the user, newest first,
  across every reference), the same optional-filter shape `listOutlines`
  already had. `server.js`'s `GET /api/notes` no longer 400s without
  `?ref=` — it lists everything instead.
- Unlike My Outlines/Reading Plans, notes are a **free** feature (see the
  Subscription page's own plan list), so this page has a "sign in" empty
  state, not a Pro-upsell lock — a deliberate, small deviation from the
  Outlines template it otherwise copies exactly.
- `public/app.js`'s `renderNoteItem` (already shared by every inline
  notes-section) gained an opt-in `showReference` flag so the standalone
  page's list can show which passage each note belongs to — inline, that
  context is already implicit from the passage it sits under. Clicking the
  reference asks about that passage in chat (`sendChatMessage`), the same
  pattern already used by the reading-plan-day and daily-passage buttons
  (both also standalone-page controls that route into chat rather than
  filling the input).
- New route `/notes`, wired the same way `/today`/`/plans`/`/outlines` are:
  a `VIEW_PATHS` entry, `server.js` serving the same `index.html` shell on
  a hard refresh, and a menu button between Reading Plans and My Outlines.

**Verified live**: sandboxed Browser pane, both signed-out (`/notes` shows
the sign-in prompt, no crash, no data leak) and a simulated signed-in state
(stubbing `window.adFontesAuth.getAccessToken` and the `GET /api/notes`
response after real page load, rather than creating an actual Supabase
test account — see this session's standing rule against that) — two notes
across two different references rendered newest-first, each labeled and
clickable; clicking a reference correctly asked a real question in chat and
got a real reply; no horizontal overflow at 320px; no console errors.

**Regression tests**: `qa/tests/notes-page.spec.js` (8 new tests) using the
same route-interception/getAccessToken-stub technique used for the live
verification above — signed-out sign-in-prompt state, hard refresh, menu
presence/navigation, a populated list (newest-first, each reference
labeled), the empty state, reference-click-asks-in-chat (with `POST
/api/chat` also stubbed, so this costs nothing real), and delete-removes-
the-item. `/notes` added to `navigation.spec.js`'s hard-refresh loop and
`csp.spec.js`'s static-route list. `lib/supabase.js`'s new "list all"
behavior covered in `test/supabase.test.mjs`. 342/342 unit tests, 56/56
Playwright tests passing.

## 2026-09-24 — Passage Briefing card: bento-grid layout (Priority 3, lower
priority, judged worth doing)

The brief flagged this as speculative/nice-to-have and left it to
judgment. The existing card (`renderPassageBriefing` in `public/app.js`)
was already a label/value list, not literally "a wall of text," but it was
a plain vertical stack — genre, author, date, and structure all competing
for the same narrow column regardless of how short or long each fact
actually was. Judged worth doing: it's a small, self-contained CSS/HTML
change (no new data, no architecture risk, nothing else in the codebase
references the old `.briefing-row`/`.briefing-label` class names), and it
directly matches what the research described.

**Built**: `.briefing-grid` (`display: grid; grid-template-columns:
repeat(auto-fit, minmax(150px, 1fr))`) replacing the row stack. Short facts
(genre, traditional author, approximate date) sit as compact blocks side
by side; the longer ones (structure, and setting when present) each get
`grid-column: 1 / -1` to span the full width rather than being squeezed
into the same narrow column as a one-word genre. `auto-fit`/`minmax`
collapses to a single column on its own at narrow widths — no separate
mobile breakpoint needed. Same parchment palette/border treatment as every
other block on this page (`--paper`/`--line`), per the brief's own note
not to fight the existing aesthetic.

**Verified live**: a real James briefing (no `setting` for this reference)
renders three compact blocks then a full-width Structure block then the
disclosure note, with no gap or broken row for the missing block; no
console errors; no horizontal overflow at 320px (the grid drops to one
column on its own, confirmed visually).

**Tests**: no dedicated new Playwright test added — nothing in the existing
suite asserted on the old `.briefing-row`/`.briefing-label` selectors (only
`.briefing-disclosure`'s presence is implicitly exercised by the existing
`.source-passage` visibility checks in `chat-flow.spec.js`/
`responsive.spec.js`, both still passing), and this is a pure visual
restyle of already-real, already-grounded data with no new logic to
regress. 342/342 unit tests, 56/56 Playwright tests passing unaffected.

## 2026-09-28 — Fixed a real over-gathering regression: narrow tool use,
depth-tied breadth, go-deeper follow-ups

A user complaint, reported directly rather than found during a QA pass:
asking about a passage dumped everything the tool had (translations,
interlinear, commentary, cross-refs, maps) regardless of what was actually
asked — overwhelming rather than helpful. Different problem from the
2026-09-24 source-chips work, which fixed how already-gathered material is
*displayed*, not what gets gathered and written into the main answer in
the first place.

**Root-cause audit** (`lib/chat.js`, `lib/gather.js`):

1. `gather_passage` was monolithic — one call always fetched and showed
   the *full* bundle (4 translations, the full interlinear, 5
   commentaries), with no way to ask for just one part. A question about a
   single Greek word's meaning still forced the same four-translation,
   five-commentary card onto the screen as a "what does this whole passage
   mean" question would.
2. The system prompt only *softly* encouraged restraint on
   `find_cross_references`/`generate_map`/`generate_passage_briefing`
   ("worth calling whenever... genuinely relevant," "not for every place
   mention") — real wording, but not a strong enough bar to reliably stop
   a capable model from reaching for "genuinely relevant" liberally when
   being thorough is the path of least resistance.
3. **The Depth slider (Everyday/Student/Scholar) had zero effect on any of
   this** — confirmed by grepping every use of `depthLevel` in `lib/chat.js`:
   it only ever selected a paragraph of wording/tone guidance
   (`DEPTH_LEVEL_PARAGRAPHS`), never touched tool-calling behavior, `sections`,
   or anything gathered/shown. The user's own suspicion was exactly right.
4. Every tool result a turn produced was returned to the frontend
   unconditionally (`chatTurn`'s `gatheredThisTurn`/
   `crossReferenceDiagramsByFocus`/etc.) with no filtering step based on
   relevance or depth — whatever got called, got shown, full stop.

**Fix, in order of leverage:**

1. **`gather_passage` gains an optional `sections` parameter**
   (`["translations", "originalLanguage", "commentary"]`, any subset;
   omitted defaults to all three, preserving the existing broad-question
   behavior unchanged). `lib/gather.js`'s `gatherPassage()` already had this
   exact pattern for commentary alone (`includeCommentary`, used by
   `index.js --no-commentary` and `?commentary=false`) — extended with
   matching `includeTranslations`/`includeOriginalLanguage` flags, each part
   of the cache key (a narrower and a fuller request for the same reference
   must not collide). A skipped section renders as nothing on the frontend
   (`renderOriginalLanguage`'s new `type === "skipped"` branch; an empty
   translations array and `commentary.skipped` already rendered as nothing
   via existing "empty means don't show a heading" logic) rather than a
   "not found" message for something that was never asked for.
2. **A new, prominent "match tool use to the size of the question"
   principle**, placed right after the tool list, before any of the
   existing per-tool guidance: a narrow question gets one narrow tool call
   (or one `gather_passage` section); `find_cross_references`/
   `generate_map`/`generate_passage_briefing` are only for when the
   question is actually about that thing, not a routine add-on. Each of
   those three tools' own descriptions was also tightened from soft
   encouragement ("worth calling whenever... genuinely relevant") to real
   restriction ("call it only when...").
3. **Depth now genuinely gates tool-calling breadth, not just wording** —
   the part of the fix the user specifically asked for. Each
   `DEPTH_LEVEL_PARAGRAPHS` entry gained an explicit breadth clause:
   *Everyday* defaults to the single narrowest tool call and stops there
   (a deliberate behavior change for the default, untouched setting — that
   IS the fix, not a side effect to avoid); *Student* keeps default scope
   but may proactively add one clearly relevant extra; *Scholar* is
   explicitly told this is "a real expectation... not just a permission" —
   treat a bare-reference or open-ended question as an invitation to
   proactively add one genuinely relevant extra (a cross-reference for a
   passage well-known for its connections, a textual-critical nuance,
   whole-book orientation) without being asked.
4. **A "go deeper" follow-up-actions row** (`public/app.js`'s
   `buildFollowUpActions`/`renderFollowUpActions`) after any reply that
   gathered at least one passage — computed from what's genuinely missing
   this turn (a skipped `gather_passage` section, no cross-reference for
   this passage yet, no briefing yet), capped to the *last* gathered
   passage so a whole-book turn can't multiply this into the same kind of
   clutter the source-chips dedup fix already solved once. Each button is a
   plain natural-language follow-up (`"Show me the original language for
   JHN.3.16."`) routed through the same `sendChatMessage()` every other
   quick-action in this app already uses — not a side-channel fetch that
   would bypass the model's own tool-scoping judgment on the next turn.

**Design fork, flagged rather than guessed on**: whether the "go deeper"
affordance should be actionable buttons (each triggers a real new message)
or passive citations (extending the source-chips pattern to show what
*could* be fetched as an inert, clickable-for-preview label). Chose
actionable buttons: a narrow answer's whole point is that the rest was
genuinely never fetched, so there's nothing real to cite yet — a chip that
"previews" something never actually gathered would be either empty or a
lie. An actionable follow-up that triggers a real fetch is the only
mechanism consistent with this app's "never fabricate, always ground in
real data" discipline.

**A second real bug found during live verification, fixed same-session**:
Receipts Mode (`lib/verify.js`) flagged an ordinary quoted aside in
Claude's own prose (not a Scripture quotation at all) as "doesn't match
any translation fetched this turn" whenever a narrow gather deliberately
excluded translations — there was never any ground truth to check *any*
quote against, positive or negative, so "unverified" misleadingly read as
"checked and wrong" rather than "never looked." Fixed by distinguishing a
deliberate skip (translations: `[]`) from a real fetch failure (a
non-empty array of `{error}` rows) in `verifyReplyQuotes` — only the
former now short-circuits to "nothing to flag." The pre-existing "nothing
gathered at all still flags a quote" behavior (a real, separately-tested
design decision, presumably meant to catch a reply quoting from pure
memory with zero grounding) is deliberately left unchanged.

**A prompt-tuning fix found during live verification**: the Scholar depth
paragraph's first draft ("feel free to be more proactively thorough")
was being dominated by the new, much more assertively-worded general
restraint paragraph earlier in the prompt — a live test showed a bare
reference to Isaiah 53:5 (a passage well-known for its NT cross-references)
got *identical* treatment at Everyday and Scholar depth. Reworded as a
concrete, assertive expectation rather than a soft permission; re-verified
live and confirmed Scholar now proactively adds a relevant cross-reference
for the same bare reference that stayed narrower at Everyday depth (see
below).

**Verified live** (sandboxed Browser pane, real Anthropic calls, Everyday
depth unless noted):
- *Narrow*: "What's the Greek word for 'love' in John 3:16?" → exactly one
  chip ("Greek (NA28)"), zero translations/commentary/cross-refs/map/
  briefing rendered, four follow-up buttons offered (translations,
  commentary, cross-references, briefing).
- *Follow-up round-trip*: clicking "See cross-references" sent "What are
  the cross-references for JHN.3.16?" and rendered a real cross-reference
  diagram — the mechanism works end to end, not just in the synthetic test
  fixtures.
- *Broad, bare reference*: "Romans 8:28" → full bundle (10 sources:
  3 translations + Greek + 5 commentaries), but — the actual fix, distinct
  from the old behavior — zero cross-references/map/briefing auto-added,
  with follow-up buttons offered for exactly those two.
- *Depth comparison, same bare reference*: "Isaiah 53:5" at Everyday depth
  → full bundle only, no cross-references. The same message at Scholar
  depth → full bundle *plus* a proactively-added, genuinely relevant
  cross-reference diagram, with no map or briefing added (still exercising
  judgment, not a blanket dump) — a real, confirmed behavior difference
  tied to the Depth slider, not just wording.
- No console errors in any of the above; the Receipts Mode false-positive
  was reproduced before the `lib/verify.js` fix and confirmed gone after.

**Regression tests**: `test/gather.test.mjs` (3 new — includeTranslations/
includeOriginalLanguage skip their fetch, and are part of the cache key),
`test/chat.test.mjs` (2 new — `sections` narrows the fetch end to end
against real local data, using the existing "the fetch stub throws on any
unexpected URL" pattern as an implicit assertion that no over-fetching
happened; found and fixed a real shared-cache test-order bug along the
way, since gather.js's module-level cache isn't cleared between tests in
this file), `test/verify.test.mjs` (3 new — the narrow-gather exception,
that a real fetch failure still flags as before, and that a mixed narrow/
full turn still verifies normally), `qa/tests/followup-actions.spec.js`
(5 new, no Anthropic cost — seeds `localStorage` the same way
`source-chips.spec.js` does), and one new real-call test in
`chat-flow.spec.js` locking in the end-to-end fix against the actual
model. 350/350 unit tests, 62/62 Playwright tests passing.

## Not yet built (spec items, honestly tracked, not silently dropped)

In spec priority order, each with why it's not done yet — everything is
now either done or has an explicitly deferred, documented sub-part:

2. Alphabet Mode — letter-level groundwork (atlas + per-word grammar/letter
   breakdown) is done as of 2026-09-22, see above. Still missing: a
   tap-to-save personal deck and a spaced-repetition scheduler, both of
   which need a new Supabase table; and Hebrew coverage (different
   alphabet, different grammar-code scheme).
3. ~~Depth slider~~ — done as of 2026-09-23, see above.
4. ~~Tradition Lens~~ — done as of 2026-09-23, see above.
5. ~~Passage Briefing card~~ — done as of 2026-09-23, see above.
6. ~~Word-Study Web~~ — done as of 2026-09-23, see above.
7. Cross-Reference Constellation — the quote/allusion/thematic distinction
   is done as of 2026-09-23, see above. Still missing: a genuinely
   explorable multi-hop graph beyond the current focus-verse-plus-
   connections radial view (a real UI/interaction feature, not a prompt
   or tool addition).
8. ~~Observe→Interpret→Apply scaffold~~ — done as of 2026-09-23, see above.
9. ~~Manuscript variant "how much this matters" layer~~ — done as of
   2026-09-23, see above.
10. (Voices Through History) — effectively already shipped; not re-listed.
11. ~~Study Trail + Reel Kit~~ — done as of 2026-09-23, see above (the
    single-card Reel Kit generator; batch/multi-card export deferred, see
    above).
12. ~~Select-anywhere popover~~ — done as of 2026-09-23, see above.

**Built since this was first written:**
13. Sources & Licenses page (`/sources`) — done 2026-09-22. Static content,
    no data blocker; wired the same way every other standalone page is.

**Remaining known gaps, all explicitly deferred with reasoning recorded
above, not silently dropped:**
- Alphabet Mode's save-a-word deck + spaced repetition (needs a new
  Supabase table) and Hebrew letter/grammar coverage (item 2).
- Cross-Reference Constellation's multi-hop explorable graph (item 7).
- Reel Kit's batch/multi-card export (item 11).
