// lib/chat.js: the tool-dispatch loop (chained across the base tools,
// against real local STEPBible data) and the bounded session store (idle TTL +
// max-count LRU eviction). The Anthropic call itself is stubbed throughout
// — nothing here needs a real API key or network access.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { access, rename } from "node:fs/promises";

import { chatTurn, getSessionCount, clearSession, trimHistory } from "../lib/chat.js";
import { dataFile } from "../scripts/fetch-data.js";
import { BSB_FILE, clearBibleSearchCache } from "../lib/bible-search.js";

// Whether data/bsb.txt actually exists depends on whether `npm run
// fetch-data` has run somewhere with network access to bereanbible.com --
// true in CI, not necessarily true in every sandbox (see test/bible-
// search.test.mjs's header comment for the same issue there). The
// search_bible_text "missing data" test below uses this to force that
// state deterministically rather than assuming it.
const REAL_BSB_PATH = dataFile(BSB_FILE);
const MOVED_ASIDE_PATH = dataFile(`${BSB_FILE}.test-backup`);

async function withBsbFileMissing(fn) {
  let movedAside = false;
  try {
    await access(REAL_BSB_PATH);
    await rename(REAL_BSB_PATH, MOVED_ASIDE_PATH);
    movedAside = true;
  } catch {
    // Already missing in this environment -- nothing to move.
  }
  clearBibleSearchCache();
  try {
    await fn();
  } finally {
    if (movedAside) await rename(MOVED_ASIDE_PATH, REAL_BSB_PATH);
    clearBibleSearchCache();
  }
}

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

test("search_bible_text tool call reports a friendly error, not a crash, when data/bsb.txt hasn't been downloaded", async () => {
  // Whether data/bsb.txt actually exists depends on the environment (see
  // the withBsbFileMissing() setup above), so this forces the "not yet
  // fetched" state deterministically rather than assuming it — the turn
  // should still complete normally either way (Claude sees the error as a
  // tool_result and can react to it), not throw all the way out of
  // chatTurn().
  await withBsbFileMissing(async () => {
    let step = 0;
    let sawToolResult = null;

    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      step++;
      if (step === 1) {
        return jsonResponse({
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "t1", name: "search_bible_text", input: { query: "still small voice" } }],
        });
      }
      const last = body.messages[body.messages.length - 1];
      sawToolResult = last.content[0].content;
      return jsonResponse({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "I wasn't able to search the full Bible text." }],
      });
    };

    const result = await chatTurn({ message: "What's the verse about the still small voice?", appKey: "k", apiKey: "fake" });

    assert.equal(step, 2);
    assert.match(sawToolResult, /fetch-data/, "the tool_result should surface the friendly BSB_NOT_DOWNLOADED message");
    assert.ok(result.reply.length > 0, "the turn should still complete with a reply, not throw");
  });
});

// --- Prompt caching --------------------------------------------------------
// Verifies the actual request shape sent to Anthropic, per their documented
// "automatic caching" contract: a single top-level cache_control field with
// an explicit ttl. This can't verify real-world cost savings (that needs
// live API usage stats — cache_read_input_tokens / cache_creation_input_tokens
// in the response, not available to a stub), but it does lock in that the
// field is actually present and shaped correctly, so a future refactor can't
// silently drop it.
test("callAnthropic requests automatic prompt caching with a 1h TTL", async () => {
  let capturedBody = null;
  globalThis.fetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return jsonResponse({ stop_reason: "end_turn", content: [{ type: "text", text: "stub reply" }] });
  };

  await chatTurn({ message: "hello", appKey: "k", apiKey: "fake" });

  assert.ok(capturedBody, "expected a request to have been sent");
  assert.deepEqual(
    capturedBody.cache_control,
    { type: "ephemeral", ttl: "1h" },
    "expected top-level automatic-caching field per Anthropic's documented request shape",
  );
  // Sanity check this is actually placed correctly relative to system/tools
  // per the docs ("references the entire prompt - tools, system, and
  // messages (in that order) up to and including the block designated with
  // cache_control") — system and tools must both be present for there to be
  // anything worth caching.
  assert.ok(capturedBody.system, "system prompt must be present for caching to have any effect");
  assert.ok(Array.isArray(capturedBody.tools) && capturedBody.tools.length === 4);
});

// --- Compounding study memory (userId) --------------------------------
// A stub covering both endpoints a signed-in turn can hit: Anthropic
// (as above) and Supabase's PostgREST (study_entries reads/writes) --
// distinguished by URL, same approach as every other multi-endpoint stub
// in this project's tests (see test/supabase.test.mjs for the same
// contract tested in isolation).
function stubSupabaseEnv() {
  process.env.SUPABASE_URL = "https://fake-project.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_fake";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_fake";
}

function clearSupabaseEnv() {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  delete process.env.SUPABASE_SECRET_KEY;
}

test("anonymous chat (no userId) never touches Supabase, even if it's configured", async () => {
  stubSupabaseEnv();
  try {
    globalThis.fetch = async (url, opts) => {
      const href = url.toString();
      if (href !== "https://api.anthropic.com/v1/messages") {
        throw new Error(`unexpected fetch to ${href} for an anonymous request`);
      }
      const body = JSON.parse(opts.body);
      assert.equal(body.tools.length, 4, "no userId means no search_study_history tool, but the 4 base tools are always present");
      return jsonResponse({ stop_reason: "end_turn", content: [{ type: "text", text: "reply" }] });
    };
    await chatTurn({ message: "What does Psalm 23:1 mean?", appKey: "k", apiKey: "fake" });
  } finally {
    clearSupabaseEnv();
  }
});

test("a signed-in user gets a 5th tool (search_study_history), and calling it hits PostgREST", async () => {
  stubSupabaseEnv();
  try {
    let step = 0;
    let sawStudyHistoryRequest = false;

    globalThis.fetch = async (url, opts) => {
      const href = url.toString();
      if (href === "https://api.anthropic.com/v1/messages") {
        const body = JSON.parse(opts.body);
        assert.equal(body.tools.length, 5, "a signed-in user should see all five tools");
        assert.ok(
          body.tools.some((t) => t.name === "search_study_history"),
          "search_study_history should be in the tools list",
        );
        step++;
        if (step === 1) {
          return jsonResponse({
            stop_reason: "tool_use",
            content: [{ type: "tool_use", id: "t1", name: "search_study_history", input: { keyword: "love" } }],
          });
        }
        return jsonResponse({ stop_reason: "end_turn", content: [{ type: "text", text: "Based on your past study..." }] });
      }

      const parsed = new URL(href);
      // chatTurn checks whether this signed-in user is on the paid tier
      // (for the "name your agent" feature -- see getAgentNameIfPaid in
      // lib/supabase.js) before every turn, regardless of what the turn is
      // actually about -- an empty result here just means "not paid, no
      // custom name," which is what every test in this file wants unless
      // it's specifically testing that feature.
      if (parsed.pathname === "/rest/v1/profiles") {
        return { ok: true, status: 200, text: async () => "[]" };
      }
      if (parsed.pathname === "/rest/v1/study_entries") {
        sawStudyHistoryRequest = true;
        assert.equal(parsed.searchParams.get("user_id"), "eq.user-42");
        assert.match(parsed.searchParams.get("or") ?? "", /love/);
        return { ok: true, status: 200, text: async () => "[]" };
      }
      throw new Error(`unexpected fetch to ${href}`);
    };

    const result = await chatTurn({ message: "What does the Bible say about love?", appKey: "k", apiKey: "fake", userId: "user-42" });
    assert.ok(sawStudyHistoryRequest, "expected search_study_history to actually query PostgREST");
    assert.ok(result.reply.length > 0);
  } finally {
    clearSupabaseEnv();
  }
});

test("gathering a passage for a signed-in user logs a study_entries row in the background", async () => {
  stubSupabaseEnv();
  try {
    let step = 0;
    let loggedRow = null;

    globalThis.fetch = async (url, opts) => {
      const href = url.toString();
      if (href === "https://api.anthropic.com/v1/messages") {
        step++;
        if (step === 1) {
          return jsonResponse({
            stop_reason: "tool_use",
            content: [{ type: "tool_use", id: "t1", name: "gather_passage", input: { reference: "JHN.3.16" } }],
          });
        }
        return jsonResponse({ stop_reason: "end_turn", content: [{ type: "text", text: "God's love for the world." }] });
      }

      const parsed = new URL(href);
      if (parsed.pathname === "/rest/v1/profiles") {
        return { ok: true, status: 200, text: async () => "[]" };
      }
      if (parsed.pathname === "/rest/v1/study_entries" && opts.method === "POST") {
        loggedRow = JSON.parse(opts.body)[0];
        return { ok: true, status: 201, text: async () => "" };
      }
      throw new Error(`unexpected fetch to ${href}`);
    };

    await chatTurn({ message: "What does John 3:16 mean?", appKey: "k", apiKey: "fake", userId: "user-42" });

    // The log call is deliberately fire-and-forget (not awaited by
    // chatTurn), so give the microtask queue a turn to let it land before
    // asserting on it.
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(loggedRow, "expected a study_entries row to have been logged");
    assert.equal(loggedRow.user_id, "user-42");
    assert.equal(loggedRow.reference, "JHN.3.16");
    assert.match(loggedRow.summary, /God's love/);
  } finally {
    clearSupabaseEnv();
  }
});

// --- Conversation persistence (conversationId) --------------------------

test("a signed-in user's first turn gets a conversationId equal to its sessionId", async () => {
  stubSupabaseEnv();
  try {
    let conversationsPost = null;
    globalThis.fetch = async (url, opts) => {
      const href = url.toString();
      if (href === "https://api.anthropic.com/v1/messages") {
        return jsonResponse({ stop_reason: "end_turn", content: [{ type: "text", text: "reply" }] });
      }
      const parsed = new URL(href);
      if (parsed.pathname === "/rest/v1/profiles") {
        return { ok: true, status: 200, text: async () => "[]" };
      }
      if (parsed.pathname === "/rest/v1/conversations" && opts.method === "GET") {
        return { ok: true, status: 200, text: async () => "[]" };
      }
      if (parsed.pathname === "/rest/v1/conversations" && opts.method === "POST") {
        conversationsPost = JSON.parse(opts.body)[0];
        return { ok: true, status: 201, text: async () => "" };
      }
      throw new Error(`unexpected fetch to ${href}`);
    };

    const result = await chatTurn({ message: "What does Romans 8:28 mean?", appKey: "k", apiKey: "fake", userId: "user-42" });
    assert.equal(result.conversationId, result.sessionId, "a brand-new conversation's id should match its session id");

    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(conversationsPost, "expected a conversations row to be upserted");
    assert.equal(conversationsPost.id, result.sessionId);
    assert.equal(conversationsPost.title, "What does Romans 8:28 mean?");
  } finally {
    clearSupabaseEnv();
  }
});

test("an explicit conversationId keeps appending to that row even under a different sessionId", async () => {
  stubSupabaseEnv();
  try {
    let conversationsPost = null;
    globalThis.fetch = async (url, opts) => {
      const href = url.toString();
      if (href === "https://api.anthropic.com/v1/messages") {
        return jsonResponse({ stop_reason: "end_turn", content: [{ type: "text", text: "reply" }] });
      }
      const parsed = new URL(href);
      if (parsed.pathname === "/rest/v1/profiles") {
        return { ok: true, status: 200, text: async () => "[]" };
      }
      if (parsed.pathname === "/rest/v1/conversations" && opts.method === "GET") {
        return { ok: true, status: 200, text: async () => "[]" };
      }
      if (parsed.pathname === "/rest/v1/conversations" && opts.method === "POST") {
        conversationsPost = JSON.parse(opts.body)[0];
        return { ok: true, status: 201, text: async () => "" };
      }
      throw new Error(`unexpected fetch to ${href}`);
    };

    const oldConversationId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const result = await chatTurn({
      message: "picking this back up",
      appKey: "k",
      apiKey: "fake",
      userId: "user-42",
      conversationId: oldConversationId,
      // no sessionId -- resuming after the live session idled out
    });

    assert.equal(result.conversationId, oldConversationId, "should keep the resumed conversation's id, not the fresh session id");
    assert.notEqual(result.sessionId, oldConversationId, "a fresh session id should still be minted for the live turn");

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(conversationsPost.id, oldConversationId, "should append to the old conversation's row");
  } finally {
    clearSupabaseEnv();
  }
});

test("an anonymous turn's conversationId is always null", async () => {
  stubEndTurn();
  const result = await chatTurn({ message: "What does Romans 8:28 mean?", appKey: "k", apiKey: "fake" });
  assert.equal(result.conversationId, null);
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
    await clearSession(a);
    await clearSession(aAgain);

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

// --- Atomic turn commit: a mid-loop failure must not corrupt the session --
// Real bug found this session: a transient Anthropic failure (5xx, a
// fetchWithTimeout timeout, a rate limit) partway through a tool-use loop
// used to mutate the session's *live* history array before the turn had
// actually succeeded. The next turn on that same session would then push
// its own message right after the leftover partial state, breaking strict
// user/assistant alternation and getting rejected by the real API with a
// 400 — permanently, since the corruption was already committed to the
// session. A turn must be all-or-nothing: either it fully lands, or the
// session is left exactly as it was before the failed attempt.
test("a transient failure mid-tool-loop doesn't corrupt the session for future turns", async () => {
  let call = 0;

  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    // Same alternation check a real Anthropic API would enforce — the stub
    // needs to actually validate this, or a corrupted history would just
    // silently "succeed" against a stub that doesn't check anything.
    for (let i = 1; i < body.messages.length; i++) {
      assert.notEqual(
        body.messages[i].role,
        body.messages[i - 1].role,
        `messages must strictly alternate roles (index ${i - 1}/${i} both "${body.messages[i].role}")`,
      );
    }

    call++;
    if (call === 1) {
      return jsonResponse({ stop_reason: "end_turn", content: [{ type: "text", text: "first reply" }] });
    }
    if (call === 2) {
      return jsonResponse({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "gather_passage", input: { reference: "JHN.3.16" } }],
      });
    }
    if (call === 3) {
      // The tool call above already succeeded and its result was appended
      // to history — now simulate the API itself failing on the very next
      // call within the same turn.
      throw new Error("Anthropic API returned 529 Overloaded");
    }
    return jsonResponse({ stop_reason: "end_turn", content: [{ type: "text", text: "recovered reply" }] });
  };

  const turn1 = await chatTurn({ message: "hello", appKey: "k", apiKey: "fake" });

  await assert.rejects(
    () => chatTurn({ sessionId: turn1.sessionId, message: "what does john 3:16 mean?", appKey: "k", apiKey: "fake" }),
    /529|Overloaded/,
  );

  // The real assertion: a normal follow-up on the SAME session, after the
  // transient failure has passed, must succeed rather than 400 forever.
  const turn3 = await chatTurn({ sessionId: turn1.sessionId, message: "try again", appKey: "k", apiKey: "fake" });
  assert.equal(turn3.reply, "recovered reply");
});

// --- Exhausting MAX_TOOL_ITERATIONS must still end the turn cleanly -------
// Third bug in this family: when Claude keeps calling tools and never
// returns a final plain-text reply within the tool-call budget, the loop
// exits by exhausting MAX_TOOL_ITERATIONS rather than a natural `break` —
// which always happens right after a user-role tool_result was pushed. The
// synthetic "(Reached the tool-call limit...)" fallback reply was returned
// to the caller but never committed to history, so the session was left
// ending on a tool_result with no assistant reply after it. The next turn's
// user message would then land right after that tool_result, creating two
// consecutive user-role messages and breaking Anthropic's role alternation.
test("exhausting the tool-call budget doesn't corrupt the session for future turns", async () => {
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    for (let i = 1; i < body.messages.length; i++) {
      assert.notEqual(
        body.messages[i].role,
        body.messages[i - 1].role,
        `messages must strictly alternate roles (index ${i - 1}/${i} both "${body.messages[i].role}")`,
      );
    }
    // Always ask for another tool call — never give a final text reply, so
    // the loop is forced to exhaust MAX_TOOL_ITERATIONS.
    return jsonResponse({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: `t${Math.random()}`, name: "gather_passage", input: { reference: "JHN.3.16" } }],
    });
  };

  const turn1 = await chatTurn({ message: "keep going forever", appKey: "k", apiKey: "fake" });
  assert.match(turn1.reply, /tool-call limit/i);

  // The real assertion: a normal follow-up on the same session must
  // succeed, not break on role alternation.
  const turn2 = await chatTurn({ sessionId: turn1.sessionId, message: "a normal follow-up", appKey: "k", apiKey: "fake" });
  assert.match(turn2.reply, /tool-call limit/i); // this stub always asks for a tool, so it hits the same limit again
});
