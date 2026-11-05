import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, addUsage, estimateCostUsd, usageKey } from "../lib/usage.js";

test("addUsage sums every field across a turn's API calls", () => {
  const t = emptyUsage();
  addUsage(t, { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 4000, cache_creation_input_tokens: 2000 });
  addUsage(t, { input_tokens: 10, output_tokens: 700 });
  addUsage(t, undefined); // a stubbed response with no usage block
  assert.deepEqual(t, { calls: 2, input: 110, output: 750, cacheRead: 4000, cacheWrite: 2000 });
});

test("estimateCostUsd uses per-million-token prices", () => {
  const prices = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 };
  const cost = estimateCostUsd({ calls: 1, input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }, prices);
  assert.equal(cost, 24.3);
  assert.equal(estimateCostUsd(emptyUsage(), prices), 0);
});

test("usageKey is one key per UTC day", () => {
  assert.equal(usageKey(new Date("2026-11-04T23:59:00Z")), "adfontes:usage:2026-11-04");
});
