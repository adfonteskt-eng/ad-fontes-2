// Phase 2: turns the structured data from lib/gather.js into something a
// person can actually read quickly — a short plain-language takeaway plus
// deeper study notes — by handing the gathered material to Claude.

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1200;

const TAKEAWAY_MARKER = "## TAKEAWAY";
const STUDY_NOTES_MARKER = "## STUDY NOTES";

const SYSTEM_PROMPT = `You are helping someone study a Bible passage using primary-source material that has already been gathered for you: multiple English translations, a word-by-word breakdown of the original Greek or Hebrew with Strong's numbers, and excerpts from several public-domain commentaries (Matthew Henry, Jamieson-Fausset-Brown, Barnes, Gill, Geneva Study Bible).

Write two sections, using these exact markers on their own line, nothing before the first marker:

${TAKEAWAY_MARKER}
4-6 sentences in plain language: what the passage says and why it matters. No jargon, no citations, accessible to someone with no background in biblical studies.

${STUDY_NOTES_MARKER}
250-400 words covering, where the material actually supports it:
- Any meaningful differences between the translations (word choice that changes meaning, not just style)
- 1-3 original-language words whose nuance doesn't fully come through in English
- Where the commentaries agree, and where they genuinely differ in interpretation — present disagreement as disagreement rather than picking a side

Only include a point if the gathered material actually supports it. Don't invent citations, don't attribute a claim to a commentary that didn't make it, and don't pad — if the material for a section is thin (e.g. no commentary was found, or translations don't meaningfully differ), say so briefly and move on.`;

function formatTranslations(translations) {
  const available = translations.filter((t) => !t.error);
  if (available.length === 0) return null;
  return available.map((t) => `[${t.translation.abbr}] ${t.content}`).join("\n");
}

function formatOriginalLanguage(originalLanguage) {
  if (!originalLanguage.words || originalLanguage.words.length === 0) return null;
  const label = originalLanguage.type === "greek" ? "Greek" : "Hebrew";
  const rows = originalLanguage.words.map(
    (w) => `  ${w.surface} / ${w.transliteration} / ${w.strongs} / ${w.gloss ?? "—"}`,
  );
  const versificationNote = originalLanguage.hebrewVerseRef
    ? `\n(Note: Hebrew versification differs here — this word list is Hebrew ${originalLanguage.book}.${originalLanguage.hebrewVerseRef}, not the English verse number above. Don't treat this as a translation discrepancy.)`
    : "";
  return `${label} word-by-word (surface / transliteration / Strong's / gloss):\n${rows.join("\n")}${versificationNote}`;
}

function formatCommentary(commentary) {
  const entries = commentary.entries ?? [];
  if (entries.length === 0) return null;
  return entries.map((c) => `[${c.name}] ${c.body}`).join("\n\n");
}

function buildPrompt(gathered) {
  const sections = [
    `Bible reference: ${gathered.reference.usfm}`,
    formatTranslations(gathered.translations),
    formatOriginalLanguage(gathered.originalLanguage),
    formatCommentary(gathered.commentary),
  ].filter(Boolean);

  return sections.join("\n\n");
}

function splitSections(text) {
  const takeawayIndex = text.indexOf(TAKEAWAY_MARKER);
  const notesIndex = text.indexOf(STUDY_NOTES_MARKER);

  if (takeawayIndex === -1 || notesIndex === -1) {
    // Markers missing (model didn't follow the format) — surface the whole
    // response as the takeaway rather than silently dropping it.
    return { shortSummary: text.trim(), studyNotes: null };
  }

  const shortSummary = text
    .slice(takeawayIndex + TAKEAWAY_MARKER.length, notesIndex)
    .trim();
  const studyNotes = text.slice(notesIndex + STUDY_NOTES_MARKER.length).trim();
  return { shortSummary, studyNotes };
}

/**
 * Calls the Anthropic API with everything lib/gather.js collected and
 * returns { shortSummary, studyNotes }. Throws if the request fails or
 * apiKey is missing — callers should treat this as an optional, skippable
 * step (Phase 1's output is already useful on its own).
 */
export async function summarizePassage(
  gathered,
  { apiKey, model = process.env.SUMMARY_MODEL ?? DEFAULT_MODEL } = {},
) {
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env to enable summaries.",
    );
  }

  const prompt = buildPrompt(gathered);

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
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Anthropic API returned ${response.status} ${response.statusText}\n${body}`,
    );
  }

  const data = await response.json();
  const text = (data.content ?? []).map((block) => block.text ?? "").join("");

  if (!text.trim()) {
    throw new Error("Anthropic API returned an empty response.");
  }

  return splitSections(text);
}
