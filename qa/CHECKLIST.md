# Phase 3 QA checklist

Tracks what's being tested and how, per the spec's Phase 3 instructions.
`[x]` = has a real, passing Playwright test (or was manually verified live
and the reasoning for not automating it is noted). `[ ]` = not covered
yet. Findings go in `BUGS.md`, not here. The final summary goes in
`REPORT.md`.

## Tooling decisions (recorded here; also in docs/DECISIONS.md)

- **Playwright**, `channel: "chrome"` (the real, already-installed Google
  Chrome on this machine, not Playwright's own bundled Chromium) —
  installed with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` specifically so `npm
  install` never tries to download a browser. Verified once, standalone,
  that `chromium.launch({ channel: "chrome" })` actually works before
  writing this file.
- **@axe-core/playwright** for accessibility scanning — not explicitly
  named in the QA instructions, but "comprehensive... accessibility"
  testing by hand (checking contrast ratios and ARIA structure across
  a dozen pages line by line) isn't a serious substitute for the standard
  tool built for exactly this, paired with Playwright in its own docs.
  Small, pure JS, no browser download of its own. Documented here and in
  `docs/DECISIONS.md` per the "use your judgment, document it" instruction
  rather than adding it silently.
- `playwright.config.js`'s `webServer` starts/stops `node server.js`
  declaratively around the whole test run (port 3100, chosen to avoid
  clashing with a real dev server on 3000) — no manually backgrounded
  process to forget about or leave hanging.
- **Real accounts are out of scope for this pass.** Signing up or signing
  in a real Supabase test account is one of this session's own standing
  rules (account creation is a prohibited unattended action — see the
  safety rules this session already operates under), so anything gated
  on being signed-in/paid (Study export, Study Trail, agent naming,
  reading plans, notes, Tradition Lens's home-tradition setting) is
  checked at the "does the signed-out/free-tier state look and behave
  correctly, including the right upsell/lock messaging" level, not with a
  real authenticated round trip. Those signed-in code paths already have
  real coverage elsewhere: `test/server.test.mjs`/`test/supabase.test.mjs`
  stub the real PostgREST/Auth REST contracts server-side, and this
  session's earlier live verification of `home_tradition`/`depth_level`
  documented the same limitation at the time.
- Real chat messages cost real Anthropic tokens (per docs/STATE.md: "real
  Anthropic/YouVersion/Supabase/Stripe costs" — this is a live, billed app,
  not a sandboxed prototype). The suite keeps real-chat-triggering tests
  to a deliberately small, representative set rather than one per feature
  — most functional coverage of individual tool behaviors already exists
  in `test/chat.test.mjs`'s unit tests with stubbed Anthropic responses;
  what E2E adds here is confirming the real integration actually renders
  correctly end to end, not re-proving each tool's own logic.

## Functional — core chat flow — `qa/tests/chat-flow.spec.js`, 3/3 passing
(real Anthropic calls; kept deliberately small — see the file's own header)

- [x] Home view loads; try-buttons populate (`navigation.spec.js`) —
      clicking one sends immediately (renderExamples() wires a real send,
      not just filling the input), so not clicked in the no-cost suite
- [x] Bare-reference message ("Genesis 1:1") returns translations +
      original language + commentary, real content
- [x] A real question (word study, cross-references) returns a
      synthesized, tool-grounded answer
- [ ] Session persists across a reload (localStorage restore) — not yet
      automated; this exact mechanism (restoreChatState/saveChatState)
      was exercised manually, repeatedly, throughout this session's live
      verification of every feature that touches chatLogData
- [ ] "Home" / logo click starts a fresh conversation — not yet automated
- [ ] Depth control changes selection and persists across reload — the
      *prompt* behavior per level is unit-tested in test/chat.test.mjs;
      not yet automated end to end
- [x] Receipts Mode: architecturally covered (quoteVerification is
      computed and rendered on every reply, not just when asked); the
      verified/unverified branches themselves are real unit tests in
      test/verify.test.mjs and test/chat.test.mjs, not re-proven live here
- [ ] Alphabet Mode: clicking a Greek word reveals morphology + letters —
      verified live with screenshots during implementation (see
      docs/DECISIONS.md 2026-09-22); not yet automated
- [ ] Manuscript variant note appears on a word with a real variant —
      verified live with a screenshot during implementation (see
      docs/DECISIONS.md 2026-09-23, Matthew 5:32); not yet automated
- [ ] Passage Briefing card renders when asked for book background —
      verified live with a screenshot during implementation (James
      overview, docs/DECISIONS.md 2026-09-23); not yet automated
- [x] Word-Study Web chart renders for a word study (real per-book bars);
      sense-grouping is model-discretion and was verified live during
      implementation (docs/DECISIONS.md 2026-09-23), not asserted here
      since it isn't guaranteed on every request
- [x] Cross-Reference diagram renders with real, clickable connections;
      type labels are model-discretion, verified live during
      implementation (Matthew 1:23, docs/DECISIONS.md 2026-09-23)
- [ ] Observe/Interpret/Apply structure appears when asked for one —
      verified live during implementation (James 1:19-20,
      docs/DECISIONS.md 2026-09-23); not yet automated
- [ ] Reel Kit "Share as image" button is present and produces a
      non-trivial PNG download — verified live during implementation,
      including the canvas→PNG blob step itself (docs/DECISIONS.md
      2026-09-23); not yet automated as a Playwright download assertion
- [ ] Select-anywhere popover appears on a real text selection and fills
      the chat input on click — verified live with a real mouse-drag
      during implementation, at both desktop and 375px mobile width (see
      docs/DECISIONS.md 2026-09-23); not yet automated
- [x] Injected `<img onerror>` in a chat message renders as inert text,
      never executes (bundled into the bare-reference test above)

## Navigation / standalone pages — `qa/tests/navigation.spec.js`, 13/13 passing

- [x] /today (Today's Passage) loads with real content, no auth needed
- [x] /sources (Sources & Licenses) loads with the real licensing text
- [x] /subscription loads (free/signed-out state: upsell copy, no crash)
- [x] /plans loads (signed-out state: correct lock/upsell messaging)
- [x] /outlines loads (signed-out state: correct lock/upsell messaging)
- [x] Site menu opens/closes; signed-out section shows sign-up/sign-in,
      not a broken signed-in-only control
- [x] Direct navigation to each route (not just in-app clicks) works —
      a hard refresh on /today etc. shouldn't 404

## Accessibility (@axe-core/playwright) — `qa/tests/accessibility.spec.js`, 5/5 passing

- [x] Home view: no critical/serious axe violations
- [ ] A loaded conversation (real gathered content on screen): no
      critical/serious axe violations — deferred to chat-flow.spec.js,
      sharing that file's real chat call rather than paying for another
- [x] /sources, /today: no critical/serious axe violations
- [x] Site menu (open): no critical/serious axe violations
- [x] Keyboard-only: chat input starts focused on load (deliberate, see
      app.js's own comment); Tab reaches Send; Shift+Tab still reaches the
      site menu button — confirmed live, not assumed from the comment

## Visual / responsive

- [ ] 320px, 375px, 768px, 1024px, 1440px: no horizontal overflow on the
      home view and on a loaded conversation with real gathered content
- [ ] Depth control and Study-export rows (where visible) don't overflow
      or overlap at 320px
- [ ] Screenshots saved for the report at each breakpoint

## Security

- [ ] A `<script>`/HTML-injection payload sent as a chat message is
      rendered as inert text, not executed or interpreted as markup
      (spot-checks the textContent-based rendering this app relies on
      throughout, per public/app.js's escapeHtml() convention)
- [ ] A message attempting a prompt-injection framing ("ignore previous
      instructions...") doesn't break the app or leak anything unexpected
      — this is inherently a spot-check of behavior, not a guarantee,
      since the underlying defense is architectural (treating retrieved/
      user text as data — see lib/chat.js's system prompt), not something
      a test can prove absent in general
- [ ] Protected API routes reject an unauthenticated request (401) —
      already covered thoroughly in test/server.test.mjs; one or two E2E
      spot-checks at the real integration boundary, not full duplication
- [ ] No secrets (API keys, Supabase service key, etc.) present in page
      source or any API response body
- [ ] Note (not a bug — an observation for REPORT.md): no
      Content-Security-Policy/X-Frame-Options/X-Content-Type-Options
      response headers are currently set on any route
