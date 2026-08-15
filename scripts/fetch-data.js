// Downloads the STEPBible data files this project needs, plus the Berean
// Standard Bible's full text for full-text search.
//
// STEPBible data: github.com/STEPBible/STEPBible-Data — created by
// STEPBible.org based on work at Tyndale House Cambridge, CC BY 4.0. The
// licence asks that the data be distributed from a single source rather
// than redistributed, so we fetch it here at setup time instead of
// committing it. `data/` is gitignored.
//
// BSB full text: bereanbible.com/bsb.txt — dedicated to the public domain
// (CC0) by the Berean Bible Translation Committee. Fetched from its own
// distributor, deliberately not sourced from the YouVersion Platform API
// even though BSB is also one of the translations lib/gather.js fetches
// live from YouVersion for on-screen display — see lib/bible-search.js's
// header comment for the full licensing reasoning (short version: a bulk
// local search index built from cached YouVersion API output risks
// reading as "replicating" YouVersion's own Bible App under their Platform
// Terms of Use; an independently-sourced public-domain copy doesn't).

import { mkdir, stat } from "node:fs/promises";
import { writeFile } from "node:fs/promises";

const RAW_BASE =
  "https://raw.githubusercontent.com/STEPBible/STEPBible-Data/master";

// Paths verified against the repo's file listing — the names are long and the
// spacing is inconsistent between folders, so they are written out in full.
export const FILES = [
  {
    name: "TBESG.txt",
    path: "Lexicons/TBESG - Translators Brief lexicon of Extended Strongs for Greek - STEPBible.org CC BY.txt",
    description: "Greek lexicon (Extended Strong's)",
  },
  {
    name: "TAGNT-Mat-Jhn.txt",
    path: "Translators Amalgamated OT+NT/TAGNT Mat-Jhn - Translators Amalgamated Greek NT - STEPBible.org CC-BY.txt",
    description: "Tagged Greek NT, Matthew–John",
  },
  {
    name: "TAGNT-Act-Rev.txt",
    path: "Translators Amalgamated OT+NT/TAGNT Act-Rev - Translators Amalgamated Greek NT - STEPBible.org CC-BY.txt",
    description: "Tagged Greek NT, Acts–Revelation",
  },
  {
    name: "TBESH.txt",
    path: "Lexicons/TBESH - Translators Brief lexicon of Extended Strongs for Hebrew - STEPBible.org CC BY.txt",
    description: "Hebrew lexicon (Extended Strong's)",
  },
  {
    name: "TAHOT-Gen-Deu.txt",
    path: "Translators Amalgamated OT+NT/TAHOT Gen-Deu - Translators Amalgamated Hebrew OT - STEPBible.org CC BY.txt",
    description: "Tagged Hebrew OT, Genesis–Deuteronomy",
  },
  {
    name: "TAHOT-Jos-Est.txt",
    path: "Translators Amalgamated OT+NT/TAHOT Jos-Est - Translators Amalgamated Hebrew OT - STEPBible.org CC BY.txt",
    description: "Tagged Hebrew OT, Joshua–Esther",
  },
  {
    name: "TAHOT-Job-Sng.txt",
    path: "Translators Amalgamated OT+NT/TAHOT Job-Sng - Translators Amalgamated Hebrew OT - STEPBible.org CC BY.txt",
    description: "Tagged Hebrew OT, Job–Song of Songs",
  },
  {
    name: "TAHOT-Isa-Mal.txt",
    path: "Translators Amalgamated OT+NT/TAHOT Isa-Mal - Translators Amalgamated Hebrew OT - STEPBible.org CC BY.txt",
    description: "Tagged Hebrew OT, Isaiah–Malachi",
  },
];

export const DATA_DIR = new URL("../data/", import.meta.url);

export function dataFile(name) {
  return new URL(name, DATA_DIR);
}

async function exists(url) {
  try {
    await stat(url);
    return true;
  } catch {
    return false;
  }
}

async function download({ name, path, description }) {
  const target = dataFile(name);

  if (await exists(target)) {
    console.log(`  ${name} — already present, skipping`);
    return;
  }

  const url = `${RAW_BASE}/${encodeURI(path)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download ${name}: ${response.status} ${response.statusText}\n  ${url}`,
    );
  }

  const body = Buffer.from(await response.arrayBuffer());
  await writeFile(target, body);

  const mb = (body.byteLength / 1024 / 1024).toFixed(1);
  console.log(`  ${name} — ${mb} MB (${description})`);
}

// Full Bible text (~31,000 verses) used only by lib/bible-search.js's
// full-text search index — see this file's header comment and
// lib/bible-search.js's own for why this is fetched separately from, and
// deliberately not derived from, the YouVersion API translations.
const BSB_URL = "https://bereanbible.com/bsb.txt";
const BSB_FILE = "bsb.txt";

async function downloadBsb() {
  const target = dataFile(BSB_FILE);

  if (await exists(target)) {
    console.log(`  ${BSB_FILE} — already present, skipping`);
    return;
  }

  const response = await fetch(BSB_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to download ${BSB_FILE}: ${response.status} ${response.statusText}\n  ${BSB_URL}`,
    );
  }

  const body = Buffer.from(await response.arrayBuffer());
  await writeFile(target, body);

  const mb = (body.byteLength / 1024 / 1024).toFixed(1);
  console.log(`  ${BSB_FILE} — ${mb} MB (Berean Standard Bible, full text, public domain / CC0)`);
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  console.log("Fetching STEPBible data (CC BY 4.0, Tyndale House Cambridge):");

  for (const file of FILES) {
    await download(file);
  }

  console.log("Fetching Berean Standard Bible full text (public domain / CC0):");
  await downloadBsb();

  console.log("Done. Sources: https://github.com/STEPBible/STEPBible-Data, https://berean.bible");
}

// Only run when invoked directly, so index.js can import FILES/dataFile.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
