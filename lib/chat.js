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

import { searchBibleText } from "./bible-search.js";
import { bookCodeFromReference } from "./bible-books.js";
import { fetchWithTimeout } from "./fetch-timeout.js";
import { gatherPassage } from "./gather.js";
import { findStrongsOccurrences, searchLexicon } from "./interlinear.js";
import {
  deleteSession,
  getSession,
  getSessionCount as storeSessionCount,
  isDurable,
  setSession,
} from "./session-store.js";
import { appendToConversation, getAgentNameIfPaid, logStudyEntry, searchStudyHistory } from "./supabase.js";
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

// Prompt cache TTL: 5m (default, no extra cost) vs 1h (2x write cost instead
// of 1.25x, reads are the same 0.1x price either way). The 5-minute cache
// only pays off if the next message arrives within 5 minutes of the last
// one — plausible for a quick back-and-forth, but a real risk for this app:
// someone reading a multi-paragraph reply, or sitting with a passage before
// responding, can easily take longer than that. Missing the window means a
// full-price cache write on the next message instead of a cheap read. 1h
// gives a lot more slack for that natural reading/reflection pause at a
// modest cost increase on writes only (reads are unaffected), so it's the
// better fit for how this app is actually used. Easy to flip back to "5m"
// later if real usage data says otherwise.
const CACHE_TTL = "1h";

// Caps how many tool calls Claude can make in a single turn before it has
// to just answer — a safeguard against a runaway tool-call loop (cost and
// latency), not a limit expected to be hit in normal use. Bumped from the
// original 5 now that a genuinely thorough topical answer might chain
// search_lexicon -> find_occurrences -> gather_passage on 2-3 verses.
const MAX_TOOL_ITERATIONS = 8;

// Soft cap on how much conversation history a session carries forward — so
// a very long-running conversation doesn't grow the prompt (and the
// per-turn API cost) unbounded, not because long conversations are
// expected to be common. Independent of accounts/study-memory: this bounds
// one session's live back-and-forth, not the persistent history a signed-in
// user builds up in study_entries over many separate conversations.
const MAX_HISTORY_MESSAGES = 30;

// Caps how much of a reply gets stored as a study_entries summary (see
// chatTurn's logging at the bottom of this file). A full reply can run to
// several paragraphs — more than a "what did I study" glance actually
// needs, and more than search_study_history's tool-result formatting
// should be dumping back into a future conversation's context window.
const STUDY_SUMMARY_MAX_LENGTH = 400;

// Caps the auto-generated title for a signed-in user's conversation (the
// "previous conversations" menu — see appendToConversation below), taken
// from the first message of the conversation. Short enough to sit in a
// single line of a dropdown list item.
const CONVERSATION_TITLE_MAX_LENGTH = 60;

// A function, not a constant, because the tool count and the fourth
// paragraph below both depend on whether this turn belongs to a signed-in
// user (see chatTurn's `userId`) — search_study_history only exists, and
// should only be mentioned, when there's actually a study history to
// search. An anonymous request gets the exact same prompt this app always
// had; nothing about the anonymous experience changes with accounts added.
// agentName is the paid-only "name your agent" feature (see README ->
// Subscription / paid tier) — null for everyone except a paid account that's
// actually set one, in which case a short identity line is prepended so
// Claude answers to it naturally without making a big deal of it.
function buildSystemPrompt(hasUser, agentName = null) {
  const identityLine = agentName
    ? `\n\nThis user has named you "${agentName}" for their own conversations, purely to make things feel a little more personal — answer to it naturally if they use it, without drawing extra attention to the name itself unless they bring it up.`
    : "";

  return `You are a warm, knowledgeable conversation partner for Bible study — closer to a thoughtful theologian or Bible scholar talking with someone than a search engine or report generator.${identityLine}

You have ${hasUser ? "five tools" : "four tools"}:

- gather_passage fetches primary-source material for a specific verse: several English translations, a word-by-word breakdown of the original Greek or Hebrew with Strong's numbers and glosses, and excerpts from public-domain commentaries (Matthew Henry, Jamieson-Fausset-Brown, Barnes, Gill, Geneva Study Bible).
- search_lexicon searches the Greek and Hebrew lexicons by English keyword, surfacing the real Strong's numbers behind a concept — e.g. searching "love" finds agapaō (G0025), phileō (G5368), and Hebrew ahav (H0157), each with its own gloss.
- find_occurrences finds every verse in the tagged text containing a given Strong's number — a genuine word study grounded in the actual data, not a guess from memory about where a word "probably" shows up.
- search_bible_text does a full-text keyword search across the whole Bible's English text — every verse containing all of the given words, in canonical order. Use this when someone's trying to locate a specific verse or passage from a remembered phrase, wording, or idiom ("the verse about a still small voice", "where Paul talks about the peace that surpasses understanding") rather than a Strong's-number word study — it's a plain keyword match, not stemmed (searching "love" won't also find "loved" or "loving") and not phrase-order-aware.${
    hasUser
      ? `
- search_study_history searches this specific user's own past study — passages they've looked at in earlier conversations, going back further than this conversation's own history. Use it when a genuine callback would help: they ask something like "have I looked at this before," a passage or word connects to something they studied a while ago and pointing that out would add real insight, or they ask you to recall something specific. Don't call it reflexively on every message — only when past history is actually likely to matter to the current question.`
      : ""
  }

Call gather_passage whenever you need material for a verse — this includes the verse the user names, and any cross-reference you think of yourself that would genuinely help answer their question. For a topical or "what else does Scripture say about X" question, prefer search_lexicon and find_occurrences over relying on memory alone: search_lexicon to find the actual underlying word(s), find_occurrences to see where they're really used, then gather_passage on whichever specific verses look most worth discussing in depth. This is what lets you ground a topical answer in the real tagged text instead of a general impression — reach for it especially when precision about a word's actual distribution matters to the question. Reach for search_bible_text instead when someone's trying to locate a verse by its wording rather than study a concept — it's the more direct match for "what's that verse that says..." than a lexicon search would be. General biblical knowledge (historical context, theological traditions, how a book is structured) is still fine to draw on for things these tools don't cover — just be clear when you're doing that versus reporting from gathered or searched data. Don't repeat a tool call whose result is already earlier in this conversation; reuse what you have.

If a question has no specific verse in view yet, it's fine to ask the user what passage they have in mind, or to reach for one yourself if it obviously fits the question.

Ground what you say in material you've actually gathered or searched: don't invent a claim and attribute it to a specific translation or commentary you haven't seen via the tool. If you're drawing on general background knowledge rather than gathered sources, say so plainly rather than presenting it as if it came from the tool. When commentators or translations genuinely disagree, present that as disagreement instead of picking a side for the user.

If asked for historical context beyond what the tools cover — what was happening in the wider world around a passage, early church history, how a book or event fits into the broader timeline of history — share what you actually know rather than deflecting to "I can't help with that." This is general knowledge, not something gathered or searched, so flag it as such (e.g. "this is background history, not from the sources above") the same way you would for any other general-knowledge claim.

If asked to prepare a sermon outline, lesson, or small-group discussion guide, shift into that format explicitly — this is the one case where real structure (a title, numbered points, a discussion-questions list) genuinely serves the request better than prose, since it's meant to be preached or taught from, not just read once. Ground it the same way as any other answer: gather the passage (and any cross-references worth including) first if you haven't already, and build the main points from what's actually there in the text rather than a generic template you'd produce without it. A useful outline has: a clear title; the key passage(s) by reference; 3-5 main points, each anchored to a specific verse or observation from the gathered material; and a short set of discussion or reflection questions at the end. If a point leans on background knowledge rather than what was gathered, say so the same way you would anywhere else.

Write like you're talking, not filing a report: prose, not section headers or bullet-point dumps, unless the user's question specifically calls for a list, or is a sermon/lesson/discussion-guide request, which gets the structured format described above instead. Keep replies focused — a few solid paragraphs at most, more only if the question genuinely needs it.

This chat box is the only entry point to the app — there's no separate search field. A message that's just a bare reference ("1 Corinthians 13:4", "John 3:16") with no explicit question is a request to help understand that passage: gather it and give the same kind of plain-language "what this says and why it matters" answer you'd give if the user had asked "what does this mean?" outright. The gathered translations, original-language words, and commentary are also shown to the user directly alongside your reply, so you don't need to reproduce all of it — focus on synthesis and insight rather than re-listing what's already on screen.`;
}

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

const SEARCH_BIBLE_TEXT_TOOL = {
  name: "search_bible_text",
  description:
    'Full-text keyword search across the whole Bible\'s English text (Berean Standard Bible) — returns every verse containing ALL of the given words, in canonical Bible order. Use this to locate a specific verse from a remembered phrase or wording ("the still small voice verse"), not for a concept/word study (use search_lexicon + find_occurrences for that instead). Exact-word match, not stemmed: searching "love" will not also find "loved" or "loving". Not phrase-order-aware: it does not require the words to appear together or in order.',
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: 'One or more words to search for, e.g. "still small voice" or "peace surpasses understanding". All words must appear somewhere in the verse (not necessarily adjacent or in order).',
      },
      limit: {
        type: "integer",
        description: "Max verses to return (default 20, capped at 50).",
      },
    },
    required: ["query"],
  },
};

const TOOLS = [GATHER_TOOL, SEARCH_LEXICON_TOOL, FIND_OCCURRENCES_TOOL, SEARCH_BIBLE_TEXT_TOOL];

// Only ever added to the tools array for a signed-in user (see chatTurn's
// buildTools()) — Claude never sees this tool at all on an anonymous
// request, so there's no risk of it trying to call something that isn't
// actually available.
const SEARCH_STUDY_HISTORY_TOOL = {
  name: "search_study_history",
  description:
    "Searches this user's own past study entries — passages and topics they've looked at in earlier conversations, not just this one. Pass a keyword to filter (matched against the reference, topic, and a short summary of what was discussed); omit it to get their most recent entries. Use this for genuine callbacks (\"you looked at this same passage back in your Ephesians study\"), not on every message.",
  input_schema: {
    type: "object",
    properties: {
      keyword: {
        type: "string",
        description: 'Optional keyword to filter by, e.g. "love", "Ephesians", or a reference like "JHN.3.16". Omit to get recent history unfiltered.',
      },
      limit: {
        type: "integer",
        description: "Max entries to return (default 10, capped at 50).",
      },
    },
  },
};

// Builds the tools array for one turn — the base three tools always,
// search_study_history only when there's a signed-in user to search
// history for.
function buildTools(hasUser) {
  return hasUser ? [...TOOLS, SEARCH_STUDY_HISTORY_TOOL] : TOOLS;
}

// Session history (an array of Anthropic message objects) is read/written
// through lib/session-store.js, not held directly in this module — see
// that file for the Redis-vs-in-memory backend split. This module only
// deals with a session as { history, lastActiveAt }.

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

async function callAnthropic({ apiKey, model, messages, system, tools }) {
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
        system,
        tools,
        messages,
        // Automatic prompt caching: a single top-level field, and Anthropic
        // caches everything up through the last stable block (here: system
        // + tools + all-but-the-newest turn of history), moving the
        // breakpoint forward on its own as the conversation grows. This is
        // the officially recommended approach for exactly this shape of
        // request (multi-turn, tool-using) — see CACHE_TTL comment below
        // for why 1h instead of the 5m default.
        cache_control: { type: "ephemeral", ttl: CACHE_TTL },
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

// Executes a search_bible_text tool call and returns the text to hand back
// to Claude. A missing data/bsb.txt (BSB_NOT_DOWNLOADED — see
// lib/bible-search.js's searchBibleText()) is reported the same friendly
// way as any other tool error rather than crashing the turn, same
// reasoning as runGatherTool()'s handling of a missing STEPBible file.
async function runSearchBibleTextTool(input) {
  const query = (input?.query ?? "").trim();
  if (!query) {
    return "Error: search_bible_text was called without a query.";
  }
  const limit = Number.isInteger(input?.limit) && input.limit > 0 ? Math.min(input.limit, 50) : 20;

  try {
    const results = await searchBibleText(query, { limit });
    if (results.length === 0) {
      return `No verses found containing all of: ${query}`;
    }
    const lines = results.map((r) => `${r.usfm} (${r.book} ${r.chapter}:${r.verse}) — ${r.text}`);
    return `Verses matching "${query}":\n${lines.join("\n")}`;
  } catch (error) {
    return `Error searching Bible text: ${error.message}`;
  }
}

// Executes a search_study_history tool call. Only ever dispatched when
// userId is set (the tool isn't in the tools array otherwise), but checked
// again here anyway rather than trusting that invariant blindly — Claude
// echoes tool names back from the request we sent it, so this should be
// unreachable with no userId, but "should be unreachable" isn't the same
// guarantee as "isn't."
async function runSearchStudyHistoryTool(input, { userId }) {
  if (!userId) {
    return "Error: search_study_history is not available (no signed-in user for this request).";
  }
  const keyword = (input?.keyword ?? "").trim() || undefined;
  const limit = Number.isInteger(input?.limit) && input.limit > 0 ? Math.min(input.limit, 50) : 10;

  try {
    const entries = await searchStudyHistory(userId, { keyword, limit });
    if (entries.length === 0) {
      return keyword
        ? `No past study entries found matching "${keyword}".`
        : "No past study history yet — this looks like their first time studying with an account.";
    }
    const lines = entries.map((e) => {
      const when = new Date(e.created_at).toISOString().slice(0, 10);
      const label = e.reference ?? e.topic ?? "(untitled)";
      return `${when} — ${label}: ${e.summary}`;
    });
    return `Past study entries${keyword ? ` matching "${keyword}"` : ""}:\n${lines.join("\n")}`;
  } catch (error) {
    return `Error searching study history: ${error.message}`;
  }
}

// Dispatches one tool_use block to its executor by name and returns the
// text for its tool_result, plus any gatherPassage() data it produced (only
// gather_passage produces this; the other tools are text-only research aids
// with nothing structured to show the frontend).
async function runTool(toolUse, { appKey, userId }) {
  switch (toolUse.name) {
    case "gather_passage":
      return runGatherTool(toolUse.input, { appKey });
    case "search_lexicon":
      return { text: await runSearchLexiconTool(toolUse.input), gathered: null };
    case "find_occurrences":
      return { text: await runFindOccurrencesTool(toolUse.input), gathered: null };
    case "search_bible_text":
      return { text: await runSearchBibleTextTool(toolUse.input), gathered: null };
    case "search_study_history":
      return { text: await runSearchStudyHistoryTool(toolUse.input, { userId }), gathered: null };
    default:
      return { text: `Error: unknown tool "${toolUse.name}".`, gathered: null };
  }
}

/**
 * Runs one turn of the chat: appends the user's message to the session's
 * history, loops against the Anthropic API — executing gather_passage,
 * search_lexicon, find_occurrences, and (for a signed-in user)
 * search_study_history tool calls as Claude asks for them — until Claude
 * gives a plain-text reply, and returns it.
 *
 * sessionId is created if not supplied or not recognized (the live,
 * ephemeral Redis/in-memory session — see lib/session-store.js).
 * conversationId is a separate, deliberately independent concept: the id of
 * the durable Supabase row this turn's message/reply get appended to for a
 * signed-in user (see appendToConversation). It defaults to the resolved
 * sessionId (the common case — a fresh conversation's durable row shares
 * its id with the live session that created it), but a caller resuming an
 * old conversation from the "previous conversations" menu after its live
 * session has idled out passes the old conversation's id here explicitly,
 * so this turn keeps appending to that same row instead of forking a new
 * one under a fresh sessionId.
 *
 * Returns { sessionId, conversationId, reply, gathered } — conversationId
 * is null for an anonymous request (userId omitted). gathered is the list
 * of gatherPassage() results (translations/original-language/commentary)
 * for every distinct reference Claude looked up while producing this reply
 * — so the frontend can show the same source material Claude actually
 * used, not just the prose answer. (search_lexicon/find_occurrences/
 * search_study_history results are text-only and only ever seen by Claude,
 * not surfaced separately to the frontend — Claude is expected to fold
 * anything relevant into its reply.)
 *
 * When userId is set (a verified Supabase user — see server.js's
 * authenticateRequest()), every passage gathered this turn is also logged
 * as a study_entries row in the background (not awaited, doesn't affect
 * this call's latency or ever fail the turn) — that's the compounding
 * study memory search_study_history later searches. The turn's user
 * message and reply are also appended, same fire-and-forget way, to a
 * durable per-conversation row (see lib/supabase.js's appendToConversation)
 * that backs the "previous conversations" menu — this is what lets a
 * signed-in user browse and resume a conversation well after its live
 * session (lib/session-store.js) has idled out. Entirely additive:
 * anonymous chat (userId omitted) behaves exactly as it always has.
 */
export async function chatTurn({
  sessionId,
  conversationId = null,
  message,
  appKey,
  apiKey,
  userId = null,
  model = process.env.SUMMARY_MODEL ?? DEFAULT_MODEL,
} = {}) {
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env to enable chat.");
  }
  if (!message || !message.trim()) {
    throw new Error("Message cannot be empty.");
  }

  // One read gets both "is this a real, recognized session" and its
  // history — avoids a separate has()-then-get() round trip, which matters
  // more now that a "read" can be a real network call to Redis, not just a
  // Map lookup.
  const existing = sessionId ? await getSession(sessionId) : undefined;
  // An unrecognized sessionId (idle-expired, evicted, or simply never seen)
  // always gets a fresh random id here, same as before accounts existed —
  // this is the live, ephemeral Redis/in-memory session, and a client
  // shouldn't be able to make the server treat an unknown id as a real,
  // continuing one. Durable conversation identity for a signed-in user (see
  // conversationId below) is a deliberately separate concept from this.
  const id = existing ? sessionId : randomUUID();
  // The id of the *durable* Supabase conversations row this turn appends
  // to (see appendToConversation below) — defaults to the live session id
  // (the common case: a normal conversation's durable row shares its id
  // with the live session that created it) but can be overridden by the
  // caller to keep appending to an old row after its live session expired
  // — see server.js's handleChat and public/app.js's loadConversation(),
  // which resume a past conversation by sending its id back as
  // conversationId while leaving sessionId unset (or optimistically set to
  // the same id, in case the live session happens to still be around).
  const resolvedConversationId = conversationId ?? id;

  // Work on a COPY of the committed history, not whatever's stored. The
  // tool loop below can throw mid-way (a transient Anthropic 5xx, our own
  // fetchWithTimeout firing, a rate limit) after already accumulating a
  // partial exchange — if that got written back to storage, the failed
  // attempt's partial state (e.g. an assistant message with tool_use, or a
  // user message with tool_result) would be permanently stuck in the
  // session even though this function never returned successfully. The
  // NEXT turn on that same session would then push its own user message
  // right after that leftover state, breaking Anthropic's strict role-
  // alternation requirement and returning a 400 on every future attempt —
  // turning one transient failure into a permanently broken conversation.
  // Writing the mutated copy back only on success (see the bottom of this
  // function) makes a turn atomic: it either fully lands, or the session is
  // left exactly as it was before this call, as if the failed attempt
  // never happened.
  const committedHistory = existing?.history ?? [];
  const history = [...committedHistory];
  history.push({ role: "user", content: message.trim() });

  const hasUser = Boolean(userId);
  // A small extra Supabase round-trip for a signed-in user, same "additive,
  // never blocking core chat" trade-off as the study-memory/conversation
  // logging elsewhere in this function — returns null instantly (no network
  // call) for an anonymous request. See getAgentNameIfPaid's own comment for
  // why this re-checks is_paid on every turn rather than trusting a stale
  // value.
  const agentName = hasUser ? await getAgentNameIfPaid(userId) : null;
  const system = buildSystemPrompt(hasUser, agentName);
  const tools = buildTools(hasUser);

  let finalReply = null;
  const gatheredThisTurn = [];
  const seenRefs = new Set();

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const data = await callAnthropic({ apiKey, model, messages: history, system, tools });
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
        const { text, gathered } = await runTool(toolUse, { appKey, userId });
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

  await setSession(id, { history: trimHistory(history), lastActiveAt: Date.now() });

  if (hasUser && gatheredThisTurn.length > 0) {
    // Fire-and-forget, deliberately not awaited: this is what actually
    // builds the compounding study memory (one row per passage gathered
    // this turn), but it's a background write, not something the user is
    // waiting on. Awaiting it would add a real network round-trip to every
    // signed-in reply's latency for no benefit the user would notice —
    // and a failure here should never take down the reply they ARE
    // waiting on, hence the .catch() rather than letting it propagate.
    const summary = finalReply.slice(0, STUDY_SUMMARY_MAX_LENGTH);
    for (const gathered of gatheredThisTurn) {
      logStudyEntry(userId, { reference: gathered.reference.usfm, summary }).catch((error) => {
        console.error(`Failed to log study entry for ${gathered.reference.usfm}:`, error.message);
      });
    }
  }

  if (hasUser) {
    // Same fire-and-forget reasoning as the study_entries logging above —
    // this durably persists the conversation for the "previous
    // conversations" menu (see lib/supabase.js's appendToConversation),
    // but it's a background write the reply shouldn't wait on or ever be
    // broken by. title/primaryBook are only candidates: appendToConversation
    // keeps whatever was already set on this conversation's row, so this is
    // safe to pass on every turn without re-deriving "is this the first
    // turn" here.
    const title = message.trim().slice(0, CONVERSATION_TITLE_MAX_LENGTH);
    const primaryBook = gatheredThisTurn.length > 0 ? bookCodeFromReference(gatheredThisTurn[0].reference.usfm) : null;
    appendToConversation(userId, resolvedConversationId, {
      title,
      primaryBook,
      entries: [
        { role: "user", text: message.trim() },
        { role: "assistant", text: finalReply, gathered: gatheredThisTurn.length > 0 ? gatheredThisTurn : null },
      ],
    }).catch((error) => {
      console.error(`Failed to persist conversation ${resolvedConversationId}:`, error.message);
    });
  }

  return { sessionId: id, conversationId: hasUser ? resolvedConversationId : null, reply: finalReply, gathered: gatheredThisTurn };
}

/**
 * Number of sessions currently held — exact for the in-memory fallback,
 * null when Redis-backed (see lib/session-store.js's getSessionCount() for
 * why). For tests/diagnostics.
 */
export function getSessionCount() {
  return storeSessionCount();
}

/** True when sessions durably survive a server restart (Redis-backed) vs. not. */
export { isDurable };

/** Drops a session's history — used by the "clear conversation" UI action. */
export async function clearSession(sessionId) {
  await deleteSession(sessionId);
}
