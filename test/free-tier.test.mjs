import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { checkFreeTier, freeTierLimits, weekWindow, clearMemoryStoreForTests } from "../lib/rate-limit.js";

beforeEach(() => clearMemoryStoreForTests());

test("free tier is off unless FREE_WEEKLY_LIMIT is set", async () => {
  assert.equal(freeTierLimits({}).enabled, false);
  assert.equal(await checkFreeTier({ userId: "u1", ip: "1.1.1.1" }, { env: {} }), null);
});

test("weeks run Monday to Monday, UTC", () => {
  assert.deepEqual(weekWindow(new Date("2026-11-04T20:00:00Z")), { start: "2026-11-02", resetsOn: "2026-11-09" });
  assert.deepEqual(weekWindow(new Date("2026-11-08T23:59:00Z")), { start: "2026-11-02", resetsOn: "2026-11-09" });
  assert.deepEqual(weekWindow(new Date("2026-11-09T00:00:00Z")), { start: "2026-11-09", resetsOn: "2026-11-16" });
});

test("a free account gets exactly the weekly limit, then is blocked", async () => {
  const env = { FREE_WEEKLY_LIMIT: "3" };
  const now = new Date("2026-11-04T12:00:00Z");
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await checkFreeTier({ userId: "u2", ip: "2.2.2.2" }, { env, now }));
  assert.deepEqual(results.map((r) => r.allowed), [true, true, true, false]);
  assert.equal(results[3].used, 3);
  assert.equal(results[3].resetsOn, "2026-11-09");
});

test("paid accounts are never metered; a new week starts fresh", async () => {
  const env = { FREE_WEEKLY_LIMIT: "1" };
  assert.equal(await checkFreeTier({ userId: "u3", isPaid: true, ip: "3.3.3.3" }, { env }), null);
  const week1 = new Date("2026-11-04T12:00:00Z");
  const week2 = new Date("2026-11-10T12:00:00Z");
  await checkFreeTier({ userId: "u4", ip: "4" }, { env, now: week1 });
  assert.equal((await checkFreeTier({ userId: "u4", ip: "4" }, { env, now: week1 })).allowed, false);
  assert.equal((await checkFreeTier({ userId: "u4", ip: "4" }, { env, now: week2 })).allowed, true);
});

test("anonymous visitors are metered by IP, with their own limit if set", async () => {
  const env = { FREE_WEEKLY_LIMIT: "10", ANON_WEEKLY_LIMIT: "1" };
  assert.equal((await checkFreeTier({ ip: "5.5.5.5" }, { env })).allowed, true);
  assert.equal((await checkFreeTier({ ip: "5.5.5.5" }, { env })).allowed, false);
  assert.equal((await checkFreeTier({ ip: "6.6.6.6" }, { env })).allowed, true);
});
