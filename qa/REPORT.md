# Phase 3 QA report

**Date**: 2026-09-24
**Scope**: the full application, including all 13 of the incoming spec's
Phase 2 features (shipped across this session, see `docs/DECISIONS.md`),
the pre-existing app (chat, accounts, notes, outlines, reading plans,
subscription/billing, PWA/push), and the nonce-based CSP built as a
same-day follow-up to this QA pass's own security findings.
**Method**: real, automated Playwright tests against a real running
instance of `server.js` (real STEPBible/openbible.info data, real
YouVersion translations, real Anthropic model calls where noted), driving
the real, already-installed system Chrome — not a mocked or stubbed
environment. 32 tests across five spec files, all passing as of this
report. Full pass/fail detail and what's covered vs. explicitly deferred
is in `CHECKLIST.md`; every real finding (fixed or open) is in `BUGS.md`.
This file is the synthesis of both.

## Headline result

**Two real bugs found, both fixed, both verified fixed. One follow-up
security recommendation (a nonce-based CSP) built as a dedicated piece of
work and verified live, page by page.** Nothing else broke. The full
pre-existing unit suite is unaffected by any change made during this QA
pass.

## What was tested, and how

| Area | File | Tests | Result |
|---|---|---|---|
| Navigation & standalone pages | `navigation.spec.js` | 13 | 13/13 ✅ |
| Accessibility (axe-core) | `accessibility.spec.js` | 5 | 5/5 ✅ |
| Core chat flow (real Anthropic calls) | `chat-flow.spec.js` | 3 | 3/3 ✅ |
| Responsive/visual (320–1440px) | `responsive.spec.js` | 3 | 3/3 ✅ |
| Security | `security.spec.js` | 9 | 9/9 ✅ |
| CSP regression (browser-level) | `csp.spec.js` | 10 | 10/10 ✅ |

Plus 6 new nonce/CSP-mechanics tests in `test/server.test.mjs` (the
existing unit suite, real HTTP requests against a real running server —
not a Playwright file, but part of the same CSP verification effort).
42 Playwright tests total, all passing, alongside a 341-test unit suite.

Real-Anthropic-calling tests were deliberately kept to a small,
representative set (this is a live, billed app — see `docs/STATE.md`).
Every individual tool's own logic already has thorough real unit-test
coverage with stubbed Anthropic responses (`test/chat.test.mjs`); the
job of this E2E layer is confirming the real integration renders
correctly end to end, not re-proving each tool's logic a second time at
extra real cost.

**Not automated, but each verified live (with screenshots) during its own
implementation earlier this session** — see the corresponding
2026-09-22/23 entries in `docs/DECISIONS.md` for exactly what was checked
and what the output looked like: Alphabet Mode's per-word breakdown, the
manuscript-variant significance note, the Passage Briefing card,
Word-Study Web's sense-clustering, Cross-Reference type labels,
Observe/Interpret/Apply, Reel Kit's image generation (including the
canvas→PNG step itself), and the select-anywhere popover (both desktop
drag-select and 375px mobile). These are real, working, already-verified
features — "not yet automated" here means exactly that, not "untested."

**Explicitly out of scope for this pass**: anything requiring a real,
signed-in Supabase account (Study export, Study Trail, agent naming,
reading plans, notes, home-tradition setting). Creating a real test
account is a prohibited unattended action under this session's own
standing safety rules — the same reason it wasn't done during Phase 2's
live verification either. What *is* covered instead: the signed-out/
free-tier state renders correctly (the right lock/upsell messaging, no
crash, no data leak) for every one of these features, and the real
signed-in code paths already have thorough coverage via stubbed-Supabase
unit tests in `test/server.test.mjs`/`test/supabase.test.mjs`, which
exercise the real PostgREST/Auth REST request/response contract rather
than this module's own internals.

## Findings

### Fixed

1. **Chat input lost its accessible name after the first message.**
   `#chat-input`'s only accessible name came from its `placeholder`
   attribute; `clearInputPlaceholder()` blanks that the moment a first
   message is sent, so a screen-reader user lost the field's name
   entirely partway through a real conversation — not on first load,
   which is exactly why a plain "does the home page pass axe" check
   didn't catch it. Fixed with a permanent `aria-label="Message"`,
   independent of placeholder state. Verified: 0 critical/serious axe
   violations on a loaded conversation, before and after re-checked.

2. **No security response headers were set on any route.** No
   `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, or
   `Content-Security-Policy` anywhere — confirmed with a plain `curl -D -`.
   Added the three that are safe to set unconditionally
   (`nosniff`/`DENY`/`strict-origin-when-cross-origin`) globally.

Full writeups, including exact repro and verification steps, in
`BUGS.md`.

### Follow-up completed: nonce-based Content-Security-Policy

The "no CSP" recommendation above was built as a dedicated follow-up
(2026-09-24): a fresh, unguessable nonce generated per request, stamped
onto every real `<script>` tag, with a matching `Content-Security-Policy`
header. The audit that made this possible found index.html actually has
*no* inline `<script>`/`<style>` **tags** at all (every script is
`src="..."`) — the real inline content was two `style="..."` **attributes**
in dynamically-rendered chart/diagram markup, which nonces can't cover at
all (that's an element-level mechanism, not an attribute-level one).
Both were converted to plain `data-*` attributes with the real value
applied via the CSSOM after insertion, which is what let `style-src` end
up as a strict `'self'` with no `'unsafe-inline'` needed anywhere.

Verified two ways: (1) automated — `test/server.test.mjs` checks the
nonce mechanics against real HTTP responses, `qa/tests/csp.spec.js`
registers a real `securitypolicyviolation` listener and drives it across
every static page, a hard refresh on each, the site menu, the service
worker, and Reel Kit's blob: image path, and `chat-flow.spec.js`'s
existing real-call tests were extended to check for violations and to
confirm the CSSOM-set styles hold real values, not blank ones; (2) manual
— every real page console-checked live via a separate browser context,
plus a direct `curl -D -` against the real dev server confirming the
actual configured Supabase origin is correctly interpolated into
`connect-src`. Full reasoning and the complete directive-by-directive
audit in `docs/DECISIONS.md`'s 2026-09-24 entry.

### Non-findings worth stating plainly

- **Responsive**: zero layout issues found from 320px through 1440px, on
  both the home view and a loaded conversation with real gathered
  content — including an SVG cross-reference diagram, which held up at
  320px without any adjustment needed. This reflects real, deliberate
  mobile-polish work already done in earlier sessions (see
  `docs/STATE.md`'s own note on this), not luck.
- **Accessibility**: zero critical/serious axe violations anywhere
  scanned (home, `/today`, `/sources`, the open site menu, a loaded
  conversation) once the one real finding above was fixed. The
  deliberate, documented `chatInput.focus({ preventScroll: true })`
  behavior on the home view (focus lands directly on the primary input on
  load, specifically so a keyboard/screen-reader user doesn't have to tab
  through nav chrome first) was confirmed to actually work as intended,
  not just as commented.
- **Security**: no secrets found in page source or any API response;
  every protected route correctly rejects an unauthenticated request
  (401), except the one deliberate, documented exception
  (`GET /api/outlines`, which returns 200 with `locked: true` and no real
  data by design — confirmed no data leak there either); a real chat
  message framed as a prompt-injection attempt didn't break rendering or
  surface recognizable tool-schema internals (a spot-check of behavior,
  not a provable-absent guarantee — the real defense is architectural,
  per `lib/chat.js`'s own system prompt).
- **XSS**: an `<img onerror>` payload sent as a real chat message,
  round-tripped through the real model and rendered by the real frontend,
  never executed — confirming the `textContent`/`escapeHtml()` rendering
  convention this app relies on throughout actually holds under a real
  adversarial input, not just a synthetic unit-test string.

## Tooling added (QA-only, never shipped to production)

- `@playwright/test` — configured to drive the real system Chrome
  (`channel: "chrome"`), installed with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
  so it never tries to download its own bundled browser.
- `@axe-core/playwright` — a second QA-only dependency, not originally
  named in the spec's own instructions; added and documented per this
  session's "use your judgment, document it" standing instruction rather
  than silently, since manual accessibility auditing across a dozen pages
  isn't a serious substitute for the standard tool built for exactly this.

Both are `devDependencies` only; nothing in `server.js` or `lib/` imports
either, and Render's production build never installs devDependencies.

## Suggested next steps (not done in this pass)

1. Automating the "verified live but not yet automated" list above as
   real Playwright specs, budgeted against real-API cost the same way
   this pass's `chat-flow.spec.js` was.
2. A real signed-in-account E2E pass, if and when there's a sanctioned
   way to provision a disposable test account without this session
   creating one unattended.
3. If this app ever adds a feature that needs to dynamically inject a
   `<script>` tag or render an inline `<style>` block, revisit
   `buildContentSecurityPolicy()` in `server.js` — the current policy's
   `'strict-dynamic'` already covers the former case, but a genuinely new
   inline `<style>` block would need its own nonce added to
   `stampScriptNonces()`'s sibling logic (not written yet, since nothing
   needs it today).
