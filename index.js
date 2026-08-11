// Phase 1 + Phase 2 of ad-fontes: gathers a passage in several English
// translations, the tagged Greek/Hebrew with Strong's numbers and glosses,
// and a handful of public-domain commentaries (lib/gather.js) — then prints
// all of it, plus an AI-generated summary of it (lib/summarize.js).
//
//   Usage: npm start                    -> John 3:16
//          node index.js ROM.8.28
//          node index.js GEN.1.1
//          node index.js JHN.3.16 --variants
//          node index.js JHN.3.16 --no-commentary
//          node index.js JHN.3.16 --no-summary

import { gatherPassage } from "./lib/gather.js";
import { summarizePassage } from "./lib/summarize.js";

const DEFAULT_REFERENCE = "JHN.3.16";

// Load the .env sitting next to this script, so it works from any directory.
// Real environment variables still win, and a missing .env is fine as long as
// the key is exported some other way.
try {
  process.loadEnvFile(new URL(".env", import.meta.url));
} catch {
  // no .env file — fall through to whatever is already in the environment
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

function formatInterlinear(words) {
  const surfaceWidth = Math.max(...words.map((w) => displayWidth(w.surface)));
  const translitWidth = Math.max(
    ...words.map((w) => displayWidth(w.transliteration)),
  );

  return words.map((word) => {
    const gloss = word.gloss || word.contextGloss || "—";
    const marker = word.isCriticalText === false ? "±" : " ";

    return [
      `  ${marker} ${pad(word.surface, surfaceWidth)}`,
      pad(word.transliteration, translitWidth),
      pad(word.strongs, 8),
      gloss,
    ].join("  ");
  });
}

function printTranslations(results) {
  for (const { translation, content, error } of results) {
    console.log(`\n${translation.abbr} — ${translation.name}`);
    if (error) {
      console.log(`  (unavailable: ${error})`);
      continue;
    }
    console.log(content);
  }
}

function printOriginalLanguage(originalLanguage) {
  const { type, book, missingFiles, words, variantCount, error, source, hebrewVerseRef } =
    originalLanguage;

  if (type === "unsupported") {
    console.log(`\n(No original-language text mapped for ${book}.)`);
    return;
  }

  if (missingFiles.length > 0) {
    const label = type === "greek" ? "Greek" : "Hebrew";
    console.log(
      `\n(${label} data not downloaded yet — missing ${missingFiles.join(", ")}.` +
        ` Run: npm run fetch-data)`,
    );
    return;
  }

  if (error) {
    console.log(`\n(${error})`);
    return;
  }

  const label =
    type === "greek" ? "Greek — NA28 critical text" : "Hebrew — Leningrad Codex, Qere-corrected";
  console.log(`\n${label} (${words.length} words)\n`);
  console.log(formatInterlinear(words).join("\n"));

  if (hebrewVerseRef) {
    console.log(
      `\nNote: Hebrew versification differs here — this is Hebrew ${book}.${hebrewVerseRef}.` +
        ` (Most often this is a psalm superscription counted as part of the` +
        ` verse numbering in Hebrew but not in English, offsetting the rest` +
        ` of the psalm by one.)`,
    );
  }

  if (type === "greek" && variantCount > 0) {
    console.log(
      `\n${variantCount} variant word${variantCount === 1 ? "" : "s"} in the` +
        ` TR/Byzantine tradition hidden. Show with --variants (marked ±).`,
    );
  }

  console.log(`\n${source}`);
}

function printCommentaries(commentary) {
  if (commentary.error) {
    console.log(`\n(${commentary.error})`);
    return;
  }

  for (const entry of commentary.entries) {
    console.log(`\n${entry.name}`);
    console.log(wrapText(entry.body, 78, "  "));
    if (entry.truncated) console.log("  [...truncated]");
  }

  console.log(`\nCommentary text: public domain, via ${commentary.url}`);
}

async function printSummary(gathered) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log(
      "\n(Set ANTHROPIC_API_KEY in .env to get an AI-generated summary of everything above.)",
    );
    return;
  }

  try {
    const summary = await summarizePassage(gathered, { apiKey });
    console.log(`\n${summary.shortSummary}`);
    if (summary.studyNotes) {
      console.log(`\nStudy notes\n`);
      console.log(summary.studyNotes);
    }
  } catch (error) {
    console.log(`\n(Could not generate summary: ${error.message})`);
  }
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
  const skipSummary = args.includes("--no-summary");
  const usfm = args.find((arg) => !arg.startsWith("--")) ?? DEFAULT_REFERENCE;

  const gathered = await gatherPassage(usfm, {
    appKey,
    includeVariants,
    includeCommentary: !skipCommentary,
  });

  const bar = "=".repeat(60);
  console.log(`${bar}\n${gathered.reference.usfm}\n${bar}`);
  printTranslations(gathered.translations);

  console.log(`\n${"-".repeat(60)}\nOriginal language\n${"-".repeat(60)}`);
  printOriginalLanguage(gathered.originalLanguage);

  if (!skipCommentary) {
    console.log(`\n${"-".repeat(60)}\nCommentary\n${"-".repeat(60)}`);
    printCommentaries(gathered.commentary);
  }

  if (!skipSummary) {
    console.log(`\n${"-".repeat(60)}\nSummary\n${"-".repeat(60)}`);
    await printSummary(gathered);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
