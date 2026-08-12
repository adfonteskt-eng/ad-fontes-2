// lib/chat.js: the tool-dispatch loop (all three tools, chained, against
// real local STEPBible data) and the bounded session store (idle TTL +
// max-count LRU eviction). The Anthropic call itself is stubbed throughout
// — nothing here needs a real API key or network access.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { chatTurn, getSessionCount, clearSession, trimHistory } from "../lib/chat.js";

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

// --- trimHistory() boundary safety ---------------------------------------
// A real bug found this session: a naive slice(length - MAX_HISTORY_MESSAGES)
// can cut in the middle of a tool_use/tool_result exchange, leaving a
// tool_result whose matching tool_use was trimmed away. Anthropic's real API
// rejects that outright — the whole session's next turn would 400 instead of
// just losing old context, which is a much worse failure than the trim was
// supposed to prevent.

function userTurn(text) {
  return { role: "user", content: text };
}
function assistantToolUse(id) {
  return { role: "assistant", content: [{ type: "tool_use", id, name: "gather_passage", input: {} }] };
}
function userToolResult(id) {
  return { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "stub" }] };
}
function assistantText(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

test("trimHistory never separates a tool_use from its tool_result", () => {
  // Build 15 turns, each: user text -> assistant tool_use -> user
  // tool_result -> assistant text. 60 messages total, comfortably over
  // MAX_HISTORY_MESSAGES (30), and shaped so a naive slice from the end
  // would land mid-exchange for most cut points.
  const messages = [];
  for (let i = 0; i < 15; i++) {
    messages.push(userTurn(`question ${i}`));
    messages.push(assistantToolUse(`tool-${i}`));
    messages.push(userToolResult(`tool-${i}`));
    messages.push(assistantText(`answer ${i}`));
  }

  const trimmed = trimHistory(messages);

  assert.ok(trimmed.length < messages.length, "should actually trim something");
  assert.equal(trimmed[0].role, "user");
  assert.equal(typeof trimmed[0].content, "string", "must start at a real turn boundary, not a tool_result array");

  // No tool_result anywhere in the trimmed history may reference a
  // tool_use id that isn't present earlier in that same trimmed array.
  const seenToolUseIds = new Set();
  for (const message of trimmed) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use") seenToolUseIds.add(block.id);
      if (block.type === "tool_result") {
        assert.ok(
          seenToolUseIds.has(block.tool_use_id),
          `tool_result for ${block.tool_use_id} has no matching tool_use in the trimmed history`,
        );
      }
    }
  }
});

test("trimHistory leaves short history untouched", () => {
  const messages = [userTurn("hi"), assistantText("hello")];
  assert.equal(trimHistory(messages), messages);
});

test("trimHistory doesn't destroy everything when no safe boundary exists in the window", () => {
  // A pathological single turn longer than MAX_HISTORY_MESSAGES with no
  // turn-start boundary anywhere past the naive cut point — trimHistory
  // must not cut down to an empty (or broken) array just to hit the cap.
  const messages = [userTurn("one giant turn")];
  for (let i = 0; i < 40; i++) {
    messages.push(assistantToolUse(`tool-${i}`));
    messages.push(userToolResult(`tool-${i}`));
  }
  const trimmed = trimHistory(messages);
  assert.ok(trimmed.length > 0, "should never trim down to nothing");
  assert.equal(trimmed[0].role, "user");
  assert.equal(typeof trimmed[0].content, "string");
});

test("a long real conversation with tool calls never produces a malformed request", async () => {
  // End-to-end version of the same check, through the real chatTurn() loop
  // rather than calling trimHistory() directly — confirms the fix actually
  // takes effect in the real code path, not just in isolation.
  let step = 0;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const first = body.messages[0];
    assert.ok(
      !(Array.isArray(first?.content) && first.content.some((b) => b.type === "tool_result")),
      `request #${step} started with an orphan tool_result`,
    );
    for (let i = 0; i < body.messages.length; i++) {
      if (i > 0) {
        assert.notEqual(body.messages[i - 1].role, body.messages[i].role, `consecutive same-role messages at index ${i}`);
      }
    }

    step++;
    if (step % 2 === 1) {
      return jsonResponse({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: `t${step}`, name: "gather_passage", input: { reference: "JHN.3.16" } }],
      });
    }
    return jsonResponse({ stop_reason: "end_turn", content: [{ type: "text", text: `reply ${step}` }] });
  };

  let sessionId;
  for (let i = 0; i < 15; i++) {
    const result = await chatTurn({ sessionId, message: `question ${i}`, appKey: "k", apiKey: "fake" });
    sessionId = result.sessionId;
  }
  assert.ok(step > 15, "expected more than one request per turn across 15 turns");
});
