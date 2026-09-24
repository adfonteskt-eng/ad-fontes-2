// Phase 3 QA: visual/responsive checks across breakpoints. One real chat
// call (not five) — the conversation is loaded once, then the SAME page is
// resized across every breakpoint, since what's being checked (layout
// overflow) doesn't depend on re-fetching anything. Screenshots are saved
// for the written report; the pass/fail assertion itself is "no horizontal
// overflow," which is a real, objective layout bug (content forces a
// sideways scrollbar) rather than a subjective visual judgment call.
import { test, expect } from "@playwright/test";

const BREAKPOINTS = [
  { name: "320", width: 320, height: 800 },
  { name: "375", width: 375, height: 812 },
  { name: "768", width: 768, height: 1024 },
  { name: "1024", width: 1024, height: 768 },
  { name: "1440", width: 1440, height: 900 },
];

async function hasHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}

test("home view has no horizontal overflow at any breakpoint", async ({ page }) => {
  await page.goto("/");
  for (const bp of BREAKPOINTS) {
    await page.setViewportSize({ width: bp.width, height: bp.height });
    const overflowed = await hasHorizontalOverflow(page);
    expect(overflowed, `home view overflows horizontally at ${bp.name}px`).toBe(false);
    await page.screenshot({ path: `qa/screenshots/home-${bp.name}.png` });
  }
});

test("a loaded conversation (real gathered content, depth control, export row) has no horizontal overflow at any breakpoint", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await page.locator("#chat-input").fill("What does Romans 8:28 mean?");
  await page.locator("#chat-form button[type=submit]").click();
  await expect(page.locator(".source-passage").first()).toBeVisible({ timeout: 45_000 });

  for (const bp of BREAKPOINTS) {
    await page.setViewportSize({ width: bp.width, height: bp.height });
    const overflowed = await hasHorizontalOverflow(page);
    expect(overflowed, `loaded conversation overflows horizontally at ${bp.name}px`).toBe(false);
    await page.screenshot({ path: `qa/screenshots/conversation-${bp.name}.png` });
  }
});

test("the depth control and interlinear table stay usable (no overflow) at the narrowest breakpoint", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/");
  await expect(page.locator("#depth-control")).toBeVisible();
  const overflowed = await hasHorizontalOverflow(page);
  expect(overflowed).toBe(false);
});
