// Plain-English parsing for Alphabet Mode (see docs/DECISIONS.md) — turns a
// Robinson-style morphology code (e.g. "V-AAI-3S", already parsed out of
// each Greek word by lib/interlinear.js's readGreekVerseWords()) into a
// real grammatical explanation and example sentence.
//
// Deliberately NOT a hand-rolled decoder: STEPBible themselves publish the
// exact legend used to generate the tagged text's codes in the first
// place (TEGMC — "Translators Expansion of Greek Morphology Codes"), CC BY
// 4.0, same project and license as the interlinear data itself. Using
// their own explanations means "what does V-AAI-3S mean" is answered from
// a real, licensed source, not this app's own guess at Greek grammar —
// exactly the same "don't invent it, cite it" discipline as every other
// lib/ module here. Fetched into data/TEGMC.txt by
// scripts/fetch-data.js.

import { access, readFile } from "node:fs/promises";

import { dataFile } from "../scripts/fetch-data.js";

export const MORPHOLOGY_CODES_FILE = "TEGMC.txt";

// A real entry's code+fields line never starts with a tab; every
// continuation line (short label, description, example) always does. The
// file's own trailing proofing notes (e.g. "HEB\tKJV") happen to match the
// code pattern on their own line but are never followed by a tab-indented
// continuation line, which is what actually excludes them here — see this
// module's own test fixtures for a worked example of exactly that shape.
const CODE_LINE_PATTERN = /^([A-Z][A-Z0-9-]*)\t(.+)$/;

/**
 * Parses TEGMC.txt's "FULL MORPHOLOGY CODES" table (see the file's own
 * header for the format: one code + structured-fields line, then three
 * tab-indented continuation lines — short label, description, example —
 * per entry) into a flat list of
 * { code, fields, shortLabel, description, example }. Exported standalone
 * so it's testable against a small fixture string, not the real ~8,000-
 * line file.
 */
export function parseMorphologyCodesText(raw) {
  const lines = raw.split("\n");
  const entries = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(CODE_LINE_PATTERN);
    if (!match) continue;

    const nextLine = lines[i + 1];
    if (!nextLine || !nextLine.startsWith("\t")) continue; // not a real entry -- see header comment

    const [, code, fields] = match;
    const shortLabel = nextLine.slice(1).trim();
    const description = (lines[i + 2] ?? "").replace(/^\t/, "").trim();
    const example = (lines[i + 3] ?? "")
      .replace(/^\t/, "")
      .trim()
      .replace(/^"(.*)"$/, "$1");

    entries.push({ code, fields: fields.trim(), shortLabel, description, example });
    i += 3; // consumed lines i+1..i+3; the loop's own i++ lands on whatever follows (a "$" delimiter or the next code)
  }

  return entries;
}

/** Builds Map<code, entry> from parsed entries — the actual lookup structure. */
export function buildMorphologyIndex(entries) {
  return new Map(entries.map((e) => [e.code, e]));
}

let cachedIndex = null;

/** True once data/TEGMC.txt has actually been downloaded. */
export async function isMorphologyDataAvailable() {
  try {
    await access(dataFile(MORPHOLOGY_CODES_FILE));
    return true;
  } catch {
    return false;
  }
}

async function loadIndex() {
  if (cachedIndex) return cachedIndex;
  const raw = await readFile(dataFile(MORPHOLOGY_CODES_FILE), "utf8");
  cachedIndex = buildMorphologyIndex(parseMorphologyCodesText(raw));
  return cachedIndex;
}

/**
 * Batch-friendly variant for callers (lib/gather.js's gatherGreek(), which
 * looks up one code per word in a verse) that already have their own
 * "data file not downloaded" handling and want one preload plus cheap
 * synchronous `.get(code)` calls rather than an explainMorphologyCode()
 * round trip — and a thrown error — per word. Returns null, not a throw,
 * when the data isn't there; morphology parsing is an enhancement on top
 * of the interlinear text, not something that should block gathering it.
 */
export async function getMorphologyIndex() {
  if (!(await isMorphologyDataAvailable())) return null;
  return loadIndex();
}

/**
 * Looks up a morphology code's real, plain-English explanation. Returns
 * null (not an error, not a guess) for a code the legend doesn't cover —
 * a handful of rare/compound tags in the tagged text don't have their own
 * TEGMC entry, and this is exactly the case where saying nothing is more
 * honest than a hand-rolled fallback description this app can't verify.
 * Throws a clear, catchable error (code "MORPHOLOGY_DATA_NOT_DOWNLOADED")
 * if the data file itself hasn't been fetched, same pattern as
 * lib/cross-references.js and lib/geography.js.
 *
 * One known real-world null: TEGMC.txt's own entry for "V-PMO-3P" is
 * malformed in the source file (a leftover multi-column debug row instead
 * of the usual four-line block), so that one legitimate code parses to no
 * entry. Confirmed against the real file rather than assumed — see
 * test/greek-morphology.test.mjs for the parser's exclusion logic this
 * relies on. Left as an honest null rather than hand-patched, consistent
 * with this module's whole point.
 */
export async function explainMorphologyCode(code) {
  if (!code) return null;
  if (!(await isMorphologyDataAvailable())) {
    const error = new Error("Greek morphology code data not downloaded on the server yet — run `npm run fetch-data`.");
    error.code = "MORPHOLOGY_DATA_NOT_DOWNLOADED";
    throw error;
  }
  const index = await loadIndex();
  return index.get(code) ?? null;
}

/** Drops the cached index — for tests only. */
export function clearMorphologyCache() {
  cachedIndex = null;
}
