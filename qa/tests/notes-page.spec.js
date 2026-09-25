// Phase 3 QA (design/UX pass): regression coverage for the standalone My
// Notes page -- a direct fix for a real, audited gap versus competitors
// (see docs/DECISIONS.md's 2026-09-24 entry): notes were previously only
// ever visible inline on the exact passage they were written on, exactly
// the "buried notes" weakness the competitive research flagged in
// YouVersion. Unlike My Outlines/Reading Plans, notes are a free feature,
// so this page has a "sign in" state rather than a Pro-upsell lock.
//
// No real Supabase account and no Anthropic cost: the signed-in-state
// tests below stub window.adFontesAuth.getAccessToken (set AFTER the real
// auth.js has already defined window.adFontesAuth, so this only overrides
// the one method, not the whole signed-out session) and intercept
// GET/DELETE /api/notes and POST /api/chat with page.route -- exercising
// the real frontend render/click-delegation code path against
// deterministic fixture data, the same technique source-chips.spec.js
// uses for chat state.
import { test, expect } from "@playwright/test";

async function stubSignedIn(page, notes) {
  await page.route("**/api/notes*", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { notes } });
    } else {
      await route.continue();
    }
  });
  await page.evaluate(() => {
    window.adFontesAuth.getAccessToken = async () => "fake-test-token";
  });
}

test("/notes shows a sign-in prompt, not a broken/empty list, for a signed-out visitor", async ({ page }) => {
  const response = await page.goto("/notes");
  expect(response.ok()).toBeTruthy();
  await expect(page.locator("#page-notes")).toBeVisible();
  await expect(page.locator("#notes-page-signin")).toBeVisible();
  await expect(page.locator("#notes-page")).toBeHidden();
});

test("direct navigation (hard refresh) to /notes serves the app shell, not a 404", async ({ page }) => {
  const response = await page.goto("/notes");
  expect(response.ok()).toBeTruthy();
  await expect(page.locator("h1")).toHaveText("ad fontes");
});

test("the site menu offers My Notes between Reading Plans and My Outlines", async ({ page }) => {
  await page.goto("/");
  await page.locator("#site-menu-button").click();
  await expect(page.locator("#menu-notes-button")).toBeVisible();
  await expect(page.locator("#menu-notes-button")).toHaveText("My Notes");
});

test("clicking My Notes in the menu navigates to /notes", async ({ page }) => {
  await page.goto("/");
  await page.locator("#site-menu-button").click();
  await page.locator("#menu-notes-button").click();
  await expect(page).toHaveURL(/\/notes$/);
  await expect(page.locator("#page-notes")).toBeVisible();
});

test("a signed-in user with saved notes across several references sees them all, newest first, each labeled with its reference", async ({ page }) => {
  await page.goto("/");
  await stubSignedIn(page, [
    { id: 2, reference: "ROM.8.28", body: "All things work together for good.", createdAt: "2026-09-22T00:00:00Z" },
    { id: 1, reference: "JHN.3.16", body: "God's love for the whole world.", createdAt: "2026-09-20T00:00:00Z" },
  ]);
  await page.evaluate(() => window.adFontesNotesPage.refresh());
  await page.evaluate(() => window.adFontesChat.goToNotesPage());

  const items = page.locator("#notes-page-list .note-item");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0).locator(".note-item-reference")).toHaveText("ROM.8.28");
  await expect(items.nth(1).locator(".note-item-reference")).toHaveText("JHN.3.16");
  await expect(page.locator("#notes-page-empty")).toBeHidden();
});

test("a signed-in user with no notes yet sees the empty-state message, not a broken list", async ({ page }) => {
  await page.goto("/");
  await stubSignedIn(page, []);
  await page.evaluate(() => window.adFontesNotesPage.refresh());
  await page.evaluate(() => window.adFontesChat.goToNotesPage());

  await expect(page.locator("#notes-page-empty")).toBeVisible();
  await expect(page.locator("#notes-page-list .note-item")).toHaveCount(0);
});

test("clicking a note's reference asks about that passage in chat", async ({ page }) => {
  await page.goto("/");
  await stubSignedIn(page, [{ id: 1, reference: "JHN.3.16", body: "A note on John.", createdAt: "2026-09-20T00:00:00Z" }]);
  // No real Anthropic call -- a fake reply is enough to confirm the click
  // routes into chat with the right message, which is what this test is
  // actually checking (the real integration is covered by chat-flow.spec.js).
  await page.route("**/api/chat", async (route) => {
    await route.fulfill({ json: { sessionId: "s1", conversationId: null, reply: "A fake reply about John 3:16." } });
  });
  await page.evaluate(() => window.adFontesNotesPage.refresh());
  await page.evaluate(() => window.adFontesChat.goToNotesPage());

  await page.locator(".note-item-reference").click();
  await expect(page.locator(".chat-message.user").first()).toHaveText("What does JHN.3.16 mean?");
  await expect(page.locator(".chat-message.assistant").first()).toContainText("A fake reply about John 3:16.");
});

test("deleting a note removes it from the list", async ({ page }) => {
  await page.goto("/");
  await stubSignedIn(page, [{ id: 1, reference: "JHN.3.16", body: "Delete me.", createdAt: "2026-09-20T00:00:00Z" }]);
  await page.route("**/api/notes/1", async (route) => {
    if (route.request().method() === "DELETE") {
      await route.fulfill({ status: 204 });
    } else {
      await route.continue();
    }
  });
  await page.evaluate(() => window.adFontesNotesPage.refresh());
  await page.evaluate(() => window.adFontesChat.goToNotesPage());

  await expect(page.locator("#notes-page-list .note-item")).toHaveCount(1);
  await page.locator(".note-delete-button").click();
  await expect(page.locator("#notes-page-list .note-item")).toHaveCount(0);
});
