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
import { findCrossReferences } from "./cross-references.js";
import { fetchWithTimeout } from "./fetch-timeout.js";
import { gatherPassage } from "./gather.js";
import { getRoute, listRouteIds, resolvePlace } from "./geography.js";
import { findStrongsOccurrences, searchLexicon } from "./interlinear.js";
import {
  deleteSession,
  getSession,
  getSessionCount as storeSessionCount,
  isDurable,
  setSession,
} from "./session-store.js";
import {
  appendToConversation,
  DEFAULT_DEPTH_LEVEL,
  getPaidProfile,
  isValidDepthLevel,
  logStudyEntry,
  searchMyNotes,
  searchStudyHistory,
} from "./supabase.js";
import { formatGatheredPassage } from "./summarize.js";
import { verifyReplyQuotes } from "./verify.js";

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

// A function, not a constant, because several pieces below depend on
// whether this turn belongs to a signed-in, *paid* account (see chatTurn's
// `userId` + the getPaidProfile() lookup) — search_study_history and
// sermon/lesson-outline mode are both Pro features (see README ->
// Subscription / paid tier: everything else in this app — chat itself,
// notes, search_bible_text, the daily digest — stays free for every
// signed-in or anonymous user, nothing about that experience changes here).
// hasUser and isPaid are deliberately separate flags, not one combined
// "hasStudyMemory" boolean: a free signed-in user still needs to be told
// (via studyMemoryUpsellLine below) that this Pro feature exists but isn't
// theirs yet, which an anonymous user doesn't need cluttering their prompt
// at all. agentName is the paid-only "name your agent" feature — null for
// everyone except a paid account that's actually set one, in which case a
// short identity line is prepended so Claude answers to it naturally
// without making a big deal of it.
// Depth slider (spec item 3, free for every user -- see
// lib/supabase.js's DEPTH_LEVELS/getPaidProfile). "everyday" is written to
// match the single voice this app already had before the slider existed,
// so a user who's never touched it sees no change at all.
const DEPTH_LEVEL_PARAGRAPHS = {
  everyday:
    "The user has their depth setting on \"Everyday\": keep answers accessible to an interested layperson — plain language, minimal jargon, and if you do use a Greek/Hebrew or technical term, explain it in the same breath rather than just naming it.",
  student:
    "The user has their depth setting on \"Student\": write for someone comfortable with basic Bible-study vocabulary (Strong's numbers, NA28, that kind of thing) — use original-language terms and grammatical detail more freely than you would for a beginner, but still explain a genuinely technical point (a manuscript-tradition nuance, an unusual grammatical construction) rather than assuming it's already familiar.",
  scholar:
    "The user has their depth setting on \"Scholar\": engage at a genuinely technical level — original-language grammar, textual-critical/manuscript detail, and named scholarly positions are all fair game without translating them into lay terms first. Still be explicit about what's a contested academic position versus settled consensus, the same discipline you'd apply at any depth.",
};

// Tradition Lens (spec item 4, free for every user -- see
// lib/supabase.js's HOME_TRADITIONS/getPaidProfile). This is a genuinely
// different kind of "grounding" than gather_passage/find_cross_references:
// there's no dataset of "which tradition holds which position" to fetch,
// so the discipline has to live entirely in the instruction itself --
// name a real source (a confession, a catechism, a named theologian, a
// denomination's own stated teaching) or say plainly that you don't have
// one, the same "don't invent it" line this app draws everywhere else,
// just without a tool call to enforce it mechanically. Deliberately prose,
// not a separately-rendered UI badge -- see docs/DECISIONS.md's 2026-09-23
// entry for why a parsed structured label would be more fragile than it's
// worth for something that's inherently a judgment call, not a checkable
// fact the way a quoted verse is.
const TRADITION_LENS_PARAGRAPH =
  "When a passage's meaning is genuinely debated along real denominational or confessional lines (not just between individual commentators), say so explicitly using one of these three words as part of your answer: \"Settled\" (no real disagreement across traditions worth noting), \"Common view\" (most traditions land in the same place, with only minor or fringe dissent), or \"Debated\" (multiple traditions genuinely hold different positions). When you call something Debated, name at least two real traditions or positions and ground each in something real — a confession (e.g. the Westminster Confession), a catechism, a named theologian, or a denomination's own stated teaching — rather than a vague \"some believe... others believe\" with nothing behind it. If you don't actually know a specific real source for a position, say that plainly instead of inventing one — a guess dressed up as a named tradition's stance is worse than admitting you're not sure. Don't force this labeling onto every reply — only when a real cross-tradition disagreement is actually in view.";

const HOME_TRADITION_LABELS = {
  reformed: "Reformed",
  baptist: "Baptist",
  wesleyan: "Wesleyan/Methodist",
  lutheran: "Lutheran",
  anglican: "Anglican",
  catholic: "Catholic",
  orthodox: "Orthodox",
  pentecostal: "Pentecostal/Charismatic",
  nondenominational: "non-denominational",
};

function buildSystemPrompt(hasUser, isPaid, agentName = null, depthLevel = DEFAULT_DEPTH_LEVEL, homeTradition = null) {
  const hasStudyMemory = hasUser && isPaid;

  const identityLine = agentName
    ? `\n\nThis user has named you "${agentName}" for their own conversations, purely to make things feel a little more personal — answer to it naturally if they use it, without drawing extra attention to the name itself unless they bring it up.`
    : "";

  // Only relevant for a signed-in-but-free account: an anonymous user has no
  // account to upgrade in the first place, and a paid one already has the
  // real tool, so this line would just be noise for either of them.
  const studyMemoryUpsellLine =
    hasUser && !isPaid
      ? `\n\nThis user is signed in but on the free tier, so you do NOT have search_study_history or search_my_notes (recalling their past study and their own notes across conversations is a Pro feature). If they ask you to recall something from a past conversation or a note they wrote, let them know that's a Pro feature they can turn on from the Subscription page, rather than guessing or pretending you checked.`
      : "";

  const homeTraditionLine = HOME_TRADITION_LABELS[homeTradition]
    ? ` This user has told you their own home tradition is ${HOME_TRADITION_LABELS[homeTradition]} — when something is Debated, it's worth explicitly noting where their own tradition stands, the same real-source discipline as any other named tradition's view, without implying that's the one correct answer.`
    : "";

  const sermonOutlineParagraph = isPaid
    ? `If asked to prepare a sermon outline, lesson, or small-group discussion guide, shift into that format explicitly — this is the one case where real structure (a title, numbered points, a discussion-questions list) genuinely serves the request better than prose, since it's meant to be preached or taught from, not just read once. Ground it the same way as any other answer: gather the passage (and any cross-references worth including) first if you haven't already, and build the main points from what's actually there in the text rather than a generic template you'd produce without it. A useful outline has: a clear title; the key passage(s) by reference; 3-5 main points, each anchored to a specific verse or observation from the gathered material; and a short set of discussion or reflection questions at the end. If a point leans on background knowledge rather than what was gathered, say so the same way you would anywhere else.`
    : `If asked to prepare a sermon outline, lesson, or small-group discussion guide, let the person know warmly that structured outlines are a Pro feature (available from the Subscription page) rather than producing one — then offer to keep helping with a normal conversational answer on the passage instead, which is still fully available to them.`;

  // Observe→Interpret→Apply scaffold (spec item 8) — a classic inductive
  // Bible-study method, not new factual content, so unlike the sermon
  // outline above this is free for every user rather than Pro-gated: it's
  // a personal/small-group study habit, not a leader-facing deliverable.
  // Structure lives entirely in the instruction, same as the sermon
  // outline — no new tool needed.
  const OIA_PARAGRAPH = `If asked for a structured "Observe / Interpret / Apply" (or "OIA," or "inductive") Bible study on a passage, shift into that three-part format explicitly — free for every user, not a Pro-only structure like the sermon outline above. Gather the passage first if you haven't already, and label each section clearly (e.g. "Observe:", "Interpret:", "Apply:") so it reads as three distinct movements, not just paragraphs. Observe: what the text actually says — key words, repetition, structure, who/what/when/where — stick to what's on the page before moving to what it means. Interpret: what it meant in its original context, drawing on the gathered commentary and your own background knowledge of the historical/literary setting (marking which is which, same discipline as anywhere else). Apply: a few concrete, honest ways this might shape how someone thinks or lives today — personal application is inherently more a starting point for the reader's own reflection than a single right answer, so offer it that way rather than as a prescription.`;

  return `You are a warm, knowledgeable conversation partner for Bible study — closer to a thoughtful theologian or Bible scholar talking with someone than a search engine or report generator.${identityLine}${studyMemoryUpsellLine}

You have ${hasStudyMemory ? "eleven tools" : "nine tools"}:

- gather_passage fetches primary-source material for a specific verse: several English translations, a word-by-word breakdown of the original Greek or Hebrew with Strong's numbers and glosses, and excerpts from public-domain commentaries (Matthew Henry, Jamieson-Fausset-Brown, Barnes, Gill, Geneva Study Bible).
- search_lexicon searches the Greek and Hebrew lexicons by English keyword, surfacing the real Strong's numbers behind a concept — e.g. searching "love" finds agapaō (G0025), phileō (G5368), and Hebrew ahav (H0157), each with its own gloss.
- find_occurrences finds every verse in the tagged text containing a given Strong's number — a genuine word study grounded in the actual data, not a guess from memory about where a word "probably" shows up. Also drives a real per-book frequency chart.
- label_word_senses (optional, use after find_occurrences) groups that word's occurrences into named senses/nuances for the same chart — your own reading of which verses cluster together, checked against find_occurrences's real result so a verse can't be included that wasn't actually found there. Only worth it when a word's senses are genuinely distinct.
- search_bible_text does a full-text keyword search across the whole Bible's English text — every verse containing all of the given words, in canonical order. Use this when someone's trying to locate a specific verse or passage from a remembered phrase, wording, or idiom ("the verse about a still small voice", "where Paul talks about the peace that surpasses understanding") rather than a Strong's-number word study — it's a plain keyword match, not stemmed (searching "love" won't also find "loved" or "loving") and not phrase-order-aware.
- find_cross_references looks up real, curated connections for a verse from a licensed scholarly dataset (chiefly the Treasury of Scripture Knowledge) — this also draws a visual diagram for the user, so it's worth calling whenever a passage's connections to the rest of Scripture are genuinely relevant to the question (tracing a theme, or a passage well-known for its cross-references), not just relying on your own recall of what connects to what.
- label_cross_reference_types (optional, use after find_cross_references) classifies that focus verse's returned connections as a quotation, an allusion, or just thematic — the dataset itself doesn't carry this distinction, so it's your own reading, checked against find_cross_references's real result so a connection can't be typed that wasn't actually returned. Only worth it when the distinction itself adds something.
- generate_map draws a real map — a curated named journey (Paul's missionary journeys, the Exodus, Abraham's journey from Ur) and/or specific places — resolved against a real, scholarly-sourced geography dataset rather than a coordinate you'd otherwise have to guess. Use it for genuinely geographic questions (where something was relative to somewhere else, tracing a journey, understanding distances), not for every place mention.
- generate_passage_briefing produces a small "briefing card" (genre, traditional author, approximate date, where the passage sits in the book's structure) from your own background knowledge — there's no dataset behind this one, so be honest in the fields themselves about real scholarly disagreement rather than asserting false certainty. Call it once near the start of a conversation about a passage when that orientation would genuinely help, not on every message.${
    hasStudyMemory
      ? `
- search_study_history searches this specific user's own past study — passages they've looked at in earlier conversations, going back further than this conversation's own history. Use it when a genuine callback would help: they ask something like "have I looked at this before," a passage or word connects to something they studied a while ago and pointing that out would add real insight, or they ask you to recall something specific. Don't call it reflexively on every message — only when past history is actually likely to matter to the current question.
- search_my_notes searches this user's own written notes — not your research log, but things they personally sat down and wrote on a passage. This is often the stronger signal of what they actually care about, since a note is something they chose to write down rather than just something you gathered. Use it the same way as search_study_history: when they ask about something they wrote, or when surfacing a note they left on a related passage would genuinely add insight — not on every message.`
      : ""
  }

Call gather_passage whenever you need material for a verse — this includes the verse the user names, and any cross-reference you think of yourself that would genuinely help answer their question. For a topical or "what else does Scripture say about X" question, prefer search_lexicon and find_occurrences over relying on memory alone: search_lexicon to find the actual underlying word(s), find_occurrences to see where they're really used, then gather_passage on whichever specific verses look most worth discussing in depth. This is what lets you ground a topical answer in the real tagged text instead of a general impression — reach for it especially when precision about a word's actual distribution matters to the question. Reach for search_bible_text instead when someone's trying to locate a verse by its wording rather than study a concept — it's the more direct match for "what's that verse that says..." than a lexicon search would be. General biblical knowledge (historical context, theological traditions, how a book is structured) is still fine to draw on for things these tools don't cover — just be clear when you're doing that versus reporting from gathered or searched data. Don't repeat a tool call whose result is already earlier in this conversation; reuse what you have.

If a question has no specific verse in view yet, it's fine to ask the user what passage they have in mind, or to reach for one yourself if it obviously fits the question.

Ground what you say in material you've actually gathered or searched: don't invent a claim and attribute it to a specific translation or commentary you haven't seen via the tool. If you're drawing on general background knowledge rather than gathered sources, say so plainly rather than presenting it as if it came from the tool. When commentators or translations genuinely disagree, present that as disagreement instead of picking a side for the user.

If asked for historical context beyond what the tools cover — what was happening in the wider world around a passage, early church history, how a book or event fits into the broader timeline of history — share what you actually know rather than deflecting to "I can't help with that." This is general knowledge, not something gathered or searched, so flag it as such (e.g. "this is background history, not from the sources above") the same way you would for any other general-knowledge claim.

${sermonOutlineParagraph}

${OIA_PARAGRAPH}

${DEPTH_LEVEL_PARAGRAPHS[depthLevel] ?? DEPTH_LEVEL_PARAGRAPHS[DEFAULT_DEPTH_LEVEL]}

${TRADITION_LENS_PARAGRAPH}${homeTraditionLine}

Write like you're talking, not filing a report: prose, not section headers or bullet-point dumps, unless the user's question specifically calls for a list, is a sermon/lesson/discussion-guide request from a paid account, or is an Observe/Interpret/Apply study request (see both above), either of which gets the structured format described above instead. Keep replies focused — a few solid paragraphs at most, more only if the question genuinely needs it.

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
    "Find every verse in the tagged text containing a given Strong's number — a real word study grounded in the actual data. Use this after search_lexicon identifies a relevant number, or directly if you already know the number from a gathered passage's word list. Returns a capped list of occurrences plus the true total count, so a very common word is honestly reported as common rather than silently truncated with no indication there's more. Also drives a real frequency-by-book chart for the user (Word-Study Web) — every book it's plotted in is a genuine count from the tagged text, not an estimate.",
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

// Word-Study Web's optional sense-clustering layer (spec item 6). The
// frequency-by-book chart above is fully grounded (a real count from the
// tagged text); clustering occurrences into named senses/nuances is a
// genuine interpretive judgment call the dataset itself doesn't encode
// (see docs/DECISIONS.md's 2026-09-23 entry) — Claude's own reading, not
// a fact. What keeps this honest isn't the labels (which can't be
// verified against anything) but the MEMBERSHIP: every reference in every
// group is checked against find_occurrences's own real result for that
// Strong's number this turn (see runLabelWordSensesTool), so a verse
// can't sneak into the chart that was never actually found in the tagged
// text — only which bucket a real verse belongs to is Claude's call.
const LABEL_WORD_SENSES_TOOL = {
  name: "label_word_senses",
  description:
    'Groups the occurrences a find_occurrences call already returned THIS turn into named senses or nuances (e.g. agapaō used for God\'s love, for love among believers, and for a simple request in John 21) — drives an optional grouping in the Word-Study Web chart. This is your own reading of the data, not something the tagged text itself labels: only call it after find_occurrences for the same Strong\'s number, and only include references that call actually returned — a reference it didn\'t return will be rejected. Optional and not for every word study — only when the senses are genuinely distinct and worth visualizing (a word with one flat, undifferentiated usage doesn\'t need this).',
  input_schema: {
    type: "object",
    properties: {
      strongsNumber: {
        type: "string",
        description: "The same Strong's number passed to find_occurrences earlier this conversation.",
      },
      senseGroups: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: {
              type: "string",
              description: 'A short name for this sense/nuance, e.g. "God\'s love for humanity".',
            },
            references: {
              type: "array",
              items: { type: "string" },
              description: 'USFM references from find_occurrences\'s own result for this word, e.g. ["JHN.3.16", "1JN.4.8"].',
            },
          },
          required: ["label", "references"],
        },
        description: "Two or more groups, each covering a distinct sense.",
      },
    },
    required: ["strongsNumber", "senseGroups"],
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

// Distinct from the cross-references Claude might mention in its own prose
// (via gather_passage on a verse it thought of itself) — this is a second,
// independent source: a licensed, curated dataset (see
// lib/cross-references.js's header comment) someone else compiled, mostly
// from the 19th-century Treasury of Scripture Knowledge. Calling this
// surfaces real, structured connections the frontend can draw as a diagram,
// rather than relying on the model's own recall of what connects to what.
const FIND_CROSS_REFERENCES_TOOL = {
  name: "find_cross_references",
  description:
    "Looks up real, curated cross-references for a verse from a licensed scholarly dataset (chiefly the Treasury of Scripture Knowledge) — verses commonly connected to it by theme, quotation, or allusion, ranked by how often that connection is drawn. Use this when a passage's connections to the rest of Scripture are themselves worth surfacing (e.g. \"what does this connect to,\" tracing a theme, or a passage famous for its cross-references like John 3:16 or Genesis 1:1) — this also drives a visual diagram shown to the user, so it's worth calling even when you'd reach the same verses on your own, since it grounds the connection in a real source rather than just your own say-so. Don't call it for every passage reflexively — only when connections are genuinely relevant to the question. The dataset itself doesn't say whether a connection is a direct quotation, an allusion, or just thematic — call label_cross_reference_types afterward if that distinction is genuinely worth drawing out.",
  input_schema: {
    type: "object",
    properties: {
      reference: {
        type: "string",
        description: 'USFM-style reference: 3-letter book code, chapter, verse, dot-separated. Examples: "JHN.3.16", "GEN.1.1".',
      },
      limit: {
        type: "integer",
        description: "Max cross-references to return (default 8, capped at 30).",
      },
    },
    required: ["reference"],
  },
};

// Cross-Reference Constellation's quote/allusion/thematic distinction
// (spec item 7). Same split as Word-Study Web's sense-clustering: the
// CONNECTIONS themselves are real, dataset-backed data (openbible.info,
// see FIND_CROSS_REFERENCES_TOOL above); which of the three categories a
// given connection falls into is not encoded in that dataset anywhere, so
// it's Claude's own reading, not a fact — what's checked mechanically is
// only that every reference being typed was actually among that same
// find_cross_references call's real results this turn (see
// runLabelCrossReferenceTypesTool), never a connection invented for the
// occasion.
const LABEL_CROSS_REFERENCE_TYPES_TOOL = {
  name: "label_cross_reference_types",
  description:
    'Classifies the connections a find_cross_references call already returned THIS turn as a direct quotation, an allusion, or just thematic — the dataset itself only says a connection exists and how often it\'s cited, not which kind it is. This is your own reading, not something the dataset labels: only call it after find_cross_references for the same focus verse, and only classify references that call actually returned — one it didn\'t return will be rejected. Optional, and not worth doing for every cross-reference list — reach for it when the type distinction itself would genuinely help (e.g. showing that a NT verse is a direct OT quotation versus a looser thematic echo).',
  input_schema: {
    type: "object",
    properties: {
      reference: {
        type: "string",
        description: "The same focus verse passed to find_cross_references earlier this conversation.",
      },
      links: {
        type: "array",
        items: {
          type: "object",
          properties: {
            reference: {
              type: "string",
              description: "One of the references find_cross_references's own result for this focus verse returned.",
            },
            type: {
              type: "string",
              enum: ["quotation", "allusion", "thematic"],
              description: '"quotation" for a direct verbal quotation, "allusion" for a clear but indirect reference, "thematic" for a shared theme/topic without direct verbal dependence.',
            },
          },
          required: ["reference", "type"],
        },
        description: "One entry per reference you want to classify — not every returned reference needs one.",
      },
    },
    required: ["reference", "links"],
  },
};

// Plots real places on a map — never a coordinate Claude invents. Every
// point traces back to lib/geography.js's resolvePlace(), which resolves a
// place name against a licensed, scholarly-sourced dataset (see that
// file's header comment) and honestly reports "identified" vs. "disputed"
// (or "not found"/"ambiguous") from the real data rather than asserting
// false confidence. `route` covers the curated named journeys (see
// lib/geography.js's ROUTES); `locations` is for ad-hoc places outside any
// curated route. At least one of the two should be given; both together is
// fine (e.g. a route plus one extra place of interest).
const GENERATE_MAP_TOOL = {
  name: "generate_map",
  description:
    "Draws a map of real biblical geography — a named journey (Paul's missionary journeys, the Exodus, Abraham's journey from Ur) and/or specific places you name. Every location is resolved against a real, scholarly-sourced dataset, not guessed: a well-attested site (Jerusalem, Rome) is marked identified, while a genuinely disputed one (Mount Sinai, Sodom, most Exodus wilderness stops) is marked disputed rather than asserting false certainty, and a place the dataset doesn't recognize is reported back rather than silently omitted or invented. Use this for geographic questions — where a place was relative to others, tracing a journey, understanding the distances involved — since a map genuinely adds something prose can't. Don't call it for every place mention; only when the geography itself is worth seeing.",
  input_schema: {
    type: "object",
    properties: {
      route: {
        type: "string",
        enum: listRouteIds(),
        description: "One of the curated named journeys. Omit if the request is just about specific places, not a journey.",
      },
      locations: {
        type: "array",
        items: { type: "string" },
        description: 'Specific place names to plot, e.g. ["Corinth", "Ephesus"]. Use well-known English names; if a name is genuinely ambiguous (e.g. more than one biblical place called "Antioch") or unrecognized, the result will say so rather than guessing.',
      },
    },
  },
};

// Passage Briefing card (spec item 5): genre/author/date/structure is
// exactly the kind of general background knowledge lib/chat.js's own
// system prompt already tells Claude it's fine to draw on and disclose as
// such (see the "historical context" paragraph below) — there's no
// dataset of "this book's genre/traditional author/date" the way there is
// for cross-references or geocoding, so unlike every other tool in this
// file, this one doesn't fetch or verify anything server-side. What it
// DOES do: force the content into a fixed, structured shape (so the
// frontend can render a consistent card instead of parsing prose) and
// carry an explicit "general background, not verified against a dataset"
// disclosure through to the rendered card — same "don't let structure
// impersonate verified fact" discipline as Tradition Lens's prose-only
// design (see docs/DECISIONS.md's 2026-09-23 entry). A genuinely
// geographic setting is a job for generate_map (a real, separate tool
// backed by a real dataset), not something this tool tries to duplicate.
const PASSAGE_BRIEFING_TOOL = {
  name: "generate_passage_briefing",
  description:
    "Produces a structured \"briefing card\" for a book or passage — genre, traditional authorship, approximate date, and where the passage sits in the book's own structure — shown to the user as a small card alongside your reply. This is background knowledge you already have, not something fetched from a dataset (there's no such dataset for this), so fill in only what you actually know and be honest in the fields themselves about real scholarly disagreement (e.g. traditionalAuthor: \"Traditionally Solomon; many critical scholars date it later and consider authorship anonymous\") rather than asserting false certainty. Call this once near the start of a conversation about a passage when that context would genuinely help orient the user (a whole-book question, or someone clearly new to the passage) — not on every message, and not a substitute for gather_passage. If the setting is a specific real place worth seeing on a map, call generate_map separately for that.",
  input_schema: {
    type: "object",
    properties: {
      reference: {
        type: "string",
        description: 'USFM-style reference (or a book-level reference like "PSA" for a whole-book briefing): 3-letter book code, optionally chapter.verse. Examples: "JHN.3.16", "PSA", "ROM".',
      },
      genre: {
        type: "string",
        description: 'The book\'s literary genre, e.g. "Wisdom literature", "Pauline epistle", "Apocalyptic", "Narrative history".',
      },
      traditionalAuthor: {
        type: "string",
        description: "Who tradition attributes the book to, noting real scholarly disagreement where it exists rather than picking one side silently.",
      },
      approximateDate: {
        type: "string",
        description: "Roughly when the book was written, again noting disagreement between traditional and critical dating where it's real rather than asserting one.",
      },
      structureNote: {
        type: "string",
        description: 'Where this passage sits in the book\'s own structure — e.g. "Part of the second discourse (chapters 5-7, the Sermon on the Mount); this verse closes the section on almsgiving, prayer, and fasting."',
      },
      setting: {
        type: "string",
        description: "Optional: a brief note on the historical/geographic setting, if genuinely relevant. Don't duplicate a map here — call generate_map separately for that.",
      },
    },
    required: ["reference", "genre", "traditionalAuthor", "approximateDate", "structureNote"],
  },
};

const TOOLS = [
  GATHER_TOOL,
  SEARCH_LEXICON_TOOL,
  FIND_OCCURRENCES_TOOL,
  LABEL_WORD_SENSES_TOOL,
  SEARCH_BIBLE_TEXT_TOOL,
  FIND_CROSS_REFERENCES_TOOL,
  LABEL_CROSS_REFERENCE_TYPES_TOOL,
  GENERATE_MAP_TOOL,
  PASSAGE_BRIEFING_TOOL,
];

// Only ever added to the tools array for a signed-in, PAID user (see
// chatTurn's buildTools()) — search_study_history is a Pro feature (see
// README -> Subscription / paid tier). Claude never sees this tool at all
// otherwise, so there's no risk of it trying to call something that isn't
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

// Same gating as SEARCH_STUDY_HISTORY_TOOL (signed-in + paid only) and the
// same reasoning — see lib/supabase.js's searchMyNotes() comment for why
// this is a second, separate tool rather than folded into
// search_study_history: a note is something the user chose to write
// themselves, not something Claude gathered on their behalf, and keeping
// the two tools distinct keeps that distinction legible to Claude too.
const SEARCH_MY_NOTES_TOOL = {
  name: "search_my_notes",
  description:
    'Searches this user\'s own saved notes — things they personally wrote on a passage (not your own research log; use search_study_history for that). Pass a keyword to filter (matched against the note\'s reference and body text); omit it to get their most recent notes. Use this for genuine callbacks to something they wrote ("you noted something similar when you studied this last month"), not on every message.',
  input_schema: {
    type: "object",
    properties: {
      keyword: {
        type: "string",
        description: 'Optional keyword to filter by, e.g. "grace", or a reference like "JHN.3.16". Omit to get recent notes unfiltered.',
      },
      limit: {
        type: "integer",
        description: "Max notes to return (default 10, capped at 50).",
      },
    },
  },
};

// Builds the tools array for one turn — the base six tools always,
// search_study_history and search_my_notes only for a signed-in, paid user
// (see the SEARCH_STUDY_HISTORY_TOOL/SEARCH_MY_NOTES_TOOL comments above).
function buildTools(hasUser, isPaid) {
  return hasUser && isPaid ? [...TOOLS, SEARCH_STUDY_HISTORY_TOOL, SEARCH_MY_NOTES_TOOL] : TOOLS;
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

// Executes a find_occurrences tool call. Returns { text, wordStudy }:
// text is what goes back to Claude, wordStudy is the structured payload
// (real per-book frequency data, plus the exact capped occurrence list
// this call actually returned) the frontend draws AND the turn-scoped
// state a later label_word_senses call is validated against — same "what
// Claude saw and what the user sees are the same data" split as
// runGatherTool()/runGenerateMapTool(). `strongsNumber` on the returned
// wordStudy is normalized (trim + uppercase) so a later label_word_senses
// call naming the same number in different casing still matches.
async function runFindOccurrencesTool(input) {
  const strongsNumber = (input?.strongsNumber ?? "").trim();
  if (!strongsNumber) {
    return { text: "Error: find_occurrences was called without a strongsNumber.", wordStudy: null };
  }
  const limit = Number.isInteger(input?.limit) && input.limit > 0 ? Math.min(input.limit, 50) : 20;

  try {
    const { occurrences, totalCount, byBook, error } = await findStrongsOccurrences(strongsNumber, { limit });
    if (error) return { text: `Error: ${error}`, wordStudy: null };
    if (occurrences.length === 0) {
      return { text: `No occurrences found for ${strongsNumber}.`, wordStudy: null };
    }
    const lines = occurrences.map((o) => `${o.reference}: ${o.surface} — ${o.gloss}`);
    const truncatedNote =
      totalCount > occurrences.length
        ? `\n(${totalCount} total occurrences; showing ${occurrences.length}.)`
        : "";
    return {
      text: `Occurrences of ${strongsNumber}:\n${lines.join("\n")}${truncatedNote}`,
      wordStudy: { strongsNumber: strongsNumber.toUpperCase(), occurrences, totalCount, byBook, senseGroups: [] },
    };
  } catch (error) {
    return { text: `Error finding occurrences: ${error.message}`, wordStudy: null };
  }
}

// Caps on label_word_senses's own input — not a security boundary (model
// output, not user input), same sanity-bound reasoning as
// BRIEFING_FIELD_MAX_LENGTH above.
const SENSE_LABEL_MAX_LENGTH = 120;
const MAX_SENSE_GROUPS = 8;

// Executes a label_word_senses tool call. Unlike the frequency-by-book
// data above, sense grouping is Claude's own interpretive read of the
// data (see LABEL_WORD_SENSES_TOOL's own comment) — what keeps it honest
// is validating every referenced verse against `wordStudiesThisTurn`
// (this turn's real find_occurrences results, passed in read-only by
// chatTurn's tool loop): a verse that was never actually returned by
// find_occurrences for this Strong's number is rejected outright, not
// silently dropped, so Claude gets a clear, correctable error rather than
// a quietly incomplete chart. Returns { text, strongsNumber, senseGroups }
// — senseGroups is null on any validation failure; the tool loop only
// attaches it to the real wordStudy entry on success.
function runLabelWordSensesTool(input, wordStudiesThisTurn) {
  const strongsNumber = (input?.strongsNumber ?? "").trim().toUpperCase();
  if (!strongsNumber) {
    return { text: "Error: label_word_senses was called without a strongsNumber.", strongsNumber, senseGroups: null };
  }

  const entry = wordStudiesThisTurn.get(strongsNumber);
  if (!entry) {
    return {
      text: `Error: call find_occurrences for ${strongsNumber} earlier this turn before label_word_senses.`,
      strongsNumber,
      senseGroups: null,
    };
  }

  const groupsInput = Array.isArray(input?.senseGroups) ? input.senseGroups : [];
  if (groupsInput.length < 2) {
    return { text: "Error: label_word_senses needs at least two distinct sense groups.", strongsNumber, senseGroups: null };
  }
  if (groupsInput.length > MAX_SENSE_GROUPS) {
    return { text: `Error: too many sense groups (max ${MAX_SENSE_GROUPS}).`, strongsNumber, senseGroups: null };
  }

  const realReferences = new Set(entry.occurrences.map((o) => o.reference));
  const unknownReferences = [];
  const senseGroups = [];
  for (const group of groupsInput) {
    const label = (group?.label ?? "").trim().slice(0, SENSE_LABEL_MAX_LENGTH);
    const references = Array.isArray(group?.references) ? group.references.map((r) => (r ?? "").trim()) : [];
    if (!label || references.length === 0) {
      return { text: "Error: each sense group needs a label and at least one reference.", strongsNumber, senseGroups: null };
    }
    for (const reference of references) {
      if (!realReferences.has(reference)) unknownReferences.push(reference);
    }
    senseGroups.push({ label, references });
  }

  if (unknownReferences.length > 0) {
    return {
      text: `Error: these references weren't in find_occurrences's own result for ${strongsNumber}, so no sense groups were recorded: ${[...new Set(unknownReferences)].join(", ")}. Only group references that call actually returned.`,
      strongsNumber,
      senseGroups: null,
    };
  }

  return { text: `Sense groups recorded for ${strongsNumber}.`, strongsNumber, senseGroups };
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

// Executes a find_cross_references tool call. Returns { text, diagram }:
// text is what goes back to Claude as the tool_result content, diagram is
// the structured { reference, results } payload (or null on failure/no
// data) the frontend draws as a diagram — same "what Claude saw and what
// the user sees are the same data" reasoning as runGatherTool()'s
// { text, gathered } split.
async function runFindCrossReferencesTool(input) {
  const reference = (input?.reference ?? "").trim().toUpperCase();
  if (!reference) {
    return { text: "Error: find_cross_references was called without a reference.", diagram: null };
  }
  const limit = Number.isInteger(input?.limit) && input.limit > 0 ? Math.min(input.limit, 30) : 8;

  try {
    const { results, totalCount } = await findCrossReferences(reference, { limit });
    if (results.length === 0) {
      return { text: `No cross-references found for ${reference}.`, diagram: null };
    }
    const lines = results.map((r) => `${r.reference} (votes: ${r.votes})`);
    const truncatedNote = totalCount > results.length ? `\n(${totalCount} total; showing ${results.length}.)` : "";
    return {
      text: `Cross-references for ${reference}, most commonly cited first:\n${lines.join("\n")}${truncatedNote}`,
      // type starts null on every result — only set (by
      // runLabelCrossReferenceTypesTool, via the tool loop) once a
      // label_cross_reference_types call for this same focus verse both
      // happens and passes validation this turn.
      diagram: { reference, results: results.map((r) => ({ ...r, type: null })), totalCount },
    };
  } catch (error) {
    return { text: `Error finding cross-references: ${error.message}`, diagram: null };
  }
}

const CROSS_REFERENCE_TYPES = ["quotation", "allusion", "thematic"];

// Executes a label_cross_reference_types tool call. Same honesty
// discipline as runLabelWordSensesTool: the TYPE a connection gets is
// Claude's own judgment (unverifiable), but which references it's even
// allowed to type is checked against `crossReferenceDiagramsByFocus`
// (this turn's real find_cross_references results, passed in read-only by
// chatTurn's tool loop) — a reference that call never returned is
// rejected outright, not silently ignored. Returns
// { text, reference, typedLinks } — typedLinks is null on any validation
// failure; the tool loop only mutates the real diagram's results on
// success.
function runLabelCrossReferenceTypesTool(input, crossReferenceDiagramsByFocus) {
  const reference = (input?.reference ?? "").trim().toUpperCase();
  if (!reference) {
    return { text: "Error: label_cross_reference_types was called without a reference.", reference, typedLinks: null };
  }

  const diagram = crossReferenceDiagramsByFocus.get(reference);
  if (!diagram) {
    return {
      text: `Error: call find_cross_references for ${reference} earlier this turn before label_cross_reference_types.`,
      reference,
      typedLinks: null,
    };
  }

  const linksInput = Array.isArray(input?.links) ? input.links : [];
  if (linksInput.length === 0) {
    return { text: "Error: label_cross_reference_types needs at least one link to classify.", reference, typedLinks: null };
  }

  const realReferences = new Set(diagram.results.map((r) => r.reference));
  const unknownReferences = [];
  const typedLinks = [];
  for (const link of linksInput) {
    const linkReference = (link?.reference ?? "").trim();
    const type = link?.type;
    if (!linkReference || !CROSS_REFERENCE_TYPES.includes(type)) {
      return {
        text: `Error: each link needs a reference and a type (one of: ${CROSS_REFERENCE_TYPES.join(", ")}).`,
        reference,
        typedLinks: null,
      };
    }
    if (!realReferences.has(linkReference)) unknownReferences.push(linkReference);
    typedLinks.push({ reference: linkReference, type });
  }

  if (unknownReferences.length > 0) {
    return {
      text: `Error: these references weren't in find_cross_references's own result for ${reference}, so no types were recorded: ${[...new Set(unknownReferences)].join(", ")}. Only classify references that call actually returned.`,
      reference,
      typedLinks: null,
    };
  }

  return { text: `Cross-reference types recorded for ${reference}.`, reference, typedLinks };
}

// Resolves a list of place names against lib/geography.js's real dataset,
// splitting results into { points, unresolved } — unresolved covers both
// "not in the dataset at all" and "ambiguous between real, distinct
// places" (see resolvePlaceName()'s own comment), each reported with
// enough detail that Claude can explain the gap rather than silently
// dropping the place. Returns { points: null, error } instead if the data
// file itself isn't available, so the caller can short-circuit with one
// clear error rather than reporting every name as individually unresolved.
async function resolvePlaceNames(names) {
  const points = [];
  const unresolved = [];
  for (const name of names) {
    let result;
    try {
      result = await resolvePlace(name);
    } catch (error) {
      return { points: null, unresolved: null, error };
    }
    if (result.found) {
      points.push({ name, modernName: result.modernName, lon: result.lon, lat: result.lat, certainty: result.certainty });
    } else if (result.ambiguous) {
      unresolved.push({ name, reason: "ambiguous", options: result.options.map((o) => o.modernName) });
    } else {
      unresolved.push({ name, reason: "not_found" });
    }
  }
  return { points, unresolved, error: null };
}

// Executes a generate_map tool call. Returns { text, map }: text is what
// goes back to Claude, map is the structured payload (route metadata,
// resolved waypoints/extra points, and anything left unresolved) the
// frontend draws — same "what Claude saw and what the user sees are the
// same data" split as runGatherTool() and runFindCrossReferencesTool().
async function runGenerateMapTool(input) {
  const routeId = typeof input?.route === "string" ? input.route.trim() : "";
  const locationNames = Array.isArray(input?.locations)
    ? input.locations.filter((n) => typeof n === "string" && n.trim()).map((n) => n.trim())
    : [];

  if (!routeId && locationNames.length === 0) {
    return { text: "Error: generate_map needs either a route or at least one location.", map: null };
  }

  const route = routeId ? getRoute(routeId) : null;
  if (routeId && !route) {
    return { text: `Error: unknown route "${routeId}".`, map: null };
  }

  const routeResolved = route ? await resolvePlaceNames(route.waypoints) : { points: [], unresolved: [], error: null };
  if (routeResolved.error) {
    return { text: `Error generating map: ${routeResolved.error.message}`, map: null };
  }
  const extraResolved = await resolvePlaceNames(locationNames);
  if (extraResolved.error) {
    return { text: `Error generating map: ${extraResolved.error.message}`, map: null };
  }

  const unresolved = [...routeResolved.unresolved, ...extraResolved.unresolved];
  if (routeResolved.points.length === 0 && extraResolved.points.length === 0) {
    return {
      text: `Couldn't plot anything — none of the given places resolved against the geography dataset (${unresolved.map((u) => u.name).join(", ")}).`,
      map: null,
    };
  }

  const map = {
    title: route ? route.name : "Places",
    route: route ? { id: routeId, name: route.name, description: route.description, certaintyNote: route.certaintyNote } : null,
    waypoints: routeResolved.points,
    extraPoints: extraResolved.points,
    unresolved,
  };

  const lines = [];
  if (route) {
    lines.push(`Route: ${route.name} — ${route.description}`, route.certaintyNote);
    lines.push(...routeResolved.points.map((p) => `${p.name} → ${p.modernName} (${p.certainty})`));
  }
  if (extraResolved.points.length > 0) {
    lines.push(...extraResolved.points.map((p) => `${p.name} → ${p.modernName} (${p.certainty})`));
  }
  if (unresolved.length > 0) {
    lines.push(
      `Not plotted: ${unresolved
        .map((u) => (u.reason === "ambiguous" ? `${u.name} (ambiguous — could mean ${u.options.join(" or ")}; ask which one, or a map won't include it)` : `${u.name} (not in the geography dataset)`))
        .join("; ")}`,
    );
  }

  return { text: `Map generated.\n${lines.join("\n")}`, map };
}

// Caps each free-text field Claude fills in — not a security boundary
// (this is model output, not user input), just a sanity bound so one
// overlong field can't blow up the rendered card. Generous relative to
// what a real answer needs (a couple of sentences at most per field).
const BRIEFING_FIELD_MAX_LENGTH = 500;

function truncateBriefingField(value) {
  const trimmed = (typeof value === "string" ? value : "").trim();
  return trimmed.length > BRIEFING_FIELD_MAX_LENGTH ? `${trimmed.slice(0, BRIEFING_FIELD_MAX_LENGTH).trimEnd()}…` : trimmed;
}

// Executes a generate_passage_briefing tool call. Unlike every other tool
// in this file, there's no server-side lookup here — see
// PASSAGE_BRIEFING_TOOL's own comment for why. `briefing` carries an
// explicit `disclosure` string through to the frontend so the rendered
// card never reads as a verified fact the way, say, a gathered
// translation does.
async function runPassageBriefingTool(input) {
  const reference = (input?.reference ?? "").trim().toUpperCase();
  const genre = truncateBriefingField(input?.genre);
  const traditionalAuthor = truncateBriefingField(input?.traditionalAuthor);
  const approximateDate = truncateBriefingField(input?.approximateDate);
  const structureNote = truncateBriefingField(input?.structureNote);
  const setting = truncateBriefingField(input?.setting);

  const missing = [
    !reference && "reference",
    !genre && "genre",
    !traditionalAuthor && "traditionalAuthor",
    !approximateDate && "approximateDate",
    !structureNote && "structureNote",
  ].filter(Boolean);
  if (missing.length > 0) {
    return { text: `Error: generate_passage_briefing is missing required field(s): ${missing.join(", ")}.`, briefing: null };
  }

  const briefing = {
    reference,
    genre,
    traditionalAuthor,
    approximateDate,
    structureNote,
    setting: setting || null,
    disclosure: "General background from the model's own knowledge, not verified against a dataset.",
  };

  return { text: `Briefing card created for ${reference}.`, briefing };
}

// Executes a search_study_history tool call. Only ever dispatched when
// userId is set AND the account is paid (the tool isn't in the tools array
// otherwise), but checked again here anyway rather than trusting that
// invariant blindly — Claude echoes tool names back from the request we
// sent it, so this should be unreachable otherwise, but "should be
// unreachable" isn't the same guarantee as "isn't."
async function runSearchStudyHistoryTool(input, { userId, isPaid }) {
  if (!userId || !isPaid) {
    return "Error: search_study_history is not available (requires a signed-in, paid account).";
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

// Executes a search_my_notes tool call. Same gating and same
// "unreachable but checked anyway" reasoning as runSearchStudyHistoryTool.
async function runSearchMyNotesTool(input, { userId, isPaid }) {
  if (!userId || !isPaid) {
    return "Error: search_my_notes is not available (requires a signed-in, paid account).";
  }
  const keyword = (input?.keyword ?? "").trim() || undefined;
  const limit = Number.isInteger(input?.limit) && input.limit > 0 ? Math.min(input.limit, 50) : 10;

  try {
    const notes = await searchMyNotes(userId, { keyword, limit });
    if (notes.length === 0) {
      return keyword ? `No notes found matching "${keyword}".` : "No saved notes yet.";
    }
    const lines = notes.map((n) => {
      const when = new Date(n.created_at).toISOString().slice(0, 10);
      return `${when} — ${n.reference}: ${n.body}`;
    });
    return `Notes${keyword ? ` matching "${keyword}"` : ""}:\n${lines.join("\n")}`;
  } catch (error) {
    return `Error searching notes: ${error.message}`;
  }
}

// Dispatches one tool_use block to its executor by name and returns the
// text for its tool_result, plus any gatherPassage() data, cross-reference
// diagram, or map it produced (only gather_passage/find_cross_references/
// generate_map produce these; the other tools are text-only research aids
// with nothing structured to show the frontend).
const EMPTY_TOOL_RESULT = {
  gathered: null,
  diagram: null,
  map: null,
  briefing: null,
  wordStudy: null,
  labeledSenses: null,
  labeledCrossReferenceTypes: null,
};

async function runTool(toolUse, { appKey, userId, isPaid, wordStudiesThisTurn, crossReferenceDiagramsByFocus }) {
  switch (toolUse.name) {
    case "gather_passage": {
      const { text, gathered } = await runGatherTool(toolUse.input, { appKey });
      return { text, ...EMPTY_TOOL_RESULT, gathered };
    }
    case "search_lexicon":
      return { text: await runSearchLexiconTool(toolUse.input), ...EMPTY_TOOL_RESULT };
    case "find_occurrences": {
      const { text, wordStudy } = await runFindOccurrencesTool(toolUse.input);
      return { text, ...EMPTY_TOOL_RESULT, wordStudy };
    }
    case "label_word_senses": {
      const { text, strongsNumber, senseGroups } = runLabelWordSensesTool(toolUse.input, wordStudiesThisTurn);
      return { text, ...EMPTY_TOOL_RESULT, labeledSenses: senseGroups ? { strongsNumber, senseGroups } : null };
    }
    case "search_bible_text":
      return { text: await runSearchBibleTextTool(toolUse.input), ...EMPTY_TOOL_RESULT };
    case "find_cross_references": {
      const { text, diagram } = await runFindCrossReferencesTool(toolUse.input);
      return { text, ...EMPTY_TOOL_RESULT, diagram };
    }
    case "label_cross_reference_types": {
      const { text, reference, typedLinks } = runLabelCrossReferenceTypesTool(toolUse.input, crossReferenceDiagramsByFocus);
      return { text, ...EMPTY_TOOL_RESULT, labeledCrossReferenceTypes: typedLinks ? { reference, typedLinks } : null };
    }
    case "generate_map": {
      const { text, map } = await runGenerateMapTool(toolUse.input);
      return { text, ...EMPTY_TOOL_RESULT, map };
    }
    case "generate_passage_briefing": {
      const { text, briefing } = await runPassageBriefingTool(toolUse.input);
      return { text, ...EMPTY_TOOL_RESULT, briefing };
    }
    case "search_study_history":
      return { text: await runSearchStudyHistoryTool(toolUse.input, { userId, isPaid }), ...EMPTY_TOOL_RESULT };
    case "search_my_notes":
      return { text: await runSearchMyNotesTool(toolUse.input, { userId, isPaid }), ...EMPTY_TOOL_RESULT };
    default:
      return { text: `Error: unknown tool "${toolUse.name}".`, ...EMPTY_TOOL_RESULT };
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
 * Returns { sessionId, conversationId, reply, gathered, crossReferences,
 * maps, briefings, wordStudies, quoteVerification } — conversationId is
 * null for an anonymous request (userId omitted). gathered is the list of
 * gatherPassage() results (translations/original-language/commentary) for
 * every distinct reference Claude looked up while producing this reply —
 * so the frontend can show the same source material Claude actually used,
 * not just the prose answer. crossReferences is the list of
 * find_cross_references() results (one entry per distinct focus verse
 * Claude looked up), each { reference, results, totalCount } — each item
 * in `results` also carries a `type` ("quotation"/"allusion"/"thematic"),
 * null unless a later label_cross_reference_types call for the same focus
 * verse passed validation (see runLabelCrossReferenceTypesTool's own
 * comment for what that checks) — Claude's own reading, never a guess at
 * a distinction nobody asked it to draw. maps is the
 * list of generate_map() results (one per call), each { title, route,
 * waypoints, extraPoints, unresolved } — see lib/geography.js. briefings
 * is the list of generate_passage_briefing() results (one per distinct
 * reference), each { reference, genre, traditionalAuthor, approximateDate,
 * structureNote, setting, disclosure } — unlike every other field here,
 * this one is Claude's own background knowledge, not fetched or verified
 * against any dataset (see PASSAGE_BRIEFING_TOOL's own comment); the
 * `disclosure` string is there so the frontend can render that honestly.
 * wordStudies is the list of find_occurrences() results (one per distinct
 * Strong's number looked up), each { strongsNumber, occurrences,
 * totalCount, byBook, senseGroups } — byBook is a real per-book frequency
 * tally (see lib/interlinear.js's tallyOccurrencesByBook); senseGroups is
 * only populated if a later label_word_senses call for the same number
 * passed validation (see runLabelWordSensesTool's own comment for what
 * that checks) — empty otherwise, never a guess at senses nobody asked
 * Claude to group. quoteVerification is verifyReplyQuotes()'s result (see
 * lib/verify.js): every span of `reply` presented as a direct Scripture
 * quotation, checked against the real translation text in `gathered` —
 * Receipts Mode's backstop against a plausible-sounding but wrong
 * quotation. All six drive frontend visuals from the same data Claude
 * actually saw, not a separately-fetched copy. (search_lexicon/
 * search_study_history results are text-only and only ever seen by
 * Claude, not surfaced separately to the frontend — Claude is
 * expected to fold anything relevant into its reply.)
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
 *
 * depthLevel (Everyday/Student/Scholar — see lib/supabase.js's
 * DEPTH_LEVELS) is an explicit per-message override from the caller
 * (server.js validates it against DEPTH_LEVELS before passing it through,
 * same "validate at the edge" split as everything else here). When
 * omitted, a signed-in user's own stored default (profiles.depth_level,
 * read in the same getPaidProfile call already made for isPaid/agentName)
 * is used instead; an anonymous request with no override falls back to
 * DEFAULT_DEPTH_LEVEL ("everyday" — today's one existing voice, unchanged
 * for anyone who's never touched the slider).
 */
export async function chatTurn({
  sessionId,
  conversationId = null,
  message,
  appKey,
  apiKey,
  userId = null,
  depthLevel = null,
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
  // logging elsewhere in this function — { isPaid: false, agentName: null }
  // instantly (no network call) for an anonymous request. Fetched fresh on
  // every turn rather than cached, so a just-flipped is_paid takes effect on
  // this user's very next message, not after some stale value expires.
  const { isPaid, agentName: rawAgentName, depthLevel: storedDepthLevel, homeTradition } = hasUser
    ? await getPaidProfile(userId)
    : { isPaid: false, agentName: null, depthLevel: DEFAULT_DEPTH_LEVEL, homeTradition: null };
  // Only meaningful when actually paid — see getPaidProfile's own comment:
  // a downgraded account's old agent_name value stays in the column but
  // should stop being used the moment is_paid flips back to false.
  const agentName = isPaid && typeof rawAgentName === "string" ? rawAgentName.trim() || null : null;
  // An explicit per-message override (already validated by server.js)
  // always wins; otherwise fall back to this account's own saved default,
  // which getPaidProfile has already normalized to a valid value.
  const effectiveDepthLevel = isValidDepthLevel(depthLevel) ? depthLevel : storedDepthLevel;
  // Tradition Lens has no per-message override (see docs/DECISIONS.md's
  // 2026-09-23 entry) -- it's an account-level identity setting, not
  // something toggled per message the way depth is, so this is always
  // just whatever getPaidProfile reported (null for anonymous chat).
  const system = buildSystemPrompt(hasUser, isPaid, agentName, effectiveDepthLevel, homeTradition);
  const tools = buildTools(hasUser, isPaid);

  let finalReply = null;
  const gatheredThisTurn = [];
  const seenRefs = new Set();
  // Cross-References (find_cross_references + optional
  // label_cross_reference_types) — a Map, not an array, same "later call
  // updates an existing entry in place, and doubles as read-only
  // validation state" reasoning as wordStudiesThisTurn below.
  const crossReferenceDiagramsByFocus = new Map();
  const mapsThisTurn = [];
  const briefingsThisTurn = [];
  const seenBriefingRefs = new Set();
  // Word-Study Web (find_occurrences + optional label_word_senses) — a
  // Map, not an array, since label_word_senses updates an existing entry
  // in place rather than adding a new one; also doubles as the read-only
  // state runLabelWordSensesTool validates a later call's references
  // against (see that function's own comment).
  const wordStudiesThisTurn = new Map();

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
        const { text, gathered, diagram, map, briefing, wordStudy, labeledSenses, labeledCrossReferenceTypes } = await runTool(
          toolUse,
          { appKey, userId, isPaid, wordStudiesThisTurn, crossReferenceDiagramsByFocus },
        );
        if (gathered && !seenRefs.has(gathered.reference.usfm)) {
          seenRefs.add(gathered.reference.usfm);
          gatheredThisTurn.push(gathered);
        }
        if (diagram && !crossReferenceDiagramsByFocus.has(diagram.reference)) {
          crossReferenceDiagramsByFocus.set(diagram.reference, diagram);
        }
        if (map) mapsThisTurn.push(map);
        if (briefing && !seenBriefingRefs.has(briefing.reference)) {
          seenBriefingRefs.add(briefing.reference);
          briefingsThisTurn.push(briefing);
        }
        if (wordStudy) wordStudiesThisTurn.set(wordStudy.strongsNumber, wordStudy);
        if (labeledSenses) {
          const existing = wordStudiesThisTurn.get(labeledSenses.strongsNumber);
          if (existing) existing.senseGroups = labeledSenses.senseGroups;
        }
        if (labeledCrossReferenceTypes) {
          const existing = crossReferenceDiagramsByFocus.get(labeledCrossReferenceTypes.reference);
          if (existing) {
            const typeByReference = new Map(labeledCrossReferenceTypes.typedLinks.map((l) => [l.reference, l.type]));
            existing.results = existing.results.map((r) => (typeByReference.has(r.reference) ? { ...r, type: typeByReference.get(r.reference) } : r));
          }
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

  // Receipts Mode (see lib/verify.js, docs/DECISIONS.md): check any text
  // Claude's own reply presents as a direct Scripture quotation against
  // the real, verbatim translation text actually gathered this turn.
  // Never blocks or rewrites the reply — see lib/verify.js's header
  // comment for why a fuzzy string match can flag a mismatch but can't
  // safely auto-correct one (it doesn't know which real verse, if any,
  // the model meant to quote). The frontend surfaces this as a visible
  // "verified" / "quote doesn't match the source" indicator instead.
  const quoteVerification = verifyReplyQuotes(finalReply, gatheredThisTurn);

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
        {
          role: "assistant",
          text: finalReply,
          gathered: gatheredThisTurn.length > 0 ? gatheredThisTurn : null,
          crossReferences: crossReferenceDiagramsByFocus.size > 0 ? [...crossReferenceDiagramsByFocus.values()] : null,
          maps: mapsThisTurn.length > 0 ? mapsThisTurn : null,
          briefings: briefingsThisTurn.length > 0 ? briefingsThisTurn : null,
          wordStudies: wordStudiesThisTurn.size > 0 ? [...wordStudiesThisTurn.values()] : null,
          quoteVerification: quoteVerification.quotes.length > 0 ? quoteVerification : null,
        },
      ],
    }).catch((error) => {
      console.error(`Failed to persist conversation ${resolvedConversationId}:`, error.message);
    });
  }

  return {
    sessionId: id,
    conversationId: hasUser ? resolvedConversationId : null,
    reply: finalReply,
    gathered: gatheredThisTurn,
    crossReferences: [...crossReferenceDiagramsByFocus.values()],
    quoteVerification,
    maps: mapsThisTurn,
    briefings: briefingsThisTurn,
    wordStudies: [...wordStudiesThisTurn.values()],
    depthLevel: effectiveDepthLevel,
  };
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
