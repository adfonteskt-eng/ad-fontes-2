import { test, after } from "node:test";
import assert from "node:assert/strict";
import { pickEntry, fetchCommentaries, clearCommentaryCache } from "../lib/commentary.js";

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; clearCommentaryCache(); });

const chapter = (entries, numberOfVerses = 21) => ({ chapter: { number: 3, content: entries }, numberOfVerses });

test("pickEntry returns the exact verse when present", () => {
  const ch = chapter([{ type: "verse", number: 16, content: ["For God so loved"] }]);
  assert.deepEqual(pickEntry(ch, "16"), { body: "For God so loved", section: null });
});

test("pickEntry falls back to the section containing the verse", () => {
  const ch = chapter([
    { type: "verse", number: 1, content: ["Nicodemus section"] },
    { type: "verse", number: 22, content: ["Judea section"] },
  ], 36);
  assert.deepEqual(pickEntry(ch, "16"), { body: "Nicodemus section", section: "verses 1–21" });
  assert.equal(pickEntry(ch, "30").section, "verses 22–36");
});

test("pickEntry returns null before the first entry or for an empty chapter", () => {
  assert.equal(pickEntry(chapter([{ type: "verse", number: 5, content: ["x"] }]), "2"), null);
  assert.equal(pickEntry(null, "1"), null);
});

test("fetchCommentaries skips Keil-Delitzsch for NT books and tolerates 404s", async () => {
  clearCommentaryCache();
  const asked = [];
  globalThis.fetch = async (url) => {
    const href = url.toString();
    asked.push(href);
    if (href.includes("/john-gill/")) return { ok: false, status: 404, statusText: "Not Found" };
    return { ok: true, status: 200, json: async () => chapter([{ type: "verse", number: 16, content: ["text"] }]) };
  };
  const result = await fetchCommentaries({ book: "Jhn", chapter: "3", verse: "16" });
  assert.ok(!asked.some((u) => u.includes("keil-delitzsch")), "no OT-only commentary for John");
  assert.deepEqual(result.entries.map((e) => e.name), ["Matthew Henry", "Jamieson-Fausset-Brown", "Adam Clarke"]);
});

test("fetchCommentaries throws only when every source errored", async () => {
  clearCommentaryCache();
  globalThis.fetch = async () => ({ ok: false, status: 500, statusText: "Server Error" });
  await assert.rejects(fetchCommentaries({ book: "Rom", chapter: "8", verse: "28" }), /500/);
});
