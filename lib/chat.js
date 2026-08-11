// Phase 3 (chat): a conversational interface on top of the same gather/
// summarize pipeline, for questions that don't fit the one-shot "give me a
// reference, get a report" flow lib/summarize.js is built for.
//
// Unlike summarizePassage(), this lets Claude pull in primary-source
// material for whatever verse it needs — including cross-references it
// thinks of on its own, not just the one the user named — by giving it a
// gather_passage tool backed directly by gatherPassage(). That's what makes
// follow-up questions ("what about the Greek word there?") and free-form
// topical questions ("what else does Scripture say about this?") work
// without the user having to restate or look up a reference themselves.

import { randomUUID } from "node:crypto";

import { gatherPassage } from "./gather.js";
import { formatGatheredPassage } from "./summarize.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1500;

// Caps how many times Claude can call gather_passage in a single turn before
// it has to just answer — a safeguard against a runaway tool-call loop
// (cost and latency), not a limit expected to be hit in normal use.
const MAX_TOOL_ITERATIONS = 5;

// Soft cap on how much conversation history a session carries forward. This
// is a personal-scale tool with in-memory sessions (cleared on server
// restart, no accounts) — the cap exists so a very long-running
// conversation doesn't grow the prompt (and the per-turn API cost)
// unbounded, not because long conversations are expected to be common.
const MAX_HISTORY_MESSAGES = 30;

const CHAT_SYSTEM_PROMPT = `You are a warm, knowledgeable conversation partner for Bible study — closer to a thoughtful theologian or Bible scholar talking with someone than a search engine or report generator.

You have one tool, gather_passage, which fetches primary-source material for a specific verse: several English translations, a word-by-word breakdown of the original Greek or Hebrew with Strong's numbers and glosses, and excerpts from public-domain commentaries (Matthew Henry, Jamieson-Fausset-Brown, Barnes, Gill, Geneva Study Bible).

Call gather_passage whenever you need material for a verse you haven't already gathered earlier in this conversation — this includes the verse the user names, and any cross-reference you think of yourself that would genuinely help answer their question. Don't call it again for a verse already gathered earlier in the conversation; reuse what you already have. If a question has no specific verse in view yet, it's fine to ask the user what passage they have in mind, or to reach for a verse yourself if one obviously fits the question.

Ground what you say in material you've actually gathered: don't invent a claim and attribute it to a specific translation or commentary you haven't seen via the tool. If you're drawing on general background knowledge rather than gathered sources, say so plainly rather than presenting it as if it came from the tool. When commentators or translations genuinely disagree, present that as disagreement instead of picking a side for the user.

Write like you're talking, not filing a report: prose, not section headers or bullet-point dumps, unless the user's question specifically calls for a list. Keep replies focused — a few solid paragraphs at most, more only if the question genuinely needs it.`;

const GATHER_TOOL = {
  name: "gather_passage",
  description:
    "Fetch primary-source study material for a Bible verse: several English translations, a word-by-word breakdown of the original Greek or Hebrew with Strong's numbers and glosses, and excerpts from public-domain commentaries. Call this for the verse the user asked about, and for any cross-reference you think of yourself that would genuinely help — but don't call it again for a verse already gathered earlier in this conversation.",
  input_schema: {
    type: "object",
    properties: {
      reference: {
        type: "string",
        description:
          'USFM-style reference: 3-letter book code, chapter, verse, dot-separated. Examples: "JHN.3.16", "GEN.1.1", "1CO.13.4", "1JN.4.8".',
      },
    },
    required: ["reference"],
  },
};

// sessionId -> array of Anthropic message objects ({ role, content }).
// In-memory and per-process by design (see MAX_HISTORY_MESSAGES comment
// above) — restarting the server clears every session.
const sessions = new Map();

function trimHistory(messages) {
  if (messages.length <= MAX_HISTORY_MESSAGES) return messages;
  return messages.slice(messages.length - MAX_HISTORY_MESSAGES);
}

async function callAnthropic({ apiKey, model, messages }) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      system: CHAT_SYSTEM_PROMPT,
      tools: [GATHER_TOOL],
      messages,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Anthropic API returned ${response.status} ${response.statusText}\n${body}`,
    );
  }

  return response.json();
}

// Executes one gather_passage tool call and returns the string to hand back
// to Claude as the tool_result content. Errors (a malformed reference, a
// book with no mapped data) are returned as text rather than thrown, so
// Claude can react — e.g. ask the user to clarify — instead of the whole
// turn dying because of one bad tool call.
async function runGatherTool(input, { appKey }) {
  const reference = (input?.reference ?? "").trim();
  if (!reference) {
    return "Error: gather_passage was called without a reference.";
  }

  try {
    const gathered = await gatherPassage(reference, {
      appKey,
      includeCommentary: true,
    });
    return formatGatheredPassage(gathered);
  } catch (error) {
    return `Error fetching "${reference}": ${error.message}`;
  }
}

/**
 * Runs one turn of the chat: appends the user's message to the session's
 * history, loops against the Anthropic API — executing gather_passage tool
 * calls as Claude asks for them — until Claude gives a plain-text reply,
 * and returns it.
 *
 * sessionId is created if not supplied or not recognized. Returns
 * { sessionId, reply }.
 */
export async function chatTurn({
  sessionId,
  message,
  appKey,
  apiKey,
  model = process.env.SUMMARY_MODEL ?? DEFAULT_MODEL,
} = {}) {
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env to enable chat.");
  }
  if (!message || !message.trim()) {
    throw new Error("Message cannot be empty.");
  }

  const id = sessionId && sessions.has(sessionId) ? sessionId : randomUUID();
  const history = sessions.get(id) ?? [];
  history.push({ role: "user", content: message.trim() });

  let finalReply = null;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const data = await callAnthropic({ apiKey, model, messages: history });
    const content = data.content ?? [];
    history.push({ role: "assistant", content });

    const toolUses = content.filter((block) => block.type === "tool_use");
    if (toolUses.length === 0) {
      finalReply = content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      break;
    }

    const toolResults = await Promise.all(
      toolUses.map(async (toolUse) => ({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: await runGatherTool(toolUse.input, { appKey }),
      })),
    );
    history.push({ role: "user", content: toolResults });
  }

  if (finalReply === null) {
    finalReply =
      "(Reached the tool-call limit for this turn without a final answer — try rephrasing, or ask a narrower question.)";
  }

  sessions.set(id, trimHistory(history));

  return { sessionId: id, reply: finalReply };
}

/** Drops a session's history — used by the "clear conversation" UI action. */
export function clearSession(sessionId) {
  sessions.delete(sessionId);
}
