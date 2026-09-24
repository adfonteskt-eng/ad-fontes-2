// Phase 3 QA: home view, standalone pages, and menu — everything here is
// static/no-Anthropic-cost (GET /api/daily, /api/config, /api/reading-plans,
// /api/outlines are all cheap, no LLM call). Real chat-triggering flows
// live in chat-flow.spec.js instead, kept deliberately small since those
// cost real Anthropic tokens (see CHECKLIST.md's tooling-decisions note).
import { test, expect } from "@playwright/test";

test("home view loads with the real title, tagline, and four example prompts", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("ad fontes");
  await expect(page.getByText("Ask about any passage")).toBeVisible();
  await expect(page.locator(".example")).toHaveCount(4);
});

test("clicking the site menu button opens the panel, showing signed-out actions for an anonymous visitor", async ({ page }) => {
  await page.goto("/");
  await page.locator("#site-menu-button").click();
  await expect(page.locator("#site-menu-panel")).toBeVisible();
  // Signed-out section should be the one showing, not a signed-in-only
  // control rendering broken/empty for an anonymous visitor.
  await expect(page.locator("#menu-signed-out")).toBeVisible();
  await expect(page.locator("#menu-signed-in")).toBeHidden();
});

test("/today loads with a real passage, no auth required", async ({ page }) => {
  const response = await page.goto("/today");
  expect(response.ok()).toBeTruthy();
  await expect(page.locator("#page-today")).toBeVisible();
  // The daily passage box should end up visible with real content once
  // GET /api/daily resolves -- it's hidden by default until then.
  await expect(page.locator("#daily-passage")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#daily-passage-button")).not.toHaveText("");
});

test("/sources loads with the real licensing content", async ({ page }) => {
  const response = await page.goto("/sources");
  expect(response.ok()).toBeTruthy();
  await expect(page.locator("#page-sources")).toBeVisible();
  await expect(page.getByText("STEPBible").first()).toBeVisible();
  await expect(page.getByText("YouVersion").first()).toBeVisible();
});

test("/subscription loads without crashing for a signed-out visitor", async ({ page }) => {
  const response = await page.goto("/subscription");
  expect(response.ok()).toBeTruthy();
  await expect(page.locator("#page-subscription")).toBeVisible();
});

test("/plans shows the Pro upsell lock, not a broken/empty list, for a signed-out visitor", async ({ page }) => {
  const response = await page.goto("/plans");
  expect(response.ok()).toBeTruthy();
  await expect(page.locator("#page-plans")).toBeVisible();
  await expect(page.locator("#reading-plans-locked")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#reading-plans")).toBeHidden();
});

test("/outlines shows the Pro upsell lock, not a broken/empty list, for a signed-out visitor", async ({ page }) => {
  const response = await page.goto("/outlines");
  expect(response.ok()).toBeTruthy();
  await expect(page.locator("#page-outlines")).toBeVisible();
  await expect(page.locator("#outlines-locked")).toBeVisible({ timeout: 10_000 });
});

// A hard refresh (not an in-app client-side route change) on each of these
// paths should still load the real app shell, not 404 -- server.js serves
// the same index.html for this fixed list of client-side routes.
for (const path of ["/chat", "/today", "/plans", "/outlines", "/subscription", "/sources"]) {
  test(`direct navigation (hard refresh) to ${path} serves the app shell, not a 404`, async ({ page }) => {
    const response = await page.goto(path);
    expect(response.ok()).toBeTruthy();
    await expect(page.locator("h1")).toHaveText("ad fontes");
  });
}
