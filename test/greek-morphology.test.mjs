import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseMorphologyCodesText,
  buildMorphologyIndex,
  clearMorphologyCache,
} from "../lib/greek-morphology.js";

// Shaped after the real data/TEGMC.txt: a code+fields line (no leading
// tab), then three tab-indented continuation lines, then a "$" delimiter.
// Includes a trailing junk section shaped like the real file's proofing
// notes (a bare "CODE\tvalue" line with a *non*-tab-indented next line) to
// confirm the parser excludes it.
const FIXTURE = `Some header text
not a real entry at all

V-AAI-3S	Function=Verb; Tense=Aorist; Voice=Active; Mood=Indicative; Person=3rd; Number=Singular
	Verb Aorist Active Indicative 3rd Singular
	an ACTION that happened - by a person or thing being discussed
	"_he/she/it taught _"
$
CONJ	Function=Conjunction
	Conjunction
	joins words, phrases, or clauses together
	"_and, but, or_"
$
X-NSN	Function=Indefinite pronoun; Case=Nominative; Number=Singular; Gender=Neuter
	Indefinite pronoun Nominative Singular Neuter
	a pronoun referring to something unspecified
	"_something_"

HEB	KJV
KJV	KJV
N-NSM-C	KJV
check no comma without "
`;

test("parseMorphologyCodesText extracts only real entries", () => {
  const entries = parseMorphologyCodesText(FIXTURE);
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((e) => e.code),
    ["V-AAI-3S", "CONJ", "X-NSN"],
  );
});

test("parseMorphologyCodesText captures fields, label, description, example", () => {
  const [verb] = parseMorphologyCodesText(FIXTURE);
  assert.equal(verb.fields, "Function=Verb; Tense=Aorist; Voice=Active; Mood=Indicative; Person=3rd; Number=Singular");
  assert.equal(verb.shortLabel, "Verb Aorist Active Indicative 3rd Singular");
  assert.equal(verb.description, "an ACTION that happened - by a person or thing being discussed");
  assert.equal(verb.example, "_he/she/it taught _");
});

test("parseMorphologyCodesText handles an indeclinable (non-hyphenated) code", () => {
  const conj = parseMorphologyCodesText(FIXTURE).find((e) => e.code === "CONJ");
  assert.ok(conj);
  assert.equal(conj.shortLabel, "Conjunction");
});

test("parseMorphologyCodesText handles the final entry with no trailing $ delimiter", () => {
  const last = parseMorphologyCodesText(FIXTURE).find((e) => e.code === "X-NSN");
  assert.ok(last);
  assert.equal(last.example, "_something_");
});

test("parseMorphologyCodesText excludes trailing junk that superficially matches the code shape", () => {
  const codes = parseMorphologyCodesText(FIXTURE).map((e) => e.code);
  assert.ok(!codes.includes("HEB"));
  assert.ok(!codes.includes("KJV"));
  assert.ok(!codes.includes("N-NSM-C"));
});

test("buildMorphologyIndex builds a code -> entry lookup", () => {
  const index = buildMorphologyIndex(parseMorphologyCodesText(FIXTURE));
  assert.equal(index.get("V-AAI-3S").shortLabel, "Verb Aorist Active Indicative 3rd Singular");
  assert.equal(index.get("NOPE"), undefined);
});

test("clearMorphologyCache is callable (resets module-level cache for tests)", () => {
  assert.doesNotThrow(() => clearMorphologyCache());
});
