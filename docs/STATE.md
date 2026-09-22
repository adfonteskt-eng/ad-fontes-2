# State of the repo — audited 2026-09-21

This document exists because a product spec arrived describing ad-fontes as
"currently a local prototype... fetches passage text from the YouVersion
Platform API" with no UI. **That premise is wrong and this doc corrects it.**
ad-fontes is a live, deployed, multi-user production web app at
adfontes.site, with a full chat UI, real accounts, and 266 passing tests.
The sections below are grounded in an actual read of the code and a real
`npm test` run on 2026-09-21, not the spec's assumptions. Everything below
either cites a file/line or a command actually run.

## What this app actually is today

A chat-first Bible study web app. One text box; a Bible reference or a
free-form question both work. Every reply is produced by Claude
(Anthropic's API) via a tool-use loop (`lib/chat.js`), grounded in real
fetched/indexed source material — Claude does not answer purely from its
own training-memory recall for passage content, though **there is currently
no programmatic verifier that checks a quoted verse in Claude's own prose
against the fetched text** (see Gaps below — this is the single biggest gap
relative to the new spec's "Receipts Mode").

Deployed on Render (`render.yaml`, Blueprint) as three services: the web
app, a daily-digest cron, and a daily-push cron. GitHub repo
`adfonteskt-eng/ad-fontes-2`, branch `main` auto-deploys.

## Architecture (as it exists, not as planned)

- `server.js` (1345 lines) — zero-framework Node `http` server. Owns every
  route (see Routes below), static file serving from `public/`, request
  size/length caps, session-id validation, and dispatch into `lib/`.
- `index.js` — the original CLI entry point (Phase 1/2 of the README's own
  roadmap). Still works; prints a passage + AI summary to stdout. Not the
  primary product anymore but not dead code either.
- `lib/gather.js` (419 lines) — `gatherPassage(usfm)`: fetches translations
  (YouVersion Platform API), original-language interlinear (STEPBible, via
  `lib/interlinear.js`), and commentary (`lib/commentary.js`, scraped from
  biblehub.com) for one verse, in parallel, each failing independently.
  15-minute in-memory cache.
- `lib/chat.js` (990 lines) — `chatTurn()`, the agentic loop. Claude has 6
  base tools + 2 more for signed-in paid users (8 total):
  `gather_passage`, `search_lexicon`, `find_occurrences`,
  `search_bible_text`, `find_cross_references`, `generate_map`, and
  (paid-only) `search_study_history`, `search_my_notes`. History trimming
  only cuts at safe turn boundaries. One turn is atomic (works on a history
  copy, commits only on success).
- `lib/interlinear.js` (693 lines) — parses STEPBible TAHOT (Hebrew OT, 4
  files) / TAGNT (Greek NT, 2 files) tagged text; `searchLexicon()`,
  `findStrongsOccurrences()`.
- `lib/cross-references.js` (236 lines) — real cross-reference lookups from
  openbible.info's dataset (CC BY 4.0, ~345k verse-pairs with vote/
  relevance scores, chiefly Treasury of Scripture Knowledge). Backs the
  `find_cross_references` tool and a radial SVG diagram in the frontend.
- `lib/geography.js` (267 lines) — resolves a place name to a real
  coordinate via openbible.info's Bible-Geocoding-Data (CC BY 4.0), with an
  "identified"/"disputed" confidence derived from the dataset's own score
  distribution — never a coordinate Claude invents. 6 curated named routes
  (Paul's 3 journeys + voyage to Rome, the Exodus, Abraham). Backs
  `generate_map` + an SVG map (base coastline from Natural Earth, public
  domain, pre-projected and shipped as static data in `public/map-data.js`).
- `lib/bible-search.js` (231 lines) — full-text keyword search, indexed
  from the Berean Standard Bible's own public-domain text (deliberately NOT
  derived from YouVersion API output — see the file's own licensing
  comment on why that distinction matters under YouVersion's Platform
  Terms).
- `lib/supabase.js` (720 lines) — accounts (email+password via Supabase
  Auth), notes CRUD, conversations (durable "previous conversations" list),
  outlines CRUD, reading-plan progress, digest/push preferences, paid
  profile fields. Plain `fetch` against PostgREST, no SDK.
- `lib/stripe.js` (171 lines) — **exists, is wired into `server.js`
  (checkout/portal/webhook routes), is referenced in `.env.example` and
  `supabase/schema.sql` (`stripe_customer_id`, `stripe_subscription_id`
  columns) — but has zero test coverage.** Not mentioned in the incoming
  product spec at all. Test-mode only per its own env-var comments. This
  predates my involvement in this session; I have not audited its
  correctness beyond confirming it exists and is routed.
- `lib/export.js` (235 lines) — outline/note/conversation export to
  PDF/Word/Markdown/text (Pro feature).
- `lib/rate-limit.js` + `lib/session-store.js` + `lib/upstash.js` — per-IP
  daily caps and session storage, Redis-backed when configured, in-memory
  fallback otherwise.
- `lib/reading-plans.js`, `lib/daily-passage.js`, `lib/daily-digest.js`,
  `lib/push.js` — curated reading plans (7), the rotating "today's
  passage," and the two cron-job scripts that email/push it.
- `public/app.js` (1804 lines), `public/auth.js` (937 lines),
  `public/style.css`, `public/index.html` — the entire frontend. No
  framework, no build step, no bundler. Six client-side "views" toggled by
  JS (`home`, `conversation`, `today`, `plans`, `outlines`, `subscription`),
  each a real linkable/refreshable path server.js also serves directly.
  PWA-installable (`manifest.json`, `sw.js` — deliberately a no-op cache
  passthrough, see that file's own header comment for why).

## Routes (from `server.js`, verified by grep, not assumed)

`GET /`, `/chat`, `/today`, `/plans`, `/outlines`, `/subscription` (all
serve the SPA shell); `GET /api/passage`, `/api/daily`, `/api/config`,
`/api/conversations[/:id]`, `/api/notes`, `/api/outlines[/:id]`,
`/api/reading-plans[/:id/days/:day]`, `/api/preferences`,
`/api/push/subscribe[/unsubscribe]`; `POST /api/chat`, `/api/notes`,
`/api/outlines`, `/api/billing/checkout`, `/api/billing/portal`,
`/api/webhooks/stripe`; `GET /api/export/:type/:id`.

## Data sources and licensing (already implemented, already credited)

| Source | License | Used for |
|---|---|---|
| YouVersion Platform API | Platform Terms (attribution required, live-fetch only per their terms — not for building a persisted index, see `lib/bible-search.js` header comment) | On-screen translations |
| STEPBible-Data (TAHOT/TAGNT/TBESG/TBESH) | CC BY 4.0, "distribute from a single source, don't redistribute" | Original-language interlinear, lexicons |
| Berean Standard Bible full text | CC0 / public domain | Full-text search index |
| biblehub.com | Public-domain commentaries (Matthew Henry, Barnes, JFB, Gill, Geneva) | Commentary |
| openbible.info cross-references | CC BY 4.0 | `find_cross_references` |
| openbible.info Bible-Geocoding-Data | CC BY 4.0 | `generate_map` |
| Natural Earth | Public domain, no attribution required | Static map coastline art |

There is **no dedicated in-app Sources & Licenses page** yet — credits are
inline in the footer and in tool-result text, not centralized. This is
explicitly requested by the new spec (§13) and does not exist.

## Tests — verified by running them, 2026-09-21

`npm test` → **266 passed, 0 failed**, `node --test`, no test framework
dependency. 19 test files, one per `lib/` module with meaningful logic
(`chat.js`, `gather.js`, `cross-references.js`, `geography.js`,
`interlinear.js`, `bible-search.js`, `supabase.js`, `export.js`,
`rate-limit.js`, `session-store.js`, `reading-plans.js`, `daily-*.js`,
`push.js`, `ttl-cache.js`, `fetch-timeout.js`, `bible-books.js`,
`server*.js`). **`lib/stripe.js` has no test file — genuine gap.** No
frontend/UI test coverage at all (no Playwright, no jsdom) — everything in
`public/` has only been manually/browser-verified in past sessions, never
under an automated test.

## What the new spec asks for that does NOT exist yet (real gaps, not overlap)

Mapped against the spec's Phase 2 list, checked against the code above:

1. **Receipts Mode's verifier** — does not exist. `gather_passage` fetches
   real text and Claude is instructed not to fabricate, but nothing
   programmatically re-checks a quoted string in Claude's final reply
   against the fetched verse text. No citation-chip UI either.
2. **Alphabet Mode** (letter-by-letter Greek/Hebrew, tap-to-save deck,
   spaced repetition) — does not exist. The interlinear table shows
   word-level data (surface form, transliteration, Strong's, gloss) but
   nothing letter-level, and nothing persists a "words I've tapped" deck.
3. **Depth slider** (Everyday/Student/Scholar) — does not exist. There's
   one register of answer (aimed at an interested layperson), not three,
   and nothing persisted per-user.
4. **Tradition Lens** (Settled/Common/Debated labels, named-tradition
   positions) — does not exist. `lib/chat.js`'s system prompt already says
   "when commentators or translations genuinely disagree, present that as
   disagreement" — the instinct is there, but there's no structured
   label, no fixed tradition taxonomy, no home-tradition setting.
5. **Passage Briefing card** (genre/author/date/setting-map/structure) —
   does not exist as a discrete feature, though `generate_map` could back
   the setting-map part directly.
6. **Word-Study Web** (occurrence graph by sense, frequency chart) —
   partially covered: `find_occurrences` already returns every tagged
   occurrence of a Strong's number with a total count. No sense-clustering,
   no chart, no book/author filter UI.
7. **Cross-Reference Constellation** — largely exists already
   (`find_cross_references` + the radial SVG diagram), but doesn't
   distinguish quotation/allusion/thematic link types (the openbible.info
   dataset doesn't carry that distinction) and isn't a full interactive
   graph beyond the current focus-verse-plus-connections radial view.
8. **Observe→Interpret→Apply scaffold** — does not exist.
9. **Manuscript variant flags** — partially exists: `lib/interlinear.js`
   already flags TR/Byzantine-only variant words in the Greek NT display
   ("N variant words... hidden," per `public/app.js`'s
   `renderOriginalLanguage`), but there's no plain-English "how much this
   matters" explanation attached.
10. **Voices Through History** — largely exists already (5 public-domain
    commentaries, dated/labeled by author, rendered visually distinct from
    Claude's own prose in a separate `<details>` block).
11. **Study Trail + export, Study→Reel Kit** — Study Trail does not exist
    (no auto-recorded session-path export). Export infrastructure for
    outlines/notes/conversations already exists (`lib/export.js`) and could
    be extended. Reel Kit does not exist at all.
12. **Select-anywhere popover** — does not exist (no text-selection UI).
13. **Sources & Licenses page** — does not exist as a page (see above).

Items NOT in conflict with anything existing: nothing above requires
removing or breaking a shipped feature. Everything is additive.

## Corrections to the incoming spec's premises

- It is not a "local prototype" — it is in production with real users,
  real Anthropic/YouVersion/Supabase/Stripe costs, and a real deploy
  pipeline. Changes to the chat loop, session handling, or rate limiting
  need the same caution as any other production system.
- It already has "a minimal, clean, mobile-first web UI" — extensively
  hand-tuned across two prior polish passes this session for mobile
  (320–768px), accessibility (contrast, focus-visible, aria-labels), and
  loading-state resilience. It does not have dark mode (single warm
  "aged parchment" light palette, a deliberate design choice, not an
  oversight) — the spec asks for light/dark; this is a real product
  decision to flag, not silently build around (see docs/DECISIONS.md).
- The YouVersion fetch is not a "script" to migrate behind a provider
  interface as a first step — `lib/gather.js` already is that interface in
  practice (one function, `gatherPassage()`, that the CLI, `GET
  /api/passage`, and every chat tool all call through). It is not
  literally pluggable to a second Bible-text provider yet, but the
  integration point already exists in one place.
- `README.md`'s own "Roadmap" section is stale in one place: it still says
  "no real checkout wired up yet, `is_paid` is set by hand for now" —
  false as of the Stripe commit. Worth a follow-up fix, noted here rather
  than fixed inline in this audit doc.

## Known risk areas going into new work

- `lib/chat.js`'s system prompt and 8-tool budget (`MAX_TOOL_ITERATIONS`)
  are already carefully tuned; any new tool (e.g., a verifier, a depth
  parameter) needs to fit that same discipline, not bolt on ad hoc.
- No Playwright/browser automation dependency exists yet. The spec asks
  for it explicitly for QA; adding it means a new devDependency (currently
  zero devDependencies) — flagged as a decision, not assumed.
- Real users are on this system. Anything touching `/api/chat`,
  `chatTurn()`, or session storage gets tested locally against the real
  dev server before any deploy, same standard as every prior fix this
  session.
