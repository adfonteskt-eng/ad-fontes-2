// lib/reading-plans.js: static curated content, not behavior -- these
// tests are sanity checks on the data's own shape (unique plan ids,
// sequential day numbers, well-formed single-verse USFM references) rather
// than anything that calls out to a network or a database. Catches the
// kind of copy-paste mistake that's easy to make hand-writing curated
// content (a duplicated id, a skipped day number) before it ships.
import { test } from "node:test";
import assert from "node:assert/strict";

import { READING_PLANS, getReadingPlan, isValidPlanDay } from "../lib/reading-plans.js";

test("every plan has a unique id", () => {
  const ids = READING_PLANS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "plan ids should all be unique");
});

test("every plan id is kebab-case (matches server.js's READING_PLAN_DAY_PATTERN)", () => {
  for (const plan of READING_PLANS) {
    assert.match(plan.id, /^[a-z0-9-]+$/, `${plan.id} should be lowercase kebab-case`);
  }
});

test("every plan has a title, description, and at least one day", () => {
  for (const plan of READING_PLANS) {
    assert.ok(plan.title && plan.title.length > 0, `${plan.id} needs a title`);
    assert.ok(plan.description && plan.description.length > 0, `${plan.id} needs a description`);
    assert.ok(plan.days.length > 0, `${plan.id} needs at least one day`);
  }
});

test("every plan's days are numbered 1..N with no gaps or duplicates", () => {
  for (const plan of READING_PLANS) {
    const dayNumbers = plan.days.map((d) => d.day);
    const expected = plan.days.map((_, i) => i + 1);
    assert.deepEqual(dayNumbers, expected, `${plan.id}'s days should be numbered 1..${plan.days.length} in order`);
  }
});

test("every day has a single-verse USFM reference (BOOK.chapter.verse, no ranges)", () => {
  for (const plan of READING_PLANS) {
    for (const day of plan.days) {
      // Deliberately stricter than lib/interlinear.js's own parseReference()
      // (which would also accept a "16-18" range as the verse segment) --
      // see this file's header comment on why every day here has to be a
      // single verse, not a range.
      assert.match(day.usfm, /^[A-Z0-9]+\.\d+\.\d+$/, `${plan.id} day ${day.day}: "${day.usfm}" should be a single-verse USFM reference`);
      assert.ok(day.label && day.label.length > 0, `${plan.id} day ${day.day} needs a label`);
      assert.ok(day.tag && day.tag.length > 0, `${plan.id} day ${day.day} needs a tag`);
    }
  }
});

test("getReadingPlan finds a plan by id, or returns undefined for an unknown one", () => {
  const plan = getReadingPlan("gospel-in-six-verses");
  assert.ok(plan);
  assert.equal(plan.id, "gospel-in-six-verses");
  assert.equal(getReadingPlan("not-a-real-plan"), undefined);
});

test("isValidPlanDay accepts real day numbers and rejects everything else", () => {
  const plan = getReadingPlan("gospel-in-six-verses");
  assert.equal(isValidPlanDay(plan, 1), true);
  assert.equal(isValidPlanDay(plan, plan.days.length), true);
  assert.equal(isValidPlanDay(plan, 0), false);
  assert.equal(isValidPlanDay(plan, plan.days.length + 1), false);
  assert.equal(isValidPlanDay(plan, 1.5), false);
});
