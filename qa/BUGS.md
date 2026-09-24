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
