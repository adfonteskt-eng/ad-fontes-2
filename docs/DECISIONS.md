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

## Not yet built (spec items, honestly tracked, not silently dropped)

In spec priority order, each with why it's not done yet:

2. Alphabet Mode — real scope (letter atlas content, a tap-to-save deck
   schema, a spaced-repetition scheduler). Needs its own Supabase table.
3. Depth slider — needs the profiles column above + a system-prompt
   variant per depth; straightforward once started.
4. Tradition Lens — needs a curated tradition/proof-text dataset decision:
   hand-curate a small fixed set (Reformed/Baptist/Wesleyan/Catholic/
   Orthodox × common debated topics) or have Claude generate positions
   live with named-source grounding. Leaning toward the latter with a
   strict "cite a real named source or say you can't" instruction, mirrors
   how `find_cross_references` already prefers a real dataset over model
   recall — worth a explicit decision before writing code, not guessing.
5. Passage Briefing card — mostly composable from data already fetched
   (genre/author/date is general knowledge Claude already discloses as
   such elsewhere; setting map reuses `generate_map` directly).
6. Word-Study Web sense-clustering + chart — `find_occurrences` exists;
   clustering "senses" of a Strong's number is itself an interpretive
   judgment call with no dataset backing it directly, needs thought on
   how to ground it rather than have Claude invent clusters.
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
13. Sources & Licenses page — no blocker at all, pure documentation/UI;
    should be one of the next things built, cheap and high-trust-value.
