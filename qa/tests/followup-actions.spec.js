// Phase 3 QA (over-gathering fix, 2026-09-28 -- see docs/DECISIONS.md):
// regression coverage for the "go deeper" follow-up-actions row
// (public/app.js's buildFollowUpActions/renderFollowUpActions), the
// progressive-disclosure half of the fix for a real complaint that a
// narrow question was getting a maximal answer regardless of what was
// asked. Replies now default to a narrower set of gathered material; this
// row is what keeps that narrowness from being a dead end.
//
// No Anthropic cost: same localStorage-seeding technique as
// source-chips.spec.js -- a synthetic chatLogData entry in the exact shape
// saveChatState() writes, so the real restoreChatState() ->
// renderChatLog() -> renderFollowUpActions() path runs against
// deterministic fixture data instead of a real, slow, costly tool-call
// chain. The real end-to-end behavior (a narrow question actually
// producing a narrow gather, and a follow-up button actually working) is
// verified live and documented in docs/DECISIONS.md's 2026-09-28 entry.
import { test, expect } from "@playwright/test";

const STORAGE_KEY = "adfontes.chat.v1";

function seedConversation(page, log) {
  return page.addInitScript(
    ({ key, payload }) => {
      localStorage.setItem(key, JSON.stringify(payload));
    },
    { key: STORAGE_KEY, payload: { sessionId: "test-session", conversationId: null, log } },
  );
}

function fullGathered(usfm) {
  return {
    reference: { usfm },
    translations: [{ translation: { abbr: "BSB", name: "Berean Standard Bible" }, content: "Sample verse text." }],
    originalLanguage: { type: "greek", words: [{ surface: "λόγος" }] },
    commentary: { entries: [{ name: "Barnes' Notes", body: "Sample commentary." }] },
  };
}

function narrowGathered(usfm) {
  return {
    reference: { usfm },
    translations: [],
    originalLanguage: { type: "greek", words: [{ surface: "λόγος" }] },
    commentary: { skipped: true, entries: [], error: null, url: null },
  };
}

test("a fully-gathered reply with no cross-references or briefing offers exactly those two follow-ups", async ({ page }) => {
  const log = [
    { role: "user", text: "What does John 3:16 mean?" },
    { role: "assistant", text: "Here's the passage.", gathered: [fullGathered("JHN.3.16")] },
  ];
  await seedConversation(page, log);
  await page.goto("/");

  const actions = page.locator(".followup-actions .followup-action");
  await expect(actions).toHaveCount(2);
  await expect(actions.nth(0)).toHaveText("See cross-references");
  await expect(actions.nth(1)).toHaveText("Get a passage briefing");
});

test("a narrowly-gathered reply (original language only) offers all four follow-ups", async ({ page }) => {
  const log = [
    { role: "user", text: "What's the Greek word for love in John 3:16?" },
    { role: "assistant", text: "The word is agapaō.", gathered: [narrowGathered("JHN.3.16")] },
  ];
  await seedConversation(page, log);
  await page.goto("/");

  const actions = page.locator(".followup-actions .followup-action");
  await expect(actions).toHaveCount(4);
  const labels = await actions.allTextContents();
  assertSameMembers(labels, ["Show translations", "Show commentary", "See cross-references", "Get a passage briefing"]);

  // The skipped sections render as nothing at all -- no "Translations" or
  // "Commentary" heading, no placeholder/error text -- not just "the
  // follow-up buttons account for them."
  const sourceBody = page.locator(".source-passage .source-body");
  await expect(sourceBody.getByText("Translations", { exact: true })).toHaveCount(0);
  await expect(sourceBody.getByText("Commentary", { exact: true })).toHaveCount(0);
  await expect(sourceBody.getByText("Original language", { exact: true })).toBeVisible();
});

test("a reply that already has a cross-reference and a briefing for the same passage offers no follow-ups at all", async ({ page }) => {
  const log = [
    { role: "user", text: "Tell me everything about John 3:16." },
    {
      role: "assistant",
      text: "Here's everything.",
      gathered: [fullGathered("JHN.3.16")],
      crossReferences: [{ reference: "JHN.3.16", results: [{ reference: "ROM.5.8", votes: 10 }], totalCount: 10 }],
      briefings: [{ reference: "JHN", genre: "Gospel", traditionalAuthor: "John", approximateDate: "c. AD 90", structureNote: "...", disclosure: "General background from the model's own knowledge, not verified against a dataset." }],
    },
  ];
  await seedConversation(page, log);
  await page.goto("/");

  await expect(page.locator(".followup-actions")).toHaveCount(0);
});

test("a reply that gathered nothing at all (e.g. a lexicon-only turn) shows no follow-up row", async ({ page }) => {
  const log = [
    { role: "user", text: "What Greek words mean love?" },
    { role: "assistant", text: "There's agapaō, phileō, and storge." },
  ];
  await seedConversation(page, log);
  await page.goto("/");

  await expect(page.locator(".followup-actions")).toHaveCount(0);
});

test("clicking a follow-up action sends its canned prompt as a real new chat message", async ({ page }) => {
  const log = [
    { role: "user", text: "What's the Greek word for love in John 3:16?" },
    { role: "assistant", text: "The word is agapaō.", gathered: [narrowGathered("JHN.3.16")] },
  ];
  await seedConversation(page, log);
  await page.goto("/");

  // No real Anthropic call -- confirms the click routes into chat with the
  // right message, which is what this test checks; chat-flow.spec.js
  // covers the real end-to-end tool-calling behavior separately.
  await page.route("**/api/chat", async (route) => {
    await route.fulfill({ json: { sessionId: "s1", conversationId: null, reply: "Here are the translations." } });
  });

  await page.locator(".followup-action", { hasText: "Show translations" }).click();
  await expect(page.locator(".chat-message.user").last()).toHaveText("Show me the translations for JHN.3.16.");
  await expect(page.locator(".chat-message.assistant").last()).toContainText("Here are the translations.");
});

function assertSameMembers(actual, expected) {
  const a = [...actual].sort();
  const e = [...expected].sort();
  if (JSON.stringify(a) !== JSON.stringify(e)) {
    throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
  }
}
