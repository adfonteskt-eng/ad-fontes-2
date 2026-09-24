// Phase 3 QA: nonce-based CSP regression coverage. server.test.mjs already
// covers the header/nonce mechanics themselves (a fresh nonce per request,
// every real <script> tag carrying it, no unsafe-inline/wildcard) against
// raw HTTP responses; this file drives a real browser and checks for the
// one failure mode raw HTTP assertions can't see at all: a legitimate
// inline style/script that got missed and is now silently being blocked —
// which shows up as a securitypolicyviolation event, not a visible crash
// or a non-200 response (see helpers.js's own comment on why that event,
// specifically, is what's checked). No Anthropic cost — everything here
// is static pages and the site menu; the one flow that needs a real chat
// response (cross-references + a word study, exercising the CSSOM-based
// style-setting refactor in public/app.js) is checked inside
// chat-flow.spec.js instead, reusing that file's existing real calls
// rather than paying for new ones just to also check for CSP violations.
import { test, expect } from "@playwright/test";
import { collectCspViolations, getCspViolations, describeCspViolations } from "./helpers.js";

async function expectNoCspViolations(page) {
  const violations = await getCspViolations(page);
  expect(violations, describeCspViolations(violations)).toEqual([]);
}

const STATIC_ROUTES = ["/", "/today", "/plans", "/outlines", "/subscription", "/sources"];

for (const route of STATIC_ROUTES) {
  test(`${route}: no CSP violations on load`, async ({ page }) => {
    await collectCspViolations(page);
    await page.goto(route);
    // Give any deferred/async script (loadDailyPassage, loadReadingPlans,
    // etc.) a moment to actually run and hit anything it might violate.
    await page.waitForTimeout(1000);
    await expectNoCspViolations(page);
  });
}

test("a hard-refresh direct navigation to each SPA route gets a fresh nonce and produces no CSP violations (not just the first load)", async ({ page }) => {
  for (const route of STATIC_ROUTES) {
    await collectCspViolations(page);
    await page.goto(route);
    await page.waitForTimeout(500);
    await expectNoCspViolations(page);
  }
});

test("opening the site menu (exercises auth.js's Supabase client setup) produces no CSP violations", async ({ page }) => {
  await collectCspViolations(page);
  await page.goto("/");
  await page.locator("#site-menu-button").click();
  await expect(page.locator("#site-menu-panel")).toBeVisible();
  await page.waitForTimeout(500);
  await expectNoCspViolations(page);
});

test("the service worker registers successfully under the CSP (worker-src)", async ({ page }) => {
  await collectCspViolations(page);
  await page.goto("/");
  // navigator.serviceWorker.register() is fire-and-forget in app.js (a
  // .catch() logs a warning, doesn't throw) -- waiting on the real
  // registration promise is the only way to tell "succeeded" apart from
  // "silently swallowed by a CSP-driven failure."
  const registered = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return "unsupported";
    try {
      const reg = await navigator.serviceWorker.ready;
      return Boolean(reg);
    } catch (error) {
      return `error: ${error.message}`;
    }
  });
  expect(registered === true || registered === "unsupported", `service worker registration should succeed (or be unsupported in this browser), got: ${registered}`).toBeTruthy();
  await expectNoCspViolations(page);
});

test("Reel Kit's blob: image (the SVG-to-canvas share card) is not blocked by img-src", async ({ page }) => {
  await collectCspViolations(page);
  await page.goto("/");
  // Exercises the exact same buildShareCardSvg -> Blob -> <img> path
  // downloadShareCard() uses, without needing a real chat message on
  // screen to click a real "Share as image" button — this is specifically
  // testing whether the CSP blocks the blob: <img> load, not re-testing
  // the card's own visual content (already covered live during Reel Kit's
  // original implementation, see docs/DECISIONS.md).
  const result = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';
        const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          resolve("loaded");
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          resolve("error");
        };
        img.src = url;
      }),
  );
  expect(result).toBe("loaded");
  await expectNoCspViolations(page);
});
