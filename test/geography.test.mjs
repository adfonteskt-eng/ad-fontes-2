// lib/geography.js: parsing openbible.info's Bible-Geocoding-Data format,
// building the name index, resolvePlaceName()'s exact/ambiguous/merge logic,
// and resolvePlace()'s handling of a not-yet-downloaded data file. Same
// "file missing" caveat and pattern as test/bible-search.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, rename } from "node:fs/promises";

import { dataFile } from "../scripts/fetch-data.js";
import {
  parseGeocodingLine,
  buildGeographyIndex,
  resolvePlaceName,
  resolvePlace,
  isGeographyDataAvailable,
  clearGeographyCache,
  getRoute,
  listRouteIds,
  GEOCODING_FILE,
} from "../lib/geography.js";

// --- parseGeocodingLine --------------------------------------------------

test("parseGeocodingLine extracts one row per ancient association", () => {
  const line = JSON.stringify({
    friendly_id: "Jerusalem",
    lonlat: "35.234167,31.776667",
    ancient_associations: { a1: { name: "Jerusalem", score: 1000 }, a2: { name: "Zion", score: 500 } },
  });
  const rows = parseGeocodingLine(line);
  assert.deepEqual(rows, [
    { biblicalName: "Jerusalem", modernName: "Jerusalem", lon: 35.234167, lat: 31.776667, score: 1000 },
    { biblicalName: "Zion", modernName: "Jerusalem", lon: 35.234167, lat: 31.776667, score: 500 },
  ]);
});

test("parseGeocodingLine returns [] for a blank line, malformed JSON, or missing fields, without throwing", () => {
  assert.deepEqual(parseGeocodingLine(""), []);
  assert.deepEqual(parseGeocodingLine("   "), []);
  assert.deepEqual(parseGeocodingLine("not json"), []);
  assert.deepEqual(parseGeocodingLine(JSON.stringify({ friendly_id: "X" })), [], "missing lonlat/ancient_associations");
  assert.deepEqual(parseGeocodingLine(JSON.stringify({ friendly_id: "X", lonlat: "bad", ancient_associations: {} })), []);
});

// --- buildGeographyIndex / resolvePlaceName -------------------------------

const FIXTURE_ROWS = [
  { biblicalName: "Jerusalem", modernName: "Jerusalem", lon: 35.23, lat: 31.78, score: 1000 },
  { biblicalName: "Antioch 1", modernName: "Antioch on the Orontes", lon: 36.17, lat: 36.23, score: 1000 },
  { biblicalName: "Antioch 2", modernName: "Antioch in Pisidia", lon: 31.19, lat: 38.31, score: 1000 },
  { biblicalName: "Ur 1", modernName: "Tell el Muqayyar", lon: 46.1, lat: 30.96, score: 703 },
  { biblicalName: "Ur 1", modernName: "Urfa", lon: 38.78, lat: 37.15, score: 53 },
  { biblicalName: "Ur 2", modernName: "Tell el Muqayyar", lon: 46.1, lat: 30.96, score: 1000 },
  { biblicalName: "Mount Sinai", modernName: "Jebel Musa", lon: 33.97, lat: 28.54, score: 465 },
  { biblicalName: "Mount Sinai", modernName: "Jebel Serbal", lon: 33.65, lat: 28.65, score: 54 },
  { biblicalName: "Sodom", modernName: "Bab edh Dhra", lon: 35.52, lat: 31.25, score: 135 },
  { biblicalName: "Sodom", modernName: "north of the Dead Sea", lon: 35.6, lat: 31.8, score: 250 },
];

function fixtureIndex() {
  return buildGeographyIndex(FIXTURE_ROWS);
}

test("resolvePlaceName resolves an exact, dominant match as identified", () => {
  const r = resolvePlaceName(fixtureIndex(), "Jerusalem");
  assert.deepEqual(r, { found: true, name: "Jerusalem", modernName: "Jerusalem", lon: 35.23, lat: 31.78, certainty: "identified" });
});

test("resolvePlaceName is case/whitespace-insensitive", () => {
  const r = resolvePlaceName(fixtureIndex(), "  JERUSALEM  ");
  assert.equal(r.found, true);
  assert.equal(r.modernName, "Jerusalem");
});

test("resolvePlaceName merges numbered variants that agree on the same top site", () => {
  const r = resolvePlaceName(fixtureIndex(), "Ur");
  assert.equal(r.found, true);
  assert.equal(r.modernName, "Tell el Muqayyar");
  assert.equal(r.certainty, "identified", "703 and 1000 both dominate the 53-score alternative heavily");
});

test("resolvePlaceName reports genuinely distinct same-name places as ambiguous, without guessing", () => {
  const r = resolvePlaceName(fixtureIndex(), "Antioch");
  assert.equal(r.found, false);
  assert.equal(r.ambiguous, true);
  const names = r.options.map((o) => o.modernName).sort();
  assert.deepEqual(names, ["Antioch in Pisidia", "Antioch on the Orontes"]);
});

test("resolvePlaceName marks a close, low-confidence contest as disputed", () => {
  const r = resolvePlaceName(fixtureIndex(), "Sodom");
  assert.equal(r.found, true);
  assert.equal(r.certainty, "disputed", "top score 250 doesn't clear the identified floor, and the runner-up (135) isn't far behind");
});

test("resolvePlaceName marks a below-floor-but-dominant candidate as identified when it clears both the floor and the dominance ratio", () => {
  const r = resolvePlaceName(fixtureIndex(), "Mount Sinai");
  assert.equal(r.found, true);
  assert.equal(r.modernName, "Jebel Musa");
  assert.equal(r.certainty, "identified", "465 clears the floor and the 54-score alternative isn't within half of it");
});

test("resolvePlaceName returns found:false for a name with no match at all", () => {
  assert.deepEqual(resolvePlaceName(fixtureIndex(), "Atlantis"), { found: false });
});

// --- Curated routes --------------------------------------------------------

test("every route's waypoints are non-empty strings and routes have the expected shape", () => {
  for (const id of listRouteIds()) {
    const route = getRoute(id);
    assert.ok(route.name.length > 0);
    assert.ok(route.description.length > 0);
    assert.ok(route.certaintyNote.length > 0);
    assert.ok(Array.isArray(route.waypoints) && route.waypoints.length >= 2);
    for (const wp of route.waypoints) assert.equal(typeof wp, "string");
  }
});

test("getRoute returns null for an unknown route id", () => {
  assert.equal(getRoute("not-a-real-route"), null);
});

// --- resolvePlace / isGeographyDataAvailable: the "not yet downloaded" path --
// Same reasoning as test/bible-search.test.mjs's withBsbFileMissing().

const REAL_PATH = dataFile(GEOCODING_FILE);
const MOVED_ASIDE_PATH = dataFile(`${GEOCODING_FILE}.test-backup`);

async function withGeographyFileMissing(fn) {
  let movedAside = false;
  try {
    await access(REAL_PATH);
    await rename(REAL_PATH, MOVED_ASIDE_PATH);
    movedAside = true;
  } catch {
    // Already missing in this environment -- nothing to move.
  }
  clearGeographyCache();
  try {
    await fn();
  } finally {
    if (movedAside) await rename(MOVED_ASIDE_PATH, REAL_PATH);
    clearGeographyCache();
  }
}

test("isGeographyDataAvailable is false when data/bible-geocoding-modern.jsonl hasn't been downloaded", async () => {
  await withGeographyFileMissing(async () => {
    assert.equal(await isGeographyDataAvailable(), false);
  });
});

test("resolvePlace throws a clear, catchable error when the data file is missing", async () => {
  await withGeographyFileMissing(async () => {
    await assert.rejects(
      () => resolvePlace("Jerusalem"),
      (error) => {
        assert.equal(error.code, "GEOGRAPHY_DATA_NOT_DOWNLOADED");
        assert.match(error.message, /fetch-data/);
        return true;
      },
    );
  });
});
