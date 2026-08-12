// lib/summarize.js: the one-shot Phase 2 summary call. Mainly here to lock
// in the fetchWithTimeout wiring (this call site was missed when timeouts
// were added everywhere else — a stalled Anthropic response used to hang
// the CLI and GET /api/passage indefinitely) and the TAKEAWAY/STUDY NOTES
// section-splitting logic. Network is stubbed throughout.
import { test } from "node:test";
import assert from "node:assert/strict";

import { summarizePassage, formatGatheredPassage } from "../lib/summarize.js";

const SAMPLE_GATHERED = {
  reference: { usfm: "JHN.3.16" },
  translations: [{ translation: { abbr: "BSB" }, content: "For God so loved the world...", error: null }],
  originalLanguage: { type: "greek", words: [], hebrewVerseRef: null, book: "Jhn" },
  commentary: { entries: [] },
};

test("summarizePassage is wired through fetchWithTimeout, not a bare fetch", async () => {
  // This call site was missed when timeouts were added everywhere else in
  // an earlier pass — a stalled Anthropic response used to hang the CLI and
  // GET /api/passage indefinitely. fetchWithTimeout's own timing behavior
  // is already covered in test/fetch-timeout.test.mjs; what matters here is
  // confirming summarizePassage actually routes through it rather than a
  // bare fetch() — which we can check directly, since only fetchWithTimeout
  // attaches an AbortSignal to the request.
  const realFetch = globalThis.fetch;
  let receivedSignal = null;
  globalThis.fetch = async (url, opts) => {
    receivedSignal = opts.signal;
    return { ok: true, json: async () => ({ content: [{ text: "stub" }] }) };
  };

  try {
    await summarizePassage(SAMPLE_GATHERED, { apiKey: "fake" });
    assert.ok(receivedSignal instanceof AbortSignal, "expected fetchWithTimeout to attach an AbortSignal");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("summarizePassage splits TAKEAWAY and STUDY NOTES sections", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      content: [
        {
          text: "## TAKEAWAY\nGod loves the world.\n\n## STUDY NOTES\nSome translations render this differently.",
        },
      ],
    }),
  });

  try {
    const { shortSummary, studyNotes } = await summarizePassage(SAMPLE_GATHERED, { apiKey: "fake" });
    assert.equal(shortSummary, "God loves the world.");
    assert.equal(studyNotes, "Some translations render this differently.");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("summarizePassage surfaces the whole response when markers are missing rather than dropping it", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ content: [{ text: "The model just wrote prose with no markers at all." }] }),
  });

  try {
    const { shortSummary, studyNotes } = await summarizePassage(SAMPLE_GATHERED, { apiKey: "fake" });
    assert.equal(shortSummary, "The model just wrote prose with no markers at all.");
    assert.equal(studyNotes, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("summarizePassage rejects when ANTHROPIC_API_KEY is missing, without calling fetch", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("fetch should not be called without an API key");
  };
  try {
    await assert.rejects(() => summarizePassage(SAMPLE_GATHERED, {}), /ANTHROPIC_API_KEY/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("formatGatheredPassage omits sections with no usable content", () => {
  const text = formatGatheredPassage({
    reference: { usfm: "JHN.3.16" },
    translations: [{ translation: { abbr: "BSB" }, content: null, error: "fetch failed" }],
    originalLanguage: { type: "greek", words: [] },
    commentary: { entries: [] },
  });
  assert.match(text, /Bible reference: JHN\.3\.16/);
  assert.doesNotMatch(text, /BSB/, "an all-errored translation list should be omitted, not shown as empty");
});
