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
//
// Cross-references: openbible.info's cross-reference dataset — CC BY 4.0,
// drawn primarily from the public-domain Treasury of Scripture Knowledge
// plus other sources, ~345,000 verse-pair connections each with a "votes"
// relevance score. Backs lib/cross-references.js's find_cross_references
// chat tool (real, curated connections between passages — not something
// Claude invents on its own). Distributed as a small .zip; see
// downloadCrossReferences() below for why this hand-rolls the extraction
// instead of adding an unzip dependency.
//
// Bible geocoding: openbible.info's separate Bible-Geocoding-Data project —
// CC BY 4.0, real coordinates for every place mentioned in the Bible, each
// with a scholarly-source-backed confidence score per candidate modern
// identification (some places have one dominant, well-attested site; others
// have several disputed candidates — the data says which, rather than this
// app guessing). Backs lib/geography.js's generate_map chat tool. Only
// `data/modern.jsonl` is fetched — the project's ancient-place metadata
// (verse references, spelling variants) isn't needed here, since the modern
// side already carries each candidate's ancient place name inline.

import { mkdir, stat } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

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

// Cross-references dataset (see header comment) is distributed as a small
// single-entry .zip, not a plain text file like BSB above — a single
// dependency (a real zip library) felt like overkill for extracting one
// known file, so this reads the ZIP local-file-header format directly: for
// an archive with no data-descriptor bit set (true here), the compressed/
// uncompressed sizes and filename length sit right in that 30-byte header,
// so the compressed bytes can be sliced out and passed straight to
// node:zlib's inflateRawSync (ZIP's DEFLATE entries are raw, unwrapped
// deflate streams — exactly what inflateRawSync expects, as opposed to
// inflateSync which wants a zlib header). Verified against the real
// downloaded file: local file header reports compression method 8
// (deflate), general-purpose flag 0 (sizes are trustworthy up front).
// This is intentionally narrow — it only handles the single-entry, no-
// data-descriptor case this one file actually uses, not arbitrary zips.
const ZIP_LOCAL_HEADER_SIGNATURE = 0x04034b50;

function extractSingleZipEntry(zipBuffer) {
  if (zipBuffer.readUInt32LE(0) !== ZIP_LOCAL_HEADER_SIGNATURE) {
    throw new Error("Not a zip file (unexpected local file header signature).");
  }
  const compressionMethod = zipBuffer.readUInt16LE(8);
  const compressedSize = zipBuffer.readUInt32LE(18);
  const nameLength = zipBuffer.readUInt16LE(26);
  const extraLength = zipBuffer.readUInt16LE(28);
  const dataStart = 30 + nameLength + extraLength;
  const compressed = zipBuffer.subarray(dataStart, dataStart + compressedSize);

  if (compressionMethod === 0) return Buffer.from(compressed); // stored, no compression
  if (compressionMethod === 8) return inflateRawSync(compressed);
  throw new Error(`Unsupported zip compression method ${compressionMethod} (expected 0=stored or 8=deflate).`);
}

const CROSS_REFS_URL = "https://a.openbible.info/data/cross-references.zip";
const CROSS_REFS_FILE = "cross-references.txt";

async function downloadCrossReferences() {
  const target = dataFile(CROSS_REFS_FILE);

  if (await exists(target)) {
    console.log(`  ${CROSS_REFS_FILE} — already present, skipping`);
    return;
  }

  const response = await fetch(CROSS_REFS_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to download cross-references: ${response.status} ${response.statusText}\n  ${CROSS_REFS_URL}`,
    );
  }

  const zipBuffer = Buffer.from(await response.arrayBuffer());
  const body = extractSingleZipEntry(zipBuffer);
  await writeFile(target, body);

  const mb = (body.byteLength / 1024 / 1024).toFixed(1);
  console.log(`  ${CROSS_REFS_FILE} — ${mb} MB (openbible.info cross-references, CC BY 4.0)`);
}

const GEOCODING_URL = "https://raw.githubusercontent.com/openbibleinfo/Bible-Geocoding-Data/main/data/modern.jsonl";
const GEOCODING_FILE = "bible-geocoding-modern.jsonl";

async function downloadBibleGeocoding() {
  const target = dataFile(GEOCODING_FILE);

  if (await exists(target)) {
    console.log(`  ${GEOCODING_FILE} — already present, skipping`);
    return;
  }

  const response = await fetch(GEOCODING_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to download Bible geocoding data: ${response.status} ${response.statusText}\n  ${GEOCODING_URL}`,
    );
  }

  const body = Buffer.from(await response.arrayBuffer());
  await writeFile(target, body);

  const mb = (body.byteLength / 1024 / 1024).toFixed(1);
  console.log(`  ${GEOCODING_FILE} — ${mb} MB (openbible.info Bible geocoding data, CC BY 4.0)`);
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  console.log("Fetching STEPBible data (CC BY 4.0, Tyndale House Cambridge):");

  for (const file of FILES) {
    await download(file);
  }

  console.log("Fetching Berean Standard Bible full text (public domain / CC0):");
  await downloadBsb();

  console.log("Fetching cross-references dataset (CC BY 4.0, openbible.info):");
  await downloadCrossReferences();

  console.log("Fetching Bible geocoding dataset (CC BY 4.0, openbible.info):");
  await downloadBibleGeocoding();

  console.log("Done. Sources: https://github.com/STEPBible/STEPBible-Data, https://berean.bible, https://www.openbible.info/labs/cross-references/, https://github.com/openbibleinfo/Bible-Geocoding-Data");
}

// Only run when invoked directly, so index.js can import FILES/dataFile.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
