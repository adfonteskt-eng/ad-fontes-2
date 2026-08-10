// Fetches a passage in several English translations from the YouVersion
// Platform API, prints the tagged Greek or Hebrew beneath it with Strong's
// numbers and glosses, and pulls a handful of public-domain commentaries.
//
//   Usage: npm start                    -> John 3:16
//          node index.js ROM.8.28
//          node index.js GEN.1.1
//          node index.js JHN.3.16 --variants
//          node index.js JHN.3.16 --no-commentary

import { access } from "node:fs/promises";

import { commentaryUrl, fetchCommentaries } from "./lib/commentary.js";
import {
  isNewTestament,
  isOldTestament,
  loadLexicon,
  parseReference,
  readGreekVerseWords,
  readHebrewVerseWords,
} from "./lib/interlinear.js";
import { dataFile, FILES } from "./scripts/fetch-data.js";

const API_BASE = "https://api.youversion.com/v1";
const DEFAULT_REFERENCE = "JHN.3.16";

// Translations to pull by default, in the order they're printed. Berean
// Standard Bible is listed first since it's what this project originally
// shipped with and is confirmed to work with a fresh app key; the others are
// widely available public-domain/open translations on YouVersion's platform.
// Override with BIBLE_IDS="id1,id2,..." in .env if your app key has access
// to a different set (or just one).
const DEFAULT_TRANSLATIONS = [
  { id: "3034", abbr: "BSB", name: "Berean Standard Bible" },
  { id: "1", abbr: "KJV", name: "King James Version" },
  { id: "206", abbr: "WEB", name: "World English Bible" },
  { id: "12", abbr: "ASV", name: "American Standard Version" },
];

// Load the .env sitting next to this script, so it works from any directory.
// Real environment variables still win, and a missing .env is fine as long as
// the key is exported some other way.
try {
  process.loadEnvFile(new URL(".env", import.meta.url));
} catch {
  // no .env file — fall through to whatever is already in the environment
}

function resolveTranslations() {
  const raw = process.env.BIBLE_IDS ?? process.env.BIBLE_ID;
  if (!raw) return DEFAULT_TRANSLATIONS;

  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => {
      const known = DEFAULT_TRANSLATIONS.find((t) => t.id === id);
      return known ?? { id, abbr: id, name: `Bible ID ${id}` };
    });
}

async function fetchPassage(usfm, { appKey, bibleId }) {
  const url = `${API_BASE}/bibles/${bibleId}/passages/${usfm}`;
  const response = await fetch(url, {
    headers: {
      "X-YVP-App-Key": appKey,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `YouVersion API returned ${response.status} ${response.statusText}\n${body}`,
    );
  }

  return response.json();
}

async function fetchTranslations(reference, appKey, translations) {
  const results = [];
  for (const translation of translations) {
    try {
      const passage = await fetchPassage(reference.usfm, {
        appKey,
        bibleId: translation.id,
      });
      results.push({ translation, passage, error: null });
    } catch (error) {
      results.push({ translation, passage: null, error });
    }
  }
  return results;
}

function printTranslations(results) {
  for (const { translation, passage, error } of results) {
    console.log(`\n${translation.abbr} — ${translation.name}`);
    if (error) {
      const reason = error.message.split("\n")[0];
      console.log(`  (unavailable: ${reason})`);
      continue;
    }
    console.log(passage.content);
  }
}

async function missingDataFiles(names) {
  const missing = [];
  for (const name of names) {
    try {
      await access(dataFile(name));
    } catch {
      missing.push(name);
    }
  }
  return missing;
}

// Greek combining marks (and Hebrew vowel points/cantillation, which are
// *always* combining marks rather than precomposed characters) would throw
// column widths off if counted, so strip them before measuring.
function displayWidth(text) {
  return text.normalize("NFC").replace(/\p{Mn}/gu, "").length;
}

function pad(text, width) {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

function formatInterlinear(words, lexicon) {
  const surfaceWidth = Math.max(...words.map((w) => displayWidth(w.surface)));
  const translitWidth = Math.max(
    ...words.map((w) => displayWidth(w.transliteration)),
  );

  return words.map((word) => {
    const entry = lexicon.get(word.strongs);
    const gloss = entry?.gloss || word.contextGloss || "—";
    const marker = word.isCriticalText === false ? "±" : " ";

    return [
      `  ${marker} ${pad(word.surface, surfaceWidth)}`,
      pad(word.transliteration, translitWidth),
      pad(word.strongs, 8),
      gloss,
    ].join("  ");
  });
}

async function printGreek(reference, { includeVariants }) {
  const files = ["TAGNT-Mat-Jhn.txt", "TAGNT-Act-Rev.txt", "TBESG.txt"];
  const missing = await missingDataFiles(files);
  if (missing.length > 0) {
    console.log(
      `\n(Greek data not downloaded yet — missing ${missing.join(", ")}.` +
        ` Run: npm run fetch-data)`,
    );
    return;
  }

  const allWords = await readGreekVerseWords(reference);
  if (allWords.length === 0) {
    console.log(`\n(No tagged Greek found for ${reference.key}.)`);
    return;
  }

  const words = includeVariants
    ? allWords
    : allWords.filter((word) => word.isCriticalText);

  const lexicon = await loadLexicon(
    words.map((word) => word.strongs),
    "TBESG.txt",
  );
  const variantCount = allWords.length - words.length;

  console.log(`\nGreek — NA28 critical text (${words.length} words)\n`);
  console.log(formatInterlinear(words, lexicon).join("\n"));

  if (variantCount > 0) {
    console.log(
      `\n${variantCount} variant word${variantCount === 1 ? "" : "s"} in the` +
        ` TR/Byzantine tradition hidden. Show with --variants (marked ±).`,
    );
  }

  console.log(
    "\nGreek text & lexicon: STEPBible / Tyndale House Cambridge (CC BY 4.0)",
  );
}

async function printHebrew(reference) {
  const files = [
    "TAHOT-Gen-Deu.txt",
    "TAHOT-Jos-Est.txt",
    "TAHOT-Job-Sng.txt",
    "TAHOT-Isa-Mal.txt",
    "TBESH.txt",
  ];
  const missing = await missingDataFiles(files);
  if (missing.length > 0) {
    console.log(
      `\n(Hebrew data not downloaded yet — missing ${missing.join(", ")}.` +
        ` Run: npm run fetch-data)`,
    );
    return;
  }

  const words = await readHebrewVerseWords(reference);
  if (words.length === 0) {
    console.log(`\n(No tagged Hebrew found for ${reference.key}.)`);
    return;
  }

  const lexicon = await loadLexicon(
    words.map((word) => word.strongs),
    "TBESH.txt",
  );

  console.log(`\nHebrew — Leningrad Codex, Qere-corrected (${words.length} words)\n`);
  console.log(formatInterlinear(words, lexicon).join("\n"));
  console.log(
    "\nHebrew text & lexicon: STEPBible / Tyndale House Cambridge (CC BY 4.0)",
  );
}

async function printOriginalLanguage(reference, { includeVariants }) {
  if (isNewTestament(reference.book)) {
    await printGreek(reference, { includeVariants });
  } else if (isOldTestament(reference.book)) {
    await printHebrew(reference);
  } else {
    console.log(`\n(No original-language text mapped for ${reference.book}.)`);
  }
}

function wrapText(text, width, indent) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line && displayWidth(line) + 1 + displayWidth(word) > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => indent + l).join("\n");
}

async function printCommentaries(reference) {
  const url = commentaryUrl(reference);
  if (!url) {
    console.log(`\n(No commentary source mapped for ${reference.book}.)`);
    return;
  }

  let result;
  try {
    result = await fetchCommentaries(reference);
  } catch (error) {
    console.log(`\n(Could not fetch commentary: ${error.message})`);
    return;
  }

  if (result.entries.length === 0) {
    console.log(
      `\n(No commentary text found for ${reference.key} at ${url}.` +
        ` The page format may have changed, or this verse just isn't covered.)`,
    );
    return;
  }

  for (const entry of result.entries) {
    console.log(`\n${entry.name}`);
    console.log(wrapText(entry.body, 78, "  "));
    if (entry.truncated) console.log("  [...truncated]");
  }

  console.log(`\nCommentary text: public domain, via ${url}`);
}

async function main() {
  const appKey = process.env.YVP_APP_KEY;
  if (!appKey) {
    throw new Error(
      "YVP_APP_KEY is not set. Copy .env.example to .env and add your app key.",
    );
  }

  const args = process.argv.slice(2);
  const includeVariants = args.includes("--variants");
  const skipCommentary = args.includes("--no-commentary");
  const usfm = args.find((arg) => !arg.startsWith("--")) ?? DEFAULT_REFERENCE;

  const reference = parseReference(usfm);
  const translations = resolveTranslations();

  const bar = "=".repeat(60);
  console.log(`${bar}\n${reference.usfm}\n${bar}`);

  const results = await fetchTranslations(reference, appKey, translations);
  printTranslations(results);

  console.log(`\n${"-".repeat(60)}\nOriginal language\n${"-".repeat(60)}`);
  await printOriginalLanguage(reference, { includeVariants });

  if (!skipCommentary) {
    console.log(`\n${"-".repeat(60)}\nCommentary\n${"-".repeat(60)}`);
    await printCommentaries(reference);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
