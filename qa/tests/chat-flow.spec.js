// Phase 3 QA: real, end-to-end chat flow tests — these hit the real
// Anthropic API and cost real tokens (see CHECKLIST.md's tooling-decisions
// note), so this file is deliberately a small, representative sample, not
// one test per feature. Every individual tool's own logic already has real
// unit-test coverage with stubbed Anthropic responses in test/chat.test.mjs;
// what these tests prove is that the real integration actually renders
// correctly end to end. Passage Briefing, Observe/Interpret/Apply, Reel
// Kit, Alphabet Mode, and the manuscript-variant layer were each already
// verified live with real chat calls during their own implementation this
// session (see docs/DECISIONS.md's 2026-09-23 entries for the specifics —
// screenshots, exact verses, exact rendered output) and aren't repeated
// here just to avoid redundant real-API spend for the same ground already
// covered.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { collectCspViolations, getCspViolations, describeCspViolations } from "./helpers.js";

test.setTimeout(60_000);

test("a bare-reference message returns real gathered material, renders an injected script as inert text, and the loaded conversation passes an accessibility scan", async ({ page }) => {
  await collectCspViolations(page);
  await page.goto("/");
  // The injection attempt rides along in the same real message as a
  // legitimate question, rather than spending a second Anthropic call on
  // its own -- see this file's header comment on keeping real-call count
  // small. If public/app.js's textContent-based rendering (escapeHtml())
  // ever regressed to innerHTML, this would actually create the element
  // and window.__qaXssFired would be true.
  await page.evaluate(() => {
    window.__qaXssFired = false;
    window.__qaXssMarker = () => {
      window.__qaXssFired = true;
    };
  });
  await page.locator("#chat-input").fill('<img src=x onerror="window.__qaXssMarker && window.__qaXssMarker()"> What does Genesis 1:1 mean?');
  await page.locator("#chat-form button[type=submit]").click();

  // A real reply, with real gathered source material underneath it.
  await expect(page.locator(".chat-message.assistant").first()).toBeVisible({ timeout: 45_000 });
  await expect(page.locator(".source-passage").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".translation p").first()).not.toHaveText("");

  const xssFired = await page.evaluate(() => window.__qaXssFired);
  expect(xssFired, "an injected <img onerror> in a chat message must never execute").toBe(false);
  // Also confirm it shows up as plain, harmless text rather than silently
  // vanishing (which would hide a real rendering bug behind "looks clean").
  await expect(page.locator(".chat-message.user").first()).toContainText("<img src=x");

  const violations = (await new AxeBuilder({ page }).analyze()).violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );
  expect(violations.map((v) => `${v.id}: ${v.help}`), "loaded conversation should have no critical/serious a11y violations").toEqual([]);

  const cspViolations = await getCspViolations(page);
  expect(cspViolations, describeCspViolations(cspViolations)).toEqual([]);
});

test("a word-study request renders the real per-book frequency chart, with bar widths correctly applied via the CSSOM (not a blocked inline style)", async ({ page }) => {
  test.setTimeout(120_000);
  await collectCspViolations(page);
  await page.goto("/");
  await page.locator("#chat-input").fill("Do a word study on the Greek word for love, agape, and show me where it occurs across the Bible.");
  await page.locator("#chat-form button[type=submit]").click();

  // Genuinely slower than a single-tool reply: this typically chains
  // search_lexicon -> find_occurrences (sometimes gather_passage too)
  // before Claude can answer, observed live to take well over 45s.
  await expect(page.locator(".word-study-web").first()).toBeVisible({ timeout: 100_000 });
  await expect(page.locator(".word-study-bar-row").first()).toBeVisible();
  // byBook is always real, dataset-backed data (lib/interlinear.js's
  // tallyOccurrencesByBook) regardless of whether the model also chooses
  // to add sense-groups -- that part is real and always present, so it's
  // the right thing to assert on rather than the model-discretion parts.
  const barCount = await page.locator(".word-study-bar-row").count();
  expect(barCount).toBeGreaterThan(0);

  // The bar width is set via applyComputedStyles() (public/app.js) reading
  // a data-pct attribute, specifically so no style="..." attribute is
  // needed under the strict CSP -- confirm it actually landed on the real
  // element (not just "no CSP violation happened", but "the chart still
  // looks like a chart").
  const firstBarWidth = await page.locator(".word-study-bar-fill").first().evaluate((el) => el.style.width);
  expect(firstBarWidth).toMatch(/^\d+%$/);

  const cspViolations = await getCspViolations(page);
  expect(cspViolations, describeCspViolations(cspViolations)).toEqual([]);
});

test("a cross-references request renders the real diagram (with edge stroke-width/opacity correctly applied via the CSSOM) and a working click-to-ask verse button", async ({ page }) => {
  await collectCspViolations(page);
  await page.goto("/");
  await page.locator("#chat-input").fill("What are the cross-references for John 3:16?");
  await page.locator("#chat-form button[type=submit]").click();

  await expect(page.locator(".cross-ref-diagram").first()).toBeVisible({ timeout: 45_000 });
  const firstItem = page.locator(".cross-ref-list-item").first();
  await expect(firstItem).toBeVisible();
  const reference = await firstItem.getAttribute("data-reference");
  expect(reference).toBeTruthy();

  await firstItem.click();
  await expect(page.locator("#chat-input")).toHaveValue(reference);

  // Same CSSOM-vs-style-attribute concern as the word-study bars above,
  // for the SVG edges' stroke-width/opacity (public/app.js's
  // renderCrossReferenceSvg + applyComputedStyles).
  const firstEdge = page.locator(".cross-ref-edge").first();
  const edgeStyle = await firstEdge.evaluate((el) => ({ strokeWidth: el.style.strokeWidth, opacity: el.style.opacity }));
  expect(edgeStyle.strokeWidth).not.toBe("");
  expect(edgeStyle.opacity).not.toBe("");

  const cspViolations = await getCspViolations(page);
  expect(cspViolations, describeCspViolations(cspViolations)).toEqual([]);
});
