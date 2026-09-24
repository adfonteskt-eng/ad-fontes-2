# Phase 3 QA findings

One entry per real finding, newest at the top. Not a wishlist — only
things actually observed while running the suite in `qa/tests/` or during
manual live verification alongside it. "No findings yet" sections below
mean exactly that, not "not checked" (see `CHECKLIST.md` for what's been
run).

## Fixed

### 1. Chat input loses its accessible name after the first message (axe: "label")

**Found by**: `qa/tests/chat-flow.spec.js`'s accessibility scan on a loaded
conversation.

**What was wrong**: `#chat-input` (the `<textarea>`) had no `aria-label`,
`<label>`, or `title` — its only accessible name came from its
`placeholder` attribute. `clearInputPlaceholder()` (public/app.js) sets
`chatInput.placeholder = ""` the moment a first message is sent, so from
that point on the field has literally no accessible name at all for a
screen-reader user, even though it's visually obvious (it's right there,
empty, next to "Send"). The home view's own a11y scan passed cleanly
specifically because the placeholder was still present at that point —
the bug only shows up once a conversation is actually underway, which is
exactly why a plain "does the home page pass axe" check didn't catch it,
but a real chat-flow scan did.

**Fix**: added a permanent `aria-label="Message"` to `#chat-input` in
`public/index.html`, independent of the placeholder's own state.

**Verified**: re-ran the same chat-flow accessibility scan after the fix —
0 critical/serious violations on a loaded conversation.

### 2. No security response headers set at all

**Found by**: a plain `curl -D -` against a running server while writing
`qa/tests/security.spec.js`'s security-header checks — not something axe
or a functional test surfaces, since it's about HTTP response headers,
not page content.

**What was wrong**: no `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, or `Content-Security-Policy` header on any route.

**Fix**: added the three safe-to-add-unconditionally headers
(`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`) globally, via one
`res.setHeader()` call at the very top of `server.js`'s request handler
(Node merges headers set this way into whatever `writeHead()` a specific
route handler later calls, so this needed touching only one place, not
every `res.writeHead()` call site in the file).

**Deliberately NOT fixed here**: a real `Content-Security-Policy`. This
app has no build step and relies on inline `<script>`/`<style>`
throughout `public/index.html` by design — a CSP would need either
`'unsafe-inline'` (which defeats most of what CSP is for) or a real
nonce-based rework of every inline tag, which is its own separate piece
of work deserving a dedicated pass with its own testing, not something to
bolt on inside a QA pass. Recorded as an explicit, open recommendation in
`REPORT.md`, not silently dropped.

**Verified**: `curl -D -` against both a page route and an API route
confirmed all three headers present; a new Playwright test asserts the
same for both response types; the full existing 335-test unit suite and
the rest of the Playwright suite are unaffected.

### 3. (Not a bug — the deferred CSP recommendation from finding #2, now built)

**What was done**: a real, nonce-based `Content-Security-Policy`, generated
fresh per request. Full writeup — the directive-by-directive reasoning,
the two inline `style="..."` attributes found and converted to CSSOM-set
styles so `style-src` could stay strict, and every verification step — is
in `docs/DECISIONS.md`'s 2026-09-24 entry, since it's substantial enough
to belong there rather than duplicated here. This entry exists so
`BUGS.md`'s own numbering stays a complete, chronological record of every
real thing found and acted on during this QA pass, not just the ones that
were technically "bugs."

**Verified**: `test/server.test.mjs` (6 new tests, real HTTP requests) +
`qa/tests/csp.spec.js` (10 new tests, a real `securitypolicyviolation`
listener across every real page) + CSP-violation assertions added to
`chat-flow.spec.js`'s existing real-call tests — 42/42 Playwright tests
and the full 341-test unit suite passing. Also manually verified live via
the sandboxed Browser pane (console-checked on every static page
independently of the automated suite) and a direct `curl -D -` against
the real dev server confirming the live, real Supabase project origin is
correctly interpolated into `connect-src`.
