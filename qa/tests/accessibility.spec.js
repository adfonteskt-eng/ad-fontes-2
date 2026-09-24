// Phase 3 QA: accessibility scanning via axe-core (see CHECKLIST.md's
// tooling-decisions note for why this dependency was added). Scoped to
// critical/serious violations only -- axe's "moderate"/"minor" categories
// include a lot of genuinely debatable best-practice items that would turn
// this into a style debate rather than a real accessibility bug list; a
// critical/serious violation is the bar for "this actually blocks someone
// using assistive tech," which is what QA should be catching.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function seriousViolations(page) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
}

function describeViolations(violations) {
  return violations.map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.length} node(s)`).join("\n");
}

test("home view has no critical/serious accessibility violations", async ({ page }) => {
  await page.goto("/");
  const violations = await seriousViolations(page);
  expect(violations, describeViolations(violations)).toEqual([]);
});

test("/today has no critical/serious accessibility violations", async ({ page }) => {
  await page.goto("/today");
  await expect(page.locator("#daily-passage")).toBeVisible({ timeout: 10_000 });
  const violations = await seriousViolations(page);
  expect(violations, describeViolations(violations)).toEqual([]);
});

test("/sources has no critical/serious accessibility violations", async ({ page }) => {
  await page.goto("/sources");
  const violations = await seriousViolations(page);
  expect(violations, describeViolations(violations)).toEqual([]);
});

test("the site menu (open) has no critical/serious accessibility violations", async ({ page }) => {
  await page.goto("/");
  await page.locator("#site-menu-button").click();
  await expect(page.locator("#site-menu-panel")).toBeVisible();
  const violations = await seriousViolations(page);
  expect(violations, describeViolations(violations)).toEqual([]);
});

test("keyboard-only: the chat input is already focused on first load, and Tab/Shift+Tab move sensibly from there", async ({ page }) => {
  await page.goto("/");
  // Deliberate, documented behavior (see app.js's own comment right above
  // its `chatInput.focus({ preventScroll: true })` call): the home view
  // focuses the input via JS on load rather than a plain `autofocus`
  // attribute, specifically so a keyboard/screen-reader user lands
  // directly on the app's one real entry point without tabbing through
  // nav chrome first. Confirmed here rather than assumed from reading the
  // comment.
  await expect(page.locator("#chat-input")).toBeFocused();

  // Forward from the input reaches Send next (it's the very next focusable
  // element in DOM order).
  await page.keyboard.press("Tab");
  const afterInput = await page.evaluate(() => document.activeElement?.tagName + ":" + (document.activeElement?.type ?? ""));
  expect(afterInput).toBe("BUTTON:submit");

  // Backward from the input still reaches the site menu button -- nav
  // chrome is skipped by default focus, not removed from the tab order
  // entirely.
  await page.locator("#chat-input").focus();
  const seen = [];
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Shift+Tab");
    const id = await page.evaluate(() => document.activeElement?.id);
    seen.push(id);
    if (id === "site-menu-button") break;
  }
  expect(seen).toContain("site-menu-button");
});
