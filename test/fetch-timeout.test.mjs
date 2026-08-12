// fetchWithTimeout() is pure client-side timing logic — no external service
// involved — so it's fully verifiable here rather than needing live testing.
import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchWithTimeout } from "../lib/fetch-timeout.js";

test("fetchWithTimeout aborts a request that never resolves", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) =>
    new Promise((resolve, reject) => {
      opts.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });

  const start = Date.now();
  await assert.rejects(
    () => fetchWithTimeout("https://example.com/slow", {}, 200),
    /example\.com.*timed out|timed out.*example\.com/,
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 150 && elapsed <= 2000, `expected ~200ms, got ${elapsed}ms`);

  globalThis.fetch = realFetch;
});

test("fetchWithTimeout resolves normally for a fast request", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200 });

  const response = await fetchWithTimeout("https://example.com/fast", {}, 5000);
  assert.equal(response.ok, true);

  globalThis.fetch = realFetch;
});

test("fetchWithTimeout passes non-timeout errors through unchanged", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("ECONNREFUSED");
  };

  await assert.rejects(
    () => fetchWithTimeout("https://example.com/refused", {}, 5000),
    (error) => error.message === "ECONNREFUSED",
  );

  globalThis.fetch = realFetch;
});
