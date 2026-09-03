// Real geographic data for the generate_map chat tool (lib/chat.js) — maps
// a place name Claude gives (e.g. "Corinth", "Mount Sinai") to a real,
// sourced coordinate, and defines a handful of curated named journeys
// (Paul's missionary journeys, the Exodus, Abraham's journey from Ur).
//
// The critical design constraint: never plot a coordinate Claude invents.
// Every point on a map traces back to openbible.info's Bible-Geocoding-Data
// project (CC BY 4.0) — a real, scholarly-sourced dataset that identifies
// the likely modern location of every place mentioned in the Bible, with a
// confidence score per candidate identification. Some places have one
// dominant, well-attested site (Jerusalem, Rome, Damascus); others have
// several genuinely disputed candidates with no clear winner (Mount Sinai,
// Sodom, most of the Exodus wilderness stations) — the data says which, so
// this module derives "identified" vs "disputed" from the real score
// distribution rather than asserting false certainty either way.
//
// Source file: data/bible-geocoding-modern.jsonl, fetched by
// scripts/fetch-data.js's downloadBibleGeocoding(). Each line is one modern
// location with a representative lonlat and an `ancient_associations` map
// of {biblical name -> {modern location, score}} — see that function's
// comment. Only the "modern" side of the dataset is used; the project's
// separate ancient-place file (verse references, spelling variants) isn't
// needed for map-plotting.

import { access, readFile } from "node:fs/promises";

import { dataFile } from "../scripts/fetch-data.js";

export const GEOCODING_FILE = "bible-geocoding-modern.jsonl";

function normalizeName(name) {
  return (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parses one line of data/bible-geocoding-modern.jsonl into a list of
 * { biblicalName, modernName, lon, lat, score } rows — one per ancient
 * place this modern location is a candidate identification for (a single
 * modern site is often a candidate for more than one biblical name, and
 * vice versa). Returns [] for a blank line or one that doesn't parse as
 * expected, rather than throwing — a handful of odd rows in a ~1,600-line
 * dataset shouldn't take down the whole feature. Exported standalone for
 * testing against small fixture lines, not the real multi-megabyte file.
 */
export function parseGeocodingLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let entry;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const modernName = entry.friendly_id;
  const lonlat = entry.lonlat;
  const associations = entry.ancient_associations;
  if (!modernName || typeof lonlat !== "string" || !associations || typeof associations !== "object") return [];

  const [lonStr, latStr] = lonlat.split(",");
  const lon = Number(lonStr);
  const lat = Number(latStr);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return [];

  const rows = [];
  for (const assoc of Object.values(associations)) {
    const biblicalName = assoc?.name;
    const score = assoc?.score;
    if (!biblicalName || typeof score !== "number") continue;
    rows.push({ biblicalName, modernName, lon, lat, score });
  }
  return rows;
}

/**
 * Builds Map<normalizedBiblicalName, candidates> from parsed rows, each
 * candidates array sorted highest-score first. Multiple rows for the same
 * exact biblical name (usually the same modern site scored slightly
 * differently across data-entry passes, occasionally two real distinct
 * sites both proposed for one name) collapse to one candidate per distinct
 * modern site, keeping the higher score — see resolvePlaceName()'s own
 * comment for why exact-name grouping (not fuzzy merging) is the safe
 * default.
 */
export function buildGeographyIndex(rows) {
  const bySite = new Map(); // normalizedName -> Map<modernName, candidate>

  for (const row of rows) {
    const key = normalizeName(row.biblicalName);
    if (!bySite.has(key)) bySite.set(key, new Map());
    const sites = bySite.get(key);
    const existing = sites.get(row.modernName);
    if (!existing || row.score > existing.score) {
      sites.set(row.modernName, { modernName: row.modernName, lon: row.lon, lat: row.lat, score: row.score });
    }
  }

  const index = new Map();
  for (const [key, sites] of bySite) {
    index.set(key, [...sites.values()].sort((a, b) => b.score - a.score));
  }
  return index;
}

// A candidate's top score needs to clear this floor, AND beat the next-best
// *distinct site* by at least 2x, to count as "identified" rather than
// "disputed" — chosen against the real data (see lib/geography.js's own
// test fixtures and this file's header comment): Jerusalem/Rome/Damascus
// clear it easily (score 1000, no real competitor), Mount Sinai and Sodom
// don't (best candidate is either well below 300, or has a competitor
// within 2x), matching genuine scholarly consensus vs. dispute.
const IDENTIFIED_SCORE_FLOOR = 300;
const IDENTIFIED_DOMINANCE_RATIO = 2;

/**
 * Resolves one place name against the index. Two lookup passes:
 *
 * 1. Exact match (case/whitespace-insensitive).
 * 2. If that fails, the dataset's own numbered-variant convention — e.g.
 *    "Antioch 1"/"Antioch 2" for two real distinct places sharing an
 *    English name (Antioch on the Orontes vs. Antioch in Pisidia), or
 *    "Ur 1"/"Ur 2" for the same place under different verse-sense
 *    disambiguation. A bare "Antioch"/"Ur" query tries every "<name> N"
 *    variant: if they all agree on the same top site, it's safe to merge
 *    (same real place, just disambiguated in the source data) — but if
 *    they point to genuinely different top sites, this refuses to guess
 *    which one Claude meant and reports both as options instead. This is
 *    the crux of never fabricating geography: a name that's really
 *    ambiguous stays ambiguous rather than silently picking one.
 *
 * Returns one of:
 *   { found: true, name, modernName, lon, lat, certainty }
 *   { found: false, ambiguous: true, options: [{ modernName, lon, lat }] }
 *   { found: false }
 */
export function resolvePlaceName(index, rawName) {
  const key = normalizeName(rawName);
  let candidates = index.get(key);

  if (!candidates) {
    const variantPattern = new RegExp(`^${escapeRegExp(key)} \\d+$`);
    const variantKeys = [...index.keys()].filter((k) => variantPattern.test(k));
    if (variantKeys.length === 0) return { found: false };

    const variantGroups = variantKeys.map((k) => index.get(k));
    const topSites = new Set(variantGroups.map((g) => g[0].modernName));
    if (topSites.size > 1) {
      const uniqueOptions = new Map(variantGroups.map((g) => [g[0].modernName, { modernName: g[0].modernName, lon: g[0].lon, lat: g[0].lat }]));
      return { found: false, ambiguous: true, options: [...uniqueOptions.values()] };
    }
    // Same real place under multiple verse-sense entries -- safe to pool
    // every variant's candidates and re-rank as if it were one lookup.
    candidates = variantGroups.flat().sort((a, b) => b.score - a.score);
  }

  const top = candidates[0];
  const runnerUp = candidates.find((c) => c.modernName !== top.modernName);
  const certainty =
    top.score >= IDENTIFIED_SCORE_FLOOR && (!runnerUp || runnerUp.score * IDENTIFIED_DOMINANCE_RATIO < top.score)
      ? "identified"
      : "disputed";

  return { found: true, name: rawName, modernName: top.modernName, lon: top.lon, lat: top.lat, certainty };
}

let cachedIndex = null;

/** True once data/bible-geocoding-modern.jsonl has actually been downloaded. */
export async function isGeographyDataAvailable() {
  try {
    await access(dataFile(GEOCODING_FILE));
    return true;
  } catch {
    return false;
  }
}

async function loadIndex() {
  if (cachedIndex) return cachedIndex;

  const raw = await readFile(dataFile(GEOCODING_FILE), "utf8");
  const rows = raw.split("\n").flatMap(parseGeocodingLine);
  cachedIndex = buildGeographyIndex(rows);
  return cachedIndex;
}

/**
 * Resolves one place name against the real, downloaded dataset. Throws a
 * clear, catchable error (code "GEOGRAPHY_DATA_NOT_DOWNLOADED") rather than
 * a raw ENOENT if the data file hasn't been fetched yet — same pattern as
 * lib/bible-search.js and lib/cross-references.js.
 */
export async function resolvePlace(name) {
  if (!(await isGeographyDataAvailable())) {
    const error = new Error("Bible geocoding data not downloaded on the server yet — run `npm run fetch-data`.");
    error.code = "GEOGRAPHY_DATA_NOT_DOWNLOADED";
    throw error;
  }
  const index = await loadIndex();
  return resolvePlaceName(index, name);
}

/** Drops the cached index — for tests only (a real process loads it once and keeps it). */
export function clearGeographyCache() {
  cachedIndex = null;
}

// --- Curated named journeys ------------------------------------------------
// Waypoint strings are exact keys verified against the real dataset (see
// this project's commit history for how each was checked) — deliberately
// the disambiguated form ("Antioch 1", "Rhodes 2") wherever the plain name
// would otherwise hit the "same name, genuinely different real places"
// ambiguity resolvePlaceName() refuses to guess through. `certaintyNote` is
// an editorial note about the PATH between waypoints (rarely a single
// attested road), distinct from each waypoint's own per-place certainty,
// which is always computed live from the real data, never hardcoded here.
export const ROUTES = {
  "paul-1": {
    name: "Paul's First Missionary Journey",
    description: "Acts 13–14: from Antioch in Syria through Cyprus and the Roman province of Galatia, and back.",
    certaintyNote: "The cities are well-attested; the roads drawn between them follow standard Bible-atlas reconstructions, not an itinerary Acts spells out turn by turn.",
    waypoints: ["Antioch 1", "Seleucia", "Salamis", "Paphos", "Perga", "Antioch 2", "Iconium", "Lystra", "Derbe"],
  },
  "paul-2": {
    name: "Paul's Second Missionary Journey",
    description: "Acts 15:36–18:22: overland through Asia Minor, across into Macedonia and Achaia, and back via Ephesus and Jerusalem.",
    certaintyNote: "The cities are well-attested; the roads drawn between them follow standard Bible-atlas reconstructions, not an itinerary Acts spells out turn by turn.",
    waypoints: ["Antioch 1", "Derbe", "Lystra", "Troas", "Neapolis", "Philippi", "Amphipolis", "Apollonia", "Thessalonica", "Berea", "Athens", "Corinth", "Cenchreae", "Ephesus", "Caesarea", "Jerusalem"],
  },
  "paul-3": {
    name: "Paul's Third Missionary Journey",
    description: "Acts 18:23–21:17: an extended stay in Ephesus, back through Macedonia and Corinth, then by sea to Jerusalem.",
    certaintyNote: "The cities are well-attested; the roads drawn between them follow standard Bible-atlas reconstructions, not an itinerary Acts spells out turn by turn.",
    waypoints: ["Antioch 1", "Ephesus", "Corinth", "Philippi", "Troas", "Miletus", "Cos", "Rhodes 2", "Patara", "Tyre", "Ptolemais", "Caesarea", "Jerusalem"],
  },
  "paul-rome": {
    name: "Paul's Journey to Rome",
    description: "Acts 27–28: a prisoner's voyage from Caesarea, shipwrecked at Malta, and on to Rome.",
    certaintyNote: "The stops are well-attested; the sea route drawn between them is the natural sailing path, not a charted course from the text.",
    waypoints: ["Caesarea", "Sidon", "Myra", "Fair Havens", "Malta", "Syracuse", "Rhegium", "Puteoli", "Forum of Appius", "Three Taverns", "Rome"],
  },
  exodus: {
    name: "The Exodus (a traditional route)",
    description: "Egypt to Canaan by way of the wilderness, per Exodus and Numbers.",
    certaintyNote: "Genuinely disputed among scholars — even where the sea was crossed is debated. This shows one traditional reconstruction (the southern route through the Sinai peninsula), not a settled path; most of these wilderness stations have several proposed locations rather than one agreed site, which the map marks accordingly.",
    waypoints: ["Rameses", "Succoth 2", "Etham", "Pi-hahiroth", "Marah", "Elim", "Sin", "Rephidim", "Mount Sinai", "Kadesh-barnea"],
  },
  abraham: {
    name: "Abraham's Journey from Ur",
    description: "Genesis 11–13: from Ur of the Chaldeans to Canaan, with a detour to Egypt during a famine.",
    certaintyNote: "The named cities are well-attested; the path across open desert between them is inferred, not a mapped ancient road.",
    waypoints: ["Ur 2", "Haran", "Shechem", "Bethel 1", "Egypt", "Hebron"],
  },
};

export function getRoute(routeId) {
  return ROUTES[routeId] ?? null;
}

export function listRouteIds() {
  return Object.keys(ROUTES);
}
