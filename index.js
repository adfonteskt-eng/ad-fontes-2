// Fetches a passage from the YouVersion Platform API, prints the English text,
// then prints the tagged Greek beneath it with Strong's numbers and glosses.
//
//   Usage: npm start                    -> John 3:16
//          node index.js ROM.8.28
//          node index.js JHN.3.16 --variants

import { access } from "node:fs/promises";

import {
  isNewTestament,
  loadLexicon,
  parseReference,
  readVerseWords,
} from "./lib/interlinear.js";
import { dataFile, FILES } from "./scripts/fetch-data.js";

const API_BASE = "https://api.youversion.com/v1";
const DEFAULT_REFERENCE = "JHN.3.16";

// Load the .env sitting next to this script, so it works from any directory.
// Real environment variables still win, and a missing .env is fine as long as
// the key is exported some other way.
try {
  process.loadEnvFile(new URL(".env", import.meta.url));
} catch {
  // no .env file — fall through to whatever is already in the environment
}

async function fetchPassage(reference, { appKey, bibleId }) {
  const url = `${API_BASE}/bibles/${bibleId}/passages/${reference}`;
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

async function missingDataFiles() {
  const missing = [];
  for (const { name } of FILES) {
    try {
      await access(dataFile(name));
    } catch {
      missing.push(name);
    }
  }
  return missing;
}

// Greek combining marks would throw the column widths off, so compose first.
function displayWidth(text) {
  return text.normalize("NFC").length;
}

function pad(text, width) {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

function formatInterlinear(words, lexicon) {
  const greekWidth = Math.max(...words.map((w) => displayWidth(w.surface)));
  const translitWidth = Math.max(
    ...words.map((w) => displayWidth(w.transliteration)),
  );

  return words.map((word) => {
    const entry = lexicon.get(word.strongs);
    const gloss = entry?.gloss || word.contextGloss || "—";
    const marker = word.isCriticalText ? " " : "±";

    return [
      `  ${marker} ${pad(word.surface, greekWidth)}`,
      pad(word.transliteration, translitWidth),
      pad(word.strongs, 6),
      gloss,
    ].join("  ");
  });
}

async function printGreek(reference, { includeVariants }) {
  if (!isNewTestament(reference.book)) {
    console.log(
      `\n(No Greek available for ${reference.book} — the tagged Greek text covers` +
        ` the New Testament only. Hebrew OT lookups are not wired up yet.)`,
    );
    return;
  }

  const missing = await missingDataFiles();
  if (missing.length > 0) {
    console.log(
      `\n(Greek data not downloaded yet — missing ${missing.join(", ")}.` +
        ` Run: npm run fetch-data)`,
    );
    return;
  }

  const allWords = await readVerseWords(reference);
  if (allWords.length === 0) {
    console.log(`\n(No tagged Greek found for ${reference.key}.)`);
    return;
  }

  const words = includeVariants
    ? allWords
    : allWords.filter((word) => word.isCriticalText);

  const lexicon = await loadLexicon(words.map((word) => word.strongs));
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

async function main() {
  const appKey = process.env.YVP_APP_KEY;
  if (!appKey) {
    throw new Error(
      "YVP_APP_KEY is not set. Copy .env.example to .env and add your app key.",
    );
  }

  const args = process.argv.slice(2);
  const includeVariants = args.includes("--variants");
  const usfm = args.find((arg) => !arg.startsWith("--")) ?? DEFAULT_REFERENCE;

  const bibleId = process.env.BIBLE_ID ?? "3034";
  const reference = parseReference(usfm);

  const passage = await fetchPassage(reference.usfm, { appKey, bibleId });
  console.log(`${passage.reference}\n\n${passage.content}`);

  await printGreek(reference, { includeVariants });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
