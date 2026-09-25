// Phase 3 QA (design/UX pass): regression coverage for the source-chips
// strip (public/app.js's renderSourceChips/buildSourceChips), which evolved
// Receipts Mode's old standalone quote-verification badge into a unified,
// Perplexity-style citation strip -- see docs/DECISIONS.md's 2026-09-24
// "source chips" entry for the full design reasoning.
//
// No Anthropic cost: rather than driving a real chat call (chat-flow.spec.js
// already does that, and is extended below to check the strip renders at
// all for a real reply), this file seeds localStorage directly with a
// synthetic chatLogData entry in the exact shape saveChatState() writes
// (see app.js's STORAGE_KEY/saveChatState), then loads the page so the
// real restoreChatState() -> renderChatLog() -> renderSourceChips() code
// path runs against deterministic, disk-free fixture data. This is the only
// practical way to regression-test the dedup/cap logic itself: reproducing
// a reply that gathers a dozen+ passages (the actual bug this pass found —
// see BUGS.md) via a real API call would be slow, costly, and non-
// deterministic every run.
import { test, expect } from "@playwright/test";

const STORAGE_KEY = "adfontes.chat.v1";

function makeGathered(usfm, { translations = ["BSB", "WEB"], commentaryName = "Barnes' Notes" } = {}) {
  return {
    reference: { usfm },
    translations: translations.map((abbr) => ({
      translation: { abbr, name: `${abbr} full name` },
      content: `Sample verse text for ${usfm} (${abbr}), long enough to exercise the chip preview truncation logic across every distinct translation abbreviation used in this fixture.`,
    })),
    originalLanguage: { type: "greek", words: [{ surface: "λόγος" }, { surface: "θεός" }] },
    commentary: { entries: [{ name: commentaryName, body: `${commentaryName}'s real note on ${usfm}.` }] },
  };
}

function seedConversation(page, log) {
  return page.addInitScript(
    ({ key, payload }) => {
      localStorage.setItem(key, JSON.stringify(payload));
    },
    { key: STORAGE_KEY, payload: { sessionId: "test-session", conversationId: null, log } },
  );
}

test("a reply citing several distinct source types renders one chip per distinct source, with quote-verification chips evolved into the same strip", async ({ page }) => {
  const log = [
    { role: "user", text: "Tell me about John 3:16 and James 1:2." },
    {
      role: "assistant",
      text: "Here's what I found.",
      gathered: [makeGathered("JHN.3.16")],
      crossReferences: [{ reference: "JHN.3.16", results: [{ reference: "ROM.5.8", votes: 40 }], totalCount: 40 }],
      wordStudies: [{ strongsNumber: "G26", totalCount: 12 }],
      briefings: [{ reference: "JAS", genre: "Wisdom", traditionalAuthor: "James", approximateDate: "c. AD 45-50", structureNote: "Loosely organized", disclosure: "General background from the model's own knowledge, not verified against a dataset." }],
      quoteVerification: {
        allVerified: false,
        quotes: [
          { span: "For God so loved the world", verified: true, source: { translationAbbr: "BSB", usfm: "JHN.3.16" } },
          { span: "a completely fabricated quotation", verified: false, source: null },
        ],
      },
    },
  ];
  await seedConversation(page, log);
  await page.goto("/");

  const strip = page.locator(".source-chips-strip");
  await expect(strip).toBeVisible();

  // One chip per distinct source: quote-verified, quote-unverified, BSB,
  // WEB, Greek (NA28), Barnes' Notes, Cross-refs, Word study, Briefing = 9.
  await expect(strip.locator(".source-chip")).toHaveCount(9);
  await expect(strip.locator(".source-chip.quote-verified")).toHaveText("Quote verified");
  await expect(strip.locator(".source-chip.quote-unverified")).toHaveText("Quote mismatch");
  await expect(strip.locator(".source-chip.background")).toHaveText("Briefing: JAS");
  await expect(page.locator(".source-chips-summary")).toContainText("a quote is flagged");

  // No standalone quote-verification badge anymore -- it's been fully
  // evolved into chips in this one strip, not left as a parallel system.
  await expect(page.locator(".quote-verification")).toHaveCount(0);
});

test("clicking a source chip reveals its preview; clicking a second chip closes the first", async ({ page }) => {
  const log = [
    { role: "user", text: "What does John 3:16 say?" },
    { role: "assistant", text: "Here's the passage.", gathered: [makeGathered("JHN.3.16", { translations: ["BSB", "WEB"] })] },
  ];
  await seedConversation(page, log);
  await page.goto("/");

  const bsbChip = page.locator(".source-chip", { hasText: "BSB" });
  const webChip = page.locator(".source-chip", { hasText: "WEB" });
  await expect(bsbChip).toHaveAttribute("aria-expanded", "false");

  await bsbChip.click();
  await expect(bsbChip).toHaveAttribute("aria-expanded", "true");
  const bsbPreview = page.locator(".source-chip-preview").filter({ hasText: "JHN.3.16" }).first();
  await expect(bsbPreview).toBeVisible();

  await webChip.click();
  await expect(bsbChip).toHaveAttribute("aria-expanded", "false");
  await expect(webChip).toHaveAttribute("aria-expanded", "true");
  // Exactly one preview panel visible at a time -- opening a second chip
  // must close the first, not stack both underneath the strip.
  await expect(page.locator(".source-chip-preview:visible")).toHaveCount(1);
});

test("a reply gathering many passages with the same fixed translations/commentaries dedupes to one chip per source, not one per passage", async ({ page }) => {
  // Regression for the real bug this pass found: a passage-briefing-style
  // reply that calls gather_passage a dozen times over produced ~100
  // near-duplicate chips (the same BSB/WEB/Barnes' Notes labels repeated
  // once per passage) before dedup was added -- see BUGS.md.
  const gathered = Array.from({ length: 12 }, (_, i) => makeGathered(`JAS.1.${i + 1}`));
  const log = [
    { role: "user", text: "Give me a full briefing on James." },
    { role: "assistant", text: "Here's the briefing.", gathered },
  ];
  await seedConversation(page, log);
  await page.goto("/");

  const strip = page.locator(".source-chips-strip");
  // 12 identical passages, each with {BSB, WEB, Greek, Barnes' Notes} ->
  // exactly 4 distinct chips after dedup, not 48.
  await expect(strip.locator(".source-chip")).toHaveCount(4);
  await expect(page.locator(".source-chips-summary")).toContainText("4 sources");
});

test("a turn with more genuinely distinct sources than the display cap shows the cap and an overflow note, not an unbounded strip", async ({ page }) => {
  const crossReferences = Array.from({ length: 20 }, (_, i) => ({
    reference: `PSA.${i + 1}.1`,
    results: [{ reference: `PSA.${i + 2}.1`, votes: 5 }],
    totalCount: 5,
  }));
  const log = [
    { role: "user", text: "Cross-references for twenty different psalms." },
    { role: "assistant", text: "Here they are.", crossReferences },
  ];
  await seedConversation(page, log);
  await page.goto("/");

  const strip = page.locator(".source-chips-strip");
  await expect(strip.locator(".source-chip")).toHaveCount(14);
  await expect(page.locator(".source-chips-summary")).toContainText("more below");
});
