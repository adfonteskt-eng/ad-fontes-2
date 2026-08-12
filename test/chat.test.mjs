// lib/chat.js: the tool-dispatch loop (all three tools, chained, against
// real local STEPBible data) and the bounded session store (idle TTL +
// max-count LRU eviction). The Anthropic call itself is stubbed throughout
// — nothing here needs a real API key or network access.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { chatTurn, getSessionCount, clearSession } from "../lib/chat.js";

let realFetch;

before(() => {
  realFetch = globalThis.fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  Date.now = Date.now; // no-op; real Date.now is restored per-test below
});

test("chains search_lexicon -> find_occurrences -> gather_passage against real data", async () => {
  let step = 0;
  const seenToolResults = [];

  globalThis.fetch = async (url, opts) => {
    const href = url.toString();
    if (href !== "https://api.anthropic.com/v1/messages") {
      throw new Error(`unexpected fetch: ${href}`);
    }
    const body = JSON.parse(opts.body);
    const last = body.messages[body.messages.length - 1];
    if (Array.isArray(last?.content)) {
      for (const block of last.content) {
        if (block.type === "tool_result") seenToolResults.push(block.content);
      }
    }

    step++;
    if (step === 1) {
      return jsonResponse({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "search_lexicon", input: { keyword: "love" } }],
      });
    }
    if (step === 2) {
      return jsonResponse({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t2", name: "find_occurrences", input: { strongsNumber: "G0025", limit: 5 } }],
      });
    }
    if (step === 3) {
      return jsonResponse({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t3", name: "gather_passage", input: { reference: "1CO.13.4" } }],
      });
    }
    return jsonResponse({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Agape love, as in 1 Corinthians 13:4, is patient and kind." }],
    });
  };

  const result = await chatTurn({
    message: "What does the Bible say about love?",
    appKey: "test",
    apiKey: "fake-key",
  });

  assert.equal(step, 4, "expected 3 tool-use turns plus a final text turn");
  assert.match(seenToolResults[0], /G0025/, "search_lexicon result should surface the real Strong's number");
  assert.match(seenToolResults[1], /MAT\.|MRK\.|LUK\.|JHN\./, "find_occurrences should return real NT references");
  assert.match(seenToolResults[2], /love/i, "gather_passage result should contain the real 1 Cor 13:4 content");
  assert.ok(
    result.gathered.some((g) => g.reference.usfm === "1CO.13.4"),
    "the gathered array returned to the frontend should include 1CO.13.4",
  );
  assert.ok(result.reply.length > 0);
});

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

function stubEndTurn() {
  globalThis.fetch = async () =>
    jsonResponse({ stop_reason: "end_turn", content: [{ type: "text", text: "stub reply" }] });
}

test("session store: idle expiration, max-count cap, and LRU-correct eviction", async () => {
  const realDateNow = Date.now.bind(Date);
  let fakeNow = realDateNow();
  Date.now = () => fakeNow;
  stubEndTurn();

  const opts = { appKey: "k", apiKey: "fake" };

  try {
    const { sessionId: a } = await chatTurn({ message: "hello", ...opts });
    assert.ok(getSessionCount() >= 1);

    fakeNow += 2 * 60 * 60 * 1000 + 1; // past the 2h idle TTL
    const { sessionId: aAgain } = await chatTurn({ sessionId: a, message: "still there?", ...opts });
    assert.notEqual(aAgain, a, "an idle-expired session should not be recognized");

    // --- max-count cap ---
    fakeNow = realDateNow();
    clearSession(a);
    clearSession(aAgain);

    const SESSION_MAX_COUNT = 500; // mirrors lib/chat.js's internal constant
    const ids = [];
    for (let i = 0; i < SESSION_MAX_COUNT; i++) {
      const { sessionId } = await chatTurn({ message: `msg ${i}`, ...opts });
      ids.push(sessionId);
      fakeNow += 1;
    }
    assert.equal(getSessionCount(), SESSION_MAX_COUNT);

    // Touch the first session so it's no longer the least-recently-active.
    await chatTurn({ sessionId: ids[0], message: "touch", ...opts });
    fakeNow += 1;

    // One more brand-new session pushes past the cap.
    await chatTurn({ message: "overflow", ...opts });
    assert.equal(getSessionCount(), SESSION_MAX_COUNT, "cap should hold even right after an overflow");

    const stillAlive = await chatTurn({ sessionId: ids[0], message: "still here?", ...opts });
    assert.equal(stillAlive.sessionId, ids[0], "the recently-touched session should survive eviction");

    const evicted = await chatTurn({ sessionId: ids[1], message: "gone?", ...opts });
    assert.notEqual(evicted.sessionId, ids[1], "the never-touched-again session should be the one evicted");
  } finally {
    Date.now = realDateNow;
  }
});
