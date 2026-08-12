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

import { fetchWithTimeout } from "./fetch-timeout.js";
import { gatherPassage } from "./gather.js";
import { findStrongsOccurrences, searchLexicon } from "./interlinear.js";
import { formatGatheredPassage } from "./summarize.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1800;
// Generous relative to the translation/commentary timeouts — a real answer
// involving multiple tool calls and a longer completion can legitimately
// take a while, and cutting it off too eagerly would turn a slow-but-good
// answer into an error. Still finite, so a genuinely stuck request fails
// instead of leaving the user's message spinning forever.
const ANTHROPIC_TIMEOUT_MS = 45000;

// Caps how many tool calls Claude can make in a single turn before it has
// to just answer — a safeguard against a runaway tool-call loop (cost and
// latency), not a limit expected to be hit in normal use. Bumped from the
// original 5 now that a genuinely thorough topical answer might chain
// search_lexicon -> find_occurrences -> gather_passage on 2-3 verses.
const MAX_TOOL_ITERATIONS = 8;

// Soft cap on how much conversation history a session carries forward. This
// is a personal-scale tool with in-memory sessions (cleared on server
// restart, no accounts) — the cap exists so a very long-running
// conversation doesn't grow the prompt (and the per-turn API cost)
// unbounded, not because long conversations are expected to be common.
const MAX_HISTORY_MESSAGES = 30;

const CHAT_SYSTEM_PROMPT = `You are a warm, knowledgeable conversation partner for Bible study — closer to a thoughtful theologian or Bible scholar talking with someone than a search engine or report generator.

You have three tools:

- gather_passage fetches primary-source material for a specific verse: several English translations, a word-by-word breakdown of the original Greek or Hebrew with Strong's numbers and glosses, and excerpts from public-domain commentaries (Matthew Henry, Jamieson-Fausset-Brown, Barnes, Gill, Geneva Study Bible).
- search_lexicon searches the Greek and Hebrew lexicons by English keyword, surfacing the real Strong's numbers behind a concept — e.g. searching "love" finds agapaō (G0025), phileō (G5368), and Hebrew ahav (H0157), each with its own gloss.
- find_occurrences finds every verse in the tagged text containing a given Strong's number — a genuine word study grounded in the actual data, not a guess from memory about where a word "probably" shows up.

Call gather_passage whenever you need material for a verse — this includes the verse the user names, and any cross-reference you think of yourself that would genuinely help answer their question. For a topical or "what else does Scripture say about X" question, prefer search_lexicon and find_occurrences over relying on memory alone: search_lexicon to find the actual underlying word(s), find_occurrences to see where they're really used, then gather_passage on whichever specific verses look most worth discussing in depth. This is what lets you ground a topical answer in the real tagged text instead of a general impression — reach for it especially when precision about a word's actual distribution matters to the question. General biblical knowledge (historical context, theological traditions, how a book is structured) is still fine to draw on for things these tools don't cover — just be clear when you're doing that versus reporting from gathered or searched data. Don't repeat a tool call whose result is already earlier in this conversation; reuse what you have.

If a question has no specific verse in view yet, it's fine to ask the user what passage they have in mind, or to reach for one yourself if it obviously fits the question.

Ground what you say in material you've actually gathered or searched: don't invent a claim and attribute it to a specific translation or commentary you haven't seen via the tool. If you're drawing on general background knowledge rather than gathered sources, say so plainly rather than presenting it as if it came from the tool. When commentators or translations genuinely disagree, present that as disagreement instead of picking a side for the user.

Write like you're talking, not filing a report: prose, not section headers or bullet-point dumps, unless the user's question specifically calls for a list. Keep replies focused — a few solid paragraphs at most, more only if the question genuinely needs it.

This chat box is the only entry point to the app — there's no separate search field. A message that's just a bare reference ("1 Corinthians 13:4", "John 3:16") with no explicit question is a request to help understand that passage: gather it and give the same kind of plain-language "what this says and why it matters" answer you'd give if the user had asked "what does this mean?" outright. The gathered translations, original-language words, and commentary are also shown to the user directly alongside your reply, so you don't need to reproduce all of it — focus on synthesis and insight rather than re-listing what's already on screen.`;

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

const SEARCH_LEXICON_TOOL = {
  name: "search_lexicon",
  description:
    'Search the Greek and Hebrew lexicons for entries whose English gloss or transliteration contains a keyword — e.g. searching "love" surfaces agapaō (G0025), phileō (G5368), and Hebrew ahav (H0157), each with a short definition. Use this to find the real Strong\'s numbers behind an English concept before doing a word study with find_occurrences, rather than guessing from memory which words might be relevant. Case-insensitive substring match, not fuzzy — "faith" won\'t find "believe".',
  input_schema: {
    type: "object",
    properties: {
      keyword: {
        type: "string",
        description: 'An English word or short phrase to search lexicon glosses for, e.g. "love", "faith", "forgive".',
      },
      testament: {
        type: "string",
        enum: ["greek", "hebrew", "both"],
        description: "Restrict to Greek (New Testament), Hebrew (Old Testament), or both. Defaults to both.",
      },
    },
    required: ["keyword"],
  },
};

const FIND_OCCURRENCES_TOOL = {
  name: "find_occurrences",
  description:
    "Find every verse in the tagged text containing a given Strong's number — a real word study grounded in the actual data. Use this after search_lexicon identifies a relevant number, or directly if you already know the number from a gathered passage's word list. Returns a capped list of occurrences plus the true total count, so a very common word is honestly reported as common rather than silently truncated with no indication there's more.",
  input_schema: {
    type: "object",
    properties: {
      strongsNumber: {
        type: "string",
        description: 'A Strong\'s number, e.g. "G0025" or "H0157". Works with or without a disambiguating letter/instance suffix.',
      },
      limit: {
        type: "integer",
        description: "Max occurrences to return (default 20). Keep this reasonable — it's for scanning representative examples, not dumping a full concordance.",
      },
    },
    required: ["strongsNumber"],
  },
};

const TOOLS = [GATHER_TOOL, SEARCH_LEXICON_TOOL, FIND_OCCURRENCES_TOOL];

// sessionId -> array of Anthropic message objects ({ role, content }).
// In-memory and per-process by design (see MAX_HISTORY_MESSAGES comment
// above) — restarting the server clears every session. But "in-memory
// forever" with no cap is its own resource leak: a client retrying with a
// bad sessionId, a browser tab hammering the endpoint, or just this server
// staying up for weeks would otherwise accumulate one Map entry per
// conversation with nothing ever removing the old ones. Idle sessions
// expire, and a hard cap is a backstop against unbounded growth even if
// something creates sessions faster than they'd normally go idle.
//
// Map preserves insertion order, so — same trick as lib/gather.js's
// gatherCache — deleting and re-setting a key on every touch keeps it in
// "most recently active" position, making oldest-first eviction (via
// Map's iteration order) a correct least-recently-active eviction.
const SESSION_IDLE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours of inactivity
const SESSION_MAX_COUNT = 500;
const sessions = new Map(); // id -> { history, lastActiveAt }

function pruneSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActiveAt > SESSION_IDLE_TTL_MS) sessions.delete(id);
  }
  while (sessions.size > SESSION_MAX_COUNT) {
    const oldestId = sessions.keys().next().value;
    sessions.delete(oldestId);
  }
}

// True only for a message that starts a fresh turn: the human's original
// message, pushed as a plain string. Every other message in history is
// either an assistant reply (whose content is an array of text/tool_use
// blocks) or a tool-result message pushed mid-loop (role "user", but
// content is an array of tool_result blocks, not a string) — never a safe
// place to cut, since cutting there would separate a tool_use from its
// tool_result (or vice versa).
function isTurnStart(message) {
  return message.role === "user" && typeof message.content === "string";
}

// Exported for direct unit testing (test/chat.test.mjs) — the boundary
// logic here is exactly the kind of thing worth testing in isolation
// rather than only indirectly through a long simulated conversation.
export function trimHistory(messages) {
  if (messages.length <= MAX_HISTORY_MESSAGES) return messages;

  // A naive slice(messages.length - MAX_HISTORY_MESSAGES) can land inside a
  // tool_use/tool_result exchange within a turn — e.g. cutting right before
  // a tool_result message whose matching tool_use was in the message just
  // dropped. Anthropic's API rejects that outright (a tool_result with no
  // corresponding tool_use earlier in the request), which would break
  // every future turn in the session with a hard 400, not just quietly
  // lose old context. Instead, walk forward from the naive cut point to the
  // nearest safe turn boundary.
  const target = messages.length - MAX_HISTORY_MESSAGES;
  let cut = target;
  while (cut < messages.length && !isTurnStart(messages[cut])) cut++;

  if (cut >= messages.length) {
    // No safe boundary found within the trim window — in practice this
    // would mean a single turn alone is longer than MAX_HISTORY_MESSAGES,
    // which shouldn't happen (MAX_TOOL_ITERATIONS caps how many
    // tool_use/tool_result round-trips one turn can have). If it somehow
    // does, don't cut into a broken pair just to hit the cap exactly —
    // better to let history run a bit long than send a malformed request.
    return messages;
  }

  return messages.slice(cut);
}

async function callAnthropic({ apiKey, model, messages }) {
  const response = await fetchWithTimeout(
    API_URL,
    {
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
        tools: TOOLS,
        messages,
      }),
    },
    ANTHROPIC_TIMEOUT_MS,
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Anthropic API returned ${response.status} ${response.statusText}\n${body}`,
    );
  }

  return response.json();
}

// Executes one gather_passage tool call. Returns { text, gathered }: text is
// what goes back to Claude as the tool_result content, gathered is the raw
// gatherPassage() result (or null on failure) so the caller can also hand
// the same translations/interlinear/commentary to the frontend — the whole
// point being that what Claude saw and what the user sees are the same
// data, not two separately-fetched copies that could drift.
//
// Errors (a malformed reference, a book with no mapped data) are returned as
// text rather than thrown, so Claude can react — e.g. ask the user to
// clarify — instead of the whole turn dying because of one bad tool call.
async function runGatherTool(input, { appKey }) {
  const reference = (input?.reference ?? "").trim();
  if (!reference) {
    return { text: "Error: gather_passage was called without a reference.", gathered: null };
  }

  try {
    const gathered = await gatherPassage(reference, {
      appKey,
      includeCommentary: true,
    });
    return { text: formatGatheredPassage(gathered), gathered };
  } catch (error) {
    return { text: `Error fetching "${reference}": ${error.message}`, gathered: null };
  }
}

// Executes a search_lexicon tool call and returns the text to hand back to
// Claude. Errors are returned as text, same reasoning as runGatherTool().
async function runSearchLexiconTool(input) {
  const keyword = (input?.keyword ?? "").trim();
  if (!keyword) {
    return "Error: search_lexicon was called without a keyword.";
  }
  const testament = ["greek", "hebrew", "both"].includes(input?.testament) ? input.testament : "both";

  try {
    const { results, totalCount } = await searchLexicon(keyword, { testament });
    if (results.length === 0) {
      return `No lexicon entries found for "${keyword}".`;
    }
    const lines = results.map(
      (r) => `${r.strongs}  ${r.transliteration} (${r.lemma}) — ${r.gloss}`,
    );
    const truncatedNote =
      totalCount > results.length ? `\n(${totalCount} total matches; showing ${results.length}.)` : "";
    return `Lexicon matches for "${keyword}":\n${lines.join("\n")}${truncatedNote}`;
  } catch (error) {
    return `Error searching lexicon: ${error.message}`;
  }
}

// Executes a find_occurrences tool call and returns the text to hand back
// to Claude.
async function runFindOccurrencesTool(input) {
  const strongsNumber = (input?.strongsNumber ?? "").trim();
  if (!strongsNumber) {
    return "Error: find_occurrences was called without a strongsNumber.";
  }
  const limit = Number.isInteger(input?.limit) && input.limit > 0 ? Math.min(input.limit, 50) : 20;

  try {
    const { occurrences, totalCount, error } = await findStrongsOccurrences(strongsNumber, { limit });
    if (error) return `Error: ${error}`;
    if (occurrences.length === 0) {
      return `No occurrences found for ${strongsNumber}.`;
    }
    const lines = occurrences.map((o) => `${o.reference}: ${o.surface} — ${o.gloss}`);
    const truncatedNote =
      totalCount > occurrences.length
        ? `\n(${totalCount} total occurrences; showing ${occurrences.length}.)`
        : "";
    return `Occurrences of ${strongsNumber}:\n${lines.join("\n")}${truncatedNote}`;
  } catch (error) {
    return `Error finding occurrences: ${error.message}`;
  }
}

// Dispatches one tool_use block to its executor by name and returns the
// text for its tool_result, plus any gatherPassage() data it produced (only
// gather_passage produces this; search_lexicon/find_occurrences are
// text-only research aids with nothing structured to show the frontend).
async function runTool(toolUse, { appKey }) {
  switch (toolUse.name) {
    case "gather_passage":
      return runGatherTool(toolUse.input, { appKey });
    case "search_lexicon":
      return { text: await runSearchLexiconTool(toolUse.input), gathered: null };
    case "find_occurrences":
      return { text: await runFindOccurrencesTool(toolUse.input), gathered: null };
    default:
      return { text: `Error: unknown tool "${toolUse.name}".`, gathered: null };
  }
}

/**
 * Runs one turn of the chat: appends the user's message to the session's
 * history, loops against the Anthropic API — executing gather_passage,
 * search_lexicon, and find_occurrences tool calls as Claude asks for them —
 * until Claude gives a plain-text reply, and returns it.
 *
 * sessionId is created if not supplied or not recognized. Returns
 * { sessionId, reply, gathered }, where gathered is the list of
 * gatherPassage() results (translations/original-language/commentary) for
 * every distinct reference Claude looked up while producing this reply —
 * so the frontend can show the same source material Claude actually used,
 * not just the prose answer. (search_lexicon/find_occurrences results are
 * text-only and only ever seen by Claude, not surfaced separately to the
 * frontend — Claude is expected to fold anything relevant into its reply.)
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

  pruneSessions();

  const id = sessionId && sessions.has(sessionId) ? sessionId : randomUUID();
  // Work on a COPY of the committed history, not the live array stored in
  // the sessions Map. The tool loop below can throw mid-way (a transient
  // Anthropic 5xx, our own fetchWithTimeout firing, a rate limit) after
  // already pushing a partial exchange — if that mutated the session's real
  // history array in place, the failed attempt's partial state (e.g. an
  // assistant message with tool_use, or a user message with tool_result)
  // would be permanently stuck in the session even though this function
  // never got to return successfully. The NEXT turn on that same session
  // would then push its own user message right after that leftover state,
  // breaking Anthropic's strict role-alternation requirement and returning
  // a 400 on every future attempt — turning one transient failure into a
  // permanently broken conversation. Committing the mutated copy back to
  // the Map only on success (see the bottom of this function) makes a turn
  // atomic: it either fully lands, or the session is left exactly as it was
  // before this call, as if the failed attempt never happened.
  const committedHistory = sessions.get(id)?.history ?? [];
  const history = [...committedHistory];
  history.push({ role: "user", content: message.trim() });

  let finalReply = null;
  const gatheredThisTurn = [];
  const seenRefs = new Set();

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
      toolUses.map(async (toolUse) => {
        const { text, gathered } = await runTool(toolUse, { appKey });
        if (gathered && !seenRefs.has(gathered.reference.usfm)) {
          seenRefs.add(gathered.reference.usfm);
          gatheredThisTurn.push(gathered);
        }
        return { type: "tool_result", tool_use_id: toolUse.id, content: text };
      }),
    );
    history.push({ role: "user", content: toolResults });
  }

  if (finalReply === null) {
    finalReply =
      "(Reached the tool-call limit for this turn without a final answer — try rephrasing, or ask a narrower question.)";
    // The loop above only exits without a `break` by exhausting
    // MAX_TOOL_ITERATIONS, which always happens right after pushing a
    // user-role tool_result — there's no natural assistant reply to end the
    // turn on. Without pushing one here, the committed history would end on
    // that tool_result, and the *next* turn's user message would land right
    // after it, creating two consecutive user-role messages and breaking
    // Anthropic's strict role alternation on this session's very next
    // request. Same family of bug as the trimHistory and mid-loop-failure
    // fixes: a turn must always leave history ending on an assistant
    // message.
    history.push({ role: "assistant", content: [{ type: "text", text: finalReply }] });
  }

  // Delete-then-set moves this id to the end of the Map's iteration order —
  // see the "most recently active" comment above the sessions Map.
  sessions.delete(id);
  sessions.set(id, { history: trimHistory(history), lastActiveAt: Date.now() });
  // pruneSessions() at the top of this function enforces the cap based on
  // the count *before* this turn's session was added — a brand-new session
  // could still push the total one over SESSION_MAX_COUNT. Prune again here
  // so the invariant (count <= SESSION_MAX_COUNT) actually holds once this
  // call returns, not just "as of the start of the call."
  pruneSessions();

  return { sessionId: id, reply: finalReply, gathered: gatheredThisTurn };
}

/** Number of sessions currently held in memory — for tests/diagnostics. */
export function getSessionCount() {
  return sessions.size;
}

/** Drops a session's history — used by the "clear conversation" UI action. */
export function clearSession(sessionId) {
  sessions.delete(sessionId);
}
