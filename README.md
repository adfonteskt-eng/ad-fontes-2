# ad-fontes

[![Test](https://github.com/adfonteskt-eng/ad-fontes-2/actions/workflows/test.yml/badge.svg)](https://github.com/adfonteskt-eng/ad-fontes-2/actions/workflows/test.yml)

A scripture-studying partner. Give it a Bible reference and it prints, in one go:

- The passage in several English translations (via the [YouVersion Platform API](https://developers.youversion.com))
- The tagged Greek (New Testament) or Hebrew (Old Testament) — each word with its Strong's number and a short lexicon definition
- A handful of public-domain commentaries on the passage
- An AI-generated plain-language takeaway and study notes summarizing all of the above

No npm dependencies — `package.json` has none, and every server-side integration (YouVersion, Anthropic, Upstash, Supabase) is plain `fetch` against documented REST APIs. The one exception is the browser: the optional sign-in flow loads the official Supabase client from a CDN (see Accounts & study memory) — the one place hand-rolling it wasn't the right call.

## Roadmap

- **Phase 1 — Gather.** Pull the primary-source material for a passage into one
  structured object: translations, original-language interlinear, commentary.
  Done — `lib/gather.js`.
- **Phase 2 — Summarize.** Turn that material into something a person can read
  quickly: a short takeaway plus deeper study notes. Done — `lib/summarize.js`.
- **Phase 3 — Productize.** Turn this from a CLI into a website, app, or browser
  extension. In progress — the website (`server.js` + `public/`) is a single
  chat interface (`lib/chat.js`): one box, ask about any passage, Claude
  gathers translations/original-language/commentary via tool use as needed
  and shows them alongside a conversational reply. Deployable to Render via
  `render.yaml` — see Deployment below. Optional accounts (Supabase magic
  link, from a top-left menu) unlock a compounding study memory, a
  sermon/lesson outline mode, a durable "previous conversations" list
  (filterable by most-recent or by canonical book order), and a rotating
  daily passage — with a one-line teaser — on the homepage. See Accounts &
  study memory. Not yet done: billing (the free beta has per-IP usage caps
  instead, see Configuration) and an app or browser extension if still
  wanted later.

## Setup

Requires Node 20.12 or newer (`process.loadEnvFile` and global `fetch`).

```bash
cp .env.example .env   # then add your app key
npm run fetch-data     # ~104 MB of STEPBible text files (~34 MB Greek + ~70 MB Hebrew)
```

## Tests

```bash
npm test
```

Runs against Node's built-in test runner (`node --test`, no new dependency).
Covers the original-language parsing edge cases that turned out to be real
bugs at some point (dual versification in both directions, Qere/Ketiv
placeholder rows, TR/Byzantine-only variants), the `gatherPassage()` cache,
`fetchWithTimeout()`, and the chat tool-dispatch loop + bounded session
store — all against real downloaded STEPBible data (requires `npm run
fetch-data` to have been run first) with external network calls stubbed.
Doesn't cover live YouVersion/biblehub/Anthropic behavior, browser
rendering, or the actual UI — those still need a live session to verify.

Runs automatically on every push/PR to `main` via GitHub Actions
(`.github/workflows/test.yml`) — same `npm run fetch-data && npm test` as
local setup, just in CI.

## Usage

```bash
npm start
```

```
============================================================
JHN.3.16
============================================================

BSB — Berean Standard Bible
For God so loved the world that He gave His one and only Son, that everyone who believes in Him shall not perish but have eternal life.

KJV — King James Version
For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.

WEB — World English Bible
...

------------------------------------------------------------
Original language
------------------------------------------------------------

Greek — NA28 critical text (25 words)

    οὕτως     houtōs    G3779    thus(-ly)
    γὰρ       gar       G1063    for
    ἠγάπησεν  ēgapēsen  G0025    to love
    ὁ         ho        G3588    the/this/who
    θεὸς      theos     G2316    God
    ...

1 variant word in the TR/Byzantine tradition hidden. Show with --variants (marked ±).

------------------------------------------------------------
Commentary
------------------------------------------------------------

Matthew Henry (Concise)
  ...

Jamieson-Fausset-Brown
  ...

------------------------------------------------------------
Summary
------------------------------------------------------------

[plain-language takeaway]

Study notes

[translation differences, word-study highlights, where commentators agree/disagree]
```

Any reference works, Old or New Testament:

```bash
node index.js GEN.1.1
node index.js PSA.23.1
node index.js ROM.8.28
node index.js JHN.3.16 --variants
node index.js JHN.3.16 --no-commentary
node index.js JHN.3.16 --no-summary
```

## Website

```bash
npm run web            # http://localhost:3000
PORT=8080 npm run web  # or pick a different port
```

One box, no separate search field: type a bare reference ("John 3:16",
"1 Cor 13:4") or a full question ("what kind of love does Paul mean in
1 Corinthians 13:4?"), and the reply comes back conversationally with the
translations, original-language interlinear, and commentary Claude actually
used shown alongside it in a collapsible block per passage. Ask a follow-up
without repeating the reference, or ask something with no specific verse in
mind — Claude can pull in a cross-reference itself if one genuinely helps.

One page, two client-side views: home (title/tagline, the "Try:" examples,
today's passage) and conversation (the chat log), toggled by
`public/app.js`'s `renderView()` rather than a real page load — sending the
first message, clicking an example or the daily passage, or resuming a
conversation from the top-left menu all switch to the conversation view;
the "Home" button (only shown there) or clicking the "ad fontes" logo goes
back and starts fresh. The URL (`/` vs `/chat`) tracks whichever view is
showing via `history.pushState`, so the browser's back/forward buttons work
like real navigation, and `GET /chat` (`server.js`) serves the same
`index.html` so a direct link or hard refresh still loads correctly.

The empty state also shows a "Today's passage" pick (`GET /api/daily`,
`lib/daily-passage.js`) — the same reference for every visitor on a given
UTC day, deterministically rotating through a curated ~120-passage list
rather than picked randomly, so it's reproducible and spread across both
testaments instead of clustering on a handful of famous verses. Clicking it
just sends a normal chat message ("What does John 3:16 (JHN.3.16) mean?"),
so it reuses the exact same flow as typing a reference by hand — no
separate rendering path to keep in sync.

This works because the chat box isn't a second, separate question-answering
path bolted onto search — there is no separate search anymore. Every
message goes through `lib/chat.js`, which gives Claude three tools, all
backed by real local STEPBible data (no guessing from memory):

- `gather_passage` — the same `gatherPassage()` Phase 1 pipeline the CLI
  uses: translations, original-language interlinear, commentary for one
  verse.
- `search_lexicon` — finds the real Strong's numbers behind an English
  concept (e.g. "love" → agapaō G0025, phileō G5368, Hebrew ahav H0157),
  so a topical question doesn't rely on Claude's memory of Greek/Hebrew
  vocabulary.
- `find_occurrences` — every verse actually tagged with a given Strong's
  number, for genuine word studies and cross-references grounded in the
  data instead of a plausible-sounding guess.

Claude decides what to call and when, mid-conversation, chaining tools for
topical questions ("what does Scripture say about love?" → search_lexicon →
find_occurrences → gather_passage on a couple of the strongest hits). That's
also what fixes the disconnect an earlier version had: because everything —
the passage data and the conversation — lives in the same message history,
"what does that mean in the Greek" naturally resolves to whatever was
gathered a moment ago, without needing separate plumbing to link the two.

Beyond answering questions, Claude can also produce a sermon outline,
lesson, or small-group discussion guide on request — a prompt-level
capability (`buildSystemPrompt()` in `lib/chat.js`), not a separate tool or
endpoint. It's the one case where structured output (headers, numbered
points, a discussion-questions list) is explicitly encouraged instead of
the normal prose-only style, and it's grounded the same way every other
answer is: gathered material first, then an outline built from what's
actually there rather than a generic template.

A few things make repeated use faster, cheaper, and more resilient without
changing behavior: `gatherPassage()` results are cached in-memory for 15
minutes (`lib/gather.js`), every external call (YouVersion, biblehub,
Anthropic) has a timeout so a stalled request fails cleanly instead of
hanging forever (`lib/fetch-timeout.js`), the browser persists the rendered
chat log to `localStorage` so a page refresh doesn't lose the conversation
(`public/app.js`), and the chat API call uses Anthropic's automatic prompt
caching (1-hour TTL) so the system prompt, tool definitions, and growing
conversation history are billed at a fraction of normal input-token price on
repeat calls within a conversation, instead of resending everything at full
price every turn.

Session history itself is stored through `lib/session-store.js`, which has
two backends: an in-memory Map (the default — zero setup, but lost on every
server restart) and Upstash Redis (set `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` — see `.env.example`), which makes sessions
durable across restarts and redeploys. `lib/chat.js` doesn't know or care
which backend is active. Without Redis configured, a page refresh still
looks fine (the browser's own `localStorage` copy of the chat log is
restored), but the server-side session backing it is gone, so Claude won't
actually remember anything from before the restart even though the messages
are still on screen — that's the gap Redis closes. Chose Redis over a SQL
database for this specifically because the data here is just an opaque blob
per session that should expire after a period of inactivity, which maps
directly onto Redis's native per-key TTL with no schema needed; a relational
database is the right tool for the *later* accounts/billing work, not this.

Since the beta is free and has no login yet, there's nothing to meter usage
against except the client's IP — `lib/rate-limit.js` enforces a daily cap
per IP on both chat messages (`CHAT_DAILY_LIMIT`, default 60/day) and
passage summaries (`SUMMARY_DAILY_LIMIT`, default 40/day), specifically to
bound worst-case Anthropic spend from one runaway or abusive client, not to
police normal study sessions. It shares the same Redis-or-in-memory backend
split as sessions (via `lib/upstash.js`, the small REST client both modules
use) — with Redis configured, the cap survives a restart the same way
sessions do; without it, a restart quietly resets everyone's count for the
day. Hitting the chat cap returns an HTTP 429; hitting the summary cap
returns the passage data with a summary error instead of failing the whole
request, since translations/interlinear/commentary don't depend on
Anthropic and shouldn't be withheld just because the summary is capped. At
current Claude Sonnet 5 pricing, the defaults work out to a worst-case
ceiling around $1.50-2.50/day for one IP that never benefits from prompt
caching at all — real conversational use costs meaningfully less than that
(see the cost-ceiling comment above `CHAT_DAILY_LIMIT` in
`lib/rate-limit.js` for the full math).



```
POST /api/chat
{ "sessionId": "…", "message": "…" }
-> { "sessionId": "…", "reply": "…", "gathered": [ { reference, translations, originalLanguage, commentary }, … ] }
```

`sessionId` is omitted on a conversation's first message; the server
creates one and returns it for the client to send with every message after
that. `gathered` lists the passages (if any) Claude looked up while
producing that specific reply — usually one, more if it pulled in a cross-
reference, empty if the reply didn't need new data (e.g. a follow-up about
something already gathered earlier in the conversation). Clicking "New
conversation" in the UI always clears a session; whether a server restart
also clears it depends on whether Redis is configured (see above). No new
configuration is required for chat itself: it reuses `YVP_APP_KEY` and
`ANTHROPIC_API_KEY`.

The old `GET /api/passage?ref=...` endpoint (translations/interlinear/
commentary/summary for one reference, no chat) still exists in `server.js`
and works, but the frontend no longer calls it — it's unused dead weight
now except as a plain data API, kept in case that's useful later.

## Accounts & study memory

Optional, and additive everywhere: chat works identically with or without
being signed in. Set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and
`SUPABASE_SECRET_KEY` (see `.env.example`) to enable it — without them, the
top-left menu button never appears and nothing about the app changes.

What signing in actually unlocks is a compounding study memory: every
passage Claude gathers during a signed-in conversation gets logged (in the
background — see below) as a `study_entries` row, and a signed-in user gets
a fourth tool, `search_study_history`, that lets Claude search *that specific
user's* past study — not just the current conversation's own history — for
genuine callbacks ("you looked at this same passage back in your Ephesians
study"). This is the actual product bet behind accounts: a tool that gets
more valuable to a specific person the longer they use it, rather than one
that resets to zero context every conversation.

**Sign-in flow.** Magic link only for now (no password to manage, and no
Google/OAuth setup required to get started) — `public/auth.js` loads the
official `@supabase/supabase-js` client from a CDN (the one place in this
project's frontend that isn't hand-rolled fetch: PKCE/magic-link token
handling is genuinely easy to get subtly wrong by hand, which is exactly why
a managed provider was chosen for auth in the first place — see the
Deployment section's reasoning, one level up). The browser handles the
entire flow itself — requesting the link, detecting the token when the user
clicks back into the site, keeping the session current — and only ever
hands `lib/chat.js` the resulting access token via an `Authorization: Bearer`
header on `/api/chat` (and on the `/api/conversations` routes below).
`GET /api/config` hands the frontend the public URL and publishable key it
needs to set this up, rather than hardcoding them into a static file that
can't read the server's `.env`. All of this lives in a single top-left menu
(`#site-menu` in `public/index.html`), not scattered across the page: Home
at the top; below it, either the previous-conversations list (with the
recent/by-book sort toggle) or, when there's nothing to show yet, a New
chat button; sign up (or, once signed in, the account row + sign out) at
the bottom.

**Magic link setup — don't skip this.** `signInWithOtp()` passes
`emailRedirectTo: window.location.origin` so the emailed link points back
at wherever the app is actually running, but that URL still has to be on
the project's allow list or Supabase will reject the redirect. In the
Supabase dashboard, go to **Authentication -> URL Configuration** and: set
**Site URL** to your deployed URL (it defaults to `http://localhost:3000`,
which is why a magic link can look "broken" — it's sending fine, just
redirecting somewhere dead) and add that same URL under **Redirect URLs**.
Do this for every environment you actually sign in from (e.g. both your
Render URL and `http://localhost:3000` for local dev).

By default, magic-link emails come from Supabase's own shared sending
service, which is why they show up as sent by "Supabase Auth" rather than
this app. Two separate things to change, both in the dashboard: the
**subject line** is editable for free under **Authentication -> Email
Templates -> Magic Link**; the **sender name/address** (what most email
clients show before you even open the message) requires configuring
**Custom SMTP** (**Authentication -> SMTP Settings**) with your own email
provider (Resend, Postmark, SendGrid, etc.) — Supabase's built-in sender
can't be renamed without one. Neither of these can be set from this
codebase; they're project-level Supabase config.

**Server-side, no SDK.** `lib/supabase.js` talks to Supabase's REST APIs
directly (Auth REST for `verifyUser()`, PostgREST for everything else) with
plain `fetch`, the same pattern as `lib/upstash.js` — so server-side code
stays at zero npm dependencies even with accounts added. Two different
Supabase API keys are involved and are **not** interchangeable: the
publishable key (safe to expose to a browser) verifies a user's own token;
the secret key (server-only, bypasses Row Level Security by design) is what
every `study_entries`/`conversations` read/write actually uses, since the
server already verified the user itself and scopes every query by their id
manually. One real gotcha worth documenting: the secret key must be sent
*only* as the `apikey` header, never also as `Authorization: Bearer
<secret key>` — even though Supabase's docs describe that combination as
technically allowed (`Authorization` matching `apikey` exactly), they also
note it gets forwarded to Postgres and rejected there for not being a JWT,
which is exactly what caused a real "permissions error" in production
before this was caught and fixed. See the comment on `postgrest()` in
`lib/supabase.js`.

**What "compounding" means concretely, today.** Logging is fire-and-forget
— a background write after a signed-in turn finishes, never awaited, so it
can't add latency to the reply the user is waiting on or break the turn if
it fails. Recall (`search_study_history`) is a plain keyword/reference
match today (PostgREST `ilike` across reference/topic/summary), not
semantic search — a deliberate, documented v1 scope decision (see
`supabase/schema.sql`), not an oversight: embeddings/pgvector would improve
recall quality but add real infrastructure and per-entry cost that isn't
justified without real usage data yet to show it's worth it.

**Previous conversations.** Every signed-in turn also appends to a durable
`conversations` row (`lib/supabase.js`'s `appendToConversation()`) — a
title (from the conversation's first message), the canonical book of the
first passage gathered (`lib/bible-books.js`), and a lightweight render log
the frontend can redraw directly. `GET /api/conversations` lists a user's
own conversations (most-recent first, or grouped in actual Bible book
order via `?sort=book` — Genesis-to-Revelation, not alphabetical);
`GET /api/conversations/:id` fetches one to resume. Resuming keeps the same
*conversation* id (so it keeps appending to the same row) even though the
live chat *session* (`lib/session-store.js`, a 2-hour idle TTL) may have
long since expired — see `lib/chat.js`'s `chatTurn()` docstring for the
`sessionId`-vs-`conversationId` distinction. One known limitation: if the
live session did expire, continuing a resumed conversation starts Claude's
actual model context fresh — the old messages are shown, but Claude isn't
re-fed them as conversation history, only whatever `search_study_history`
happens to surface. Persisting the full model-format history too (not just
the render log) would close that gap; not done yet since it's meaningfully
more storage/complexity for a benefit that's easy to defer until it's
clearly wanted.

**Setup** (run once): create a free Supabase project, open the SQL Editor,
paste in and run `supabase/schema.sql` (creates `profiles`/`study_entries`/
`conversations` and their RLS policies — idempotent, safe to re-run), then
copy the three values from Settings -> API Keys into `.env`.

## Deployment

Configured for [Render](https://render.com) via `render.yaml` (a
"Blueprint" — Render reads this file instead of needing everything clicked
through the dashboard by hand). To deploy: push this repo somewhere Render
can see it, then on render.com go New -> Blueprint and point it at the repo.
Render will read `render.yaml`, provision one free web service, and prompt
for the secrets marked `sync: false` in that file (`YVP_APP_KEY`,
`ANTHROPIC_API_KEY`, and — recommended, see below — the two `UPSTASH_*`
values) before the first deploy finishes.

`data/` (the ~105 MB of STEPBible text files) isn't in the repo or on a
persistent disk — `render.yaml`'s build step (`npm run fetch-data`)
re-downloads it from GitHub fresh on every deploy instead, the same as local
setup. This is deliberate, not a corner cut: the CC BY 4.0 licence on that
data asks that it be distributed from a single source rather than
redistributed (see Data & licence below), and it also means the free plan's
ephemeral filesystem — wiped on every redeploy — is exactly the right fit
here rather than something to work around.

Two things worth knowing about running this on Render's free plan
specifically, since they shape what "free beta" actually feels like for a
user:

- **Free web services spin down after 15 minutes with no traffic**, and the
  next request wakes it back up — taking on the order of 30–60 seconds
  before it responds. The first message after a quiet period will feel
  slow; every one after that (until the next idle period) is normal speed.
  There's no fix for this on the free plan short of upgrading to a paid
  instance type once real usage justifies the cost.
- **Without `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` set, both
  chat sessions and the daily usage caps reset on every spin-down/spin-up
  cycle** — not just on a manual redeploy. Since the free plan spins down
  after every idle period, that's a real, frequent case here, not an edge
  case. Setting the two Upstash variables (free tier, no credit card — see
  `.env.example`) is what makes both of those durable across that cycle;
  strongly recommended for anything beyond a quick local demo.

None of this requires a paid Render add-on — the persistent-disk option
Render offers is for services that need to *write* durable data to disk,
which this app doesn't (its only disk writes are the re-fetched, disposable
`data/` files). Redis (for sessions/caps) and Render's compute are the only
two moving pieces, and Upstash's free tier covers the former.

## Translations

Defaults to BSB, KJV, WEB, and ASV. Override with `BIBLE_IDS` in `.env` (comma-separated
YouVersion version ids) if your app key only has access to a different set — YouVersion
app keys are approved per-app for specific translations, so the defaults here may not all
be available to every key. Translations that fail to fetch are noted inline rather than
aborting the whole run.

## Manuscript variants (Greek NT)

The tagged Greek marks which manuscript tradition each word belongs to. By
default only words in the **NA28 critical text** are shown, since that's what
modern English translations (including the BSB used here) follow.

John 3:16 has one such word — `αὐτοῦ` ("his"), present in the Textus
Receptus/Byzantine tradition behind the KJV but not in NA28. Pass `--variants`
to include these; they're marked `±`.

```bash
node index.js JHN.3.16 --variants
```

The Hebrew OT side doesn't have this same NA28-vs-TR split — TAHOT instead
records manuscript variants (Qere/Ketiv, Aleppo, BHS, etc.) per word, and
every word position gets exactly one displayed row.

## Commentary

Pulls five public-domain, full-Bible-coverage commentaries from biblehub.com's
per-verse commentary page: Matthew Henry's Concise Commentary, Jamieson-Fausset-Brown,
Barnes' Notes, Gill's Exposition, and the Geneva Study Bible. Long entries are
truncated to keep the output readable; skip the section entirely with `--no-commentary`.

This is the one part of ad-fontes that scrapes a web page instead of parsing a
downloaded data file (there's no clean, keyless bulk commentary API), so it's the
piece most likely to need a fix if biblehub ever changes its page markup — if the
section comes back empty, that's the first place to check (`lib/commentary.js`).

## Summary (Phase 2)

If `ANTHROPIC_API_KEY` is set, ad-fontes sends everything gathered above —
translations, original-language words with glosses, commentary excerpts — to
Claude and asks for two things: a short plain-language takeaway (what the
passage says and why it matters, no jargon) and study notes (meaningful
translation differences, word-study highlights, where commentators agree or
genuinely disagree). It's instructed not to invent citations or pad out thin
material, and to present interpretive disagreement as disagreement rather than
pick a side.

Without an API key, this section is skipped with a one-line note — everything
else still works. Skip it explicitly with `--no-summary`, or change the model
with `SUMMARY_MODEL` in `.env`.

## Configuration

| Variable            | Description                                          |
| ------------------- | ---------------------------------------- |
| `YVP_APP_KEY`        | App key from developers.youversion.com. Required.     |
| `BIBLE_IDS`          | Comma-separated Bible version ids. Defaults to BSB, KJV, WEB, ASV. |
| `BIBLE_ID`           | Single-translation override, kept for backward compatibility. Ignored if `BIBLE_IDS` is set. |
| `ANTHROPIC_API_KEY`  | Key from console.anthropic.com. Optional — enables the summary section and chat. |
| `SUMMARY_MODEL`      | Which Claude model generates the summary. Defaults to `claude-sonnet-5`. |
| `UPSTASH_REDIS_REST_URL` | Optional. Makes chat session history (and the usage caps below) durable across restarts — see the Website section above. Without it, both fall back to in-memory storage. |
| `UPSTASH_REDIS_REST_TOKEN` | Optional, paired with the URL above. |
| `CHAT_DAILY_LIMIT` | Optional. Max chat messages per IP per day during the free beta. Defaults to 60. |
| `SUMMARY_DAILY_LIMIT` | Optional. Max passage summaries per IP per day during the free beta. Defaults to 40. |
| `SUPABASE_URL` | Optional. Enables accounts, compounding study memory, and the previous-conversations menu — see Accounts & study memory below. |
| `SUPABASE_PUBLISHABLE_KEY` | Optional, paired with the URL above. Safe to expose to the browser (that's what "publishable" means here). |
| `SUPABASE_SECRET_KEY` | Optional, paired with the URL above. Server-only — never sent to the browser. |

`.env` is gitignored. Keep all keys/tokens out of source control.

## Data & licence

Greek and Hebrew text and lexicons come from
[STEPBible-Data](https://github.com/STEPBible/STEPBible-Data) — created by
STEPBible.org based on work at Tyndale House Cambridge, licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Files used:

| File | Purpose |
| ---- | ------- |
| `TBESG` | Translators Brief lexicon of Extended Strongs for Greek |
| `TAGNT Mat-Jhn`, `TAGNT Act-Rev` | Tagged Greek NT |
| `TBESH` | Translators Brief lexicon of Extended Strongs for Hebrew |
| `TAHOT Gen-Deu`, `TAHOT Jos-Est`, `TAHOT Job-Sng`, `TAHOT Isa-Mal` | Tagged Hebrew OT |

They are downloaded by `npm run fetch-data` into `data/`, which is gitignored.
The licence notice asks that the data be distributed from a single source rather
than redistributed, so this repo points at the source instead of vendoring it.

Commentary text (Matthew Henry, JFB, Barnes, Gill, Geneva) is public domain and
fetched live from biblehub.com per verse rather than bundled.

## Project layout

| File | Role |
| ---- | ---- |
| `lib/gather.js` | Phase 1. `gatherPassage(usfm, opts)` → structured object, no printing. Results cached in-memory for 15 min (`clearGatherCache()` to force-clear). |
| `lib/summarize.js` | Phase 2. `summarizePassage(gathered, opts)` → `{ shortSummary, studyNotes }`. Also exports `formatGatheredPassage()`, the plain-text formatter shared with `lib/chat.js`. |
| `lib/chat.js` | Phase 3 chat. `chatTurn(opts)` → `{ sessionId, conversationId, reply, gathered }`, looping Claude tool calls (`gather_passage`, `search_lexicon`, `find_occurrences`, and for a signed-in user `search_study_history`) as needed. Live session storage delegated to `lib/session-store.js`; durable per-conversation persistence (signed-in only) delegated to `lib/supabase.js`. |
| `lib/session-store.js` | Pluggable session storage: Upstash Redis when configured, in-memory Map fallback otherwise. |
| `lib/rate-limit.js` | Per-IP daily usage caps (`checkAndIncrement()`) protecting the Anthropic bill during the free beta. Same Redis/in-memory split as session storage. |
| `lib/upstash.js` | Shared Upstash Redis REST client (`redisCommand()`, `isRedisConfigured()`) used by both `lib/session-store.js` and `lib/rate-limit.js`. |
| `lib/daily-passage.js` | `getDailyPassage(date)` — the curated, date-rotating "today's passage" (with a short teaser tag) shown on the homepage. No external calls, no storage. |
| `lib/bible-books.js` | Canonical 66-book Bible order (Genesis→Revelation, not alphabetical) + lookup helpers, used to sort the previous-conversations menu by book. |
| `lib/supabase.js` | Server-side Supabase client for accounts: `verifyUser()` (Auth REST); `logStudyEntry()`/`searchStudyHistory()` and `appendToConversation()`/`listConversations()`/`getConversation()` (PostgREST). Plain fetch, no SDK — see Accounts & study memory below. |
| `supabase/schema.sql` | The `profiles`/`study_entries`/`conversations` tables + RLS policies. Run once in the Supabase SQL Editor. |
| `lib/interlinear.js` | Greek/Hebrew parsing against the STEPBible data files. Also exports `searchLexicon()` (keyword → Strong's numbers) and `findStrongsOccurrences()` (Strong's number → every tagged verse). |
| `lib/commentary.js` | biblehub.com scraper. |
| `lib/fetch-timeout.js` | `fetchWithTimeout()` — shared AbortController-based timeout wrapper used by every external call (YouVersion, biblehub, Anthropic, Upstash). |
| `index.js` | CLI: calls `gatherPassage()`/`summarizePassage()` and prints the result. |
| `server.js` | Web API: `/api/passage`, `/api/chat`, `/api/daily`, `/api/config`, `/api/conversations[/:id]`, plus static file serving. |
| `public/` | Website frontend — plain HTML/CSS/JS, no build step. `auth.js` is the one exception to "no dependencies": loads the official Supabase client from a CDN for the sign-in flow (server-side stays dependency-free — see `lib/supabase.js`), and also owns the top-left menu's previous-conversations list. |
| `scripts/fetch-data.js` | Downloads the STEPBible data files into `data/`. |
