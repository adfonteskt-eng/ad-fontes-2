// Phase 3 QA (see docs/DECISIONS.md's 2026-09-21 pacing entry): the one
// devDependency in this project reserved for QA only, added at the point
// the QA phase actually started, never shipped to production (Render's
// build only ever runs `npm install --omit=dev` implicitly via
// NODE_ENV=production, and nothing in server.js or lib/ imports this).
//
// `channel: "chrome"` launches the real, already-installed Google Chrome
// on this machine rather than Playwright's own bundled Chromium — this
// project's QA instructions were explicit: browsers are available, don't
// trigger a download. Installed with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
// for exactly that reason; see qa/CHECKLIST.md for how that was verified.
//
// `webServer` starts the real server.js (which loads the real .env itself
// via its own process.loadEnvFile() call, same as running `npm run web`
// by hand) before the suite runs and tears it down after — an explicit,
// declarative start/stop rather than a manually backgrounded process this
// session has been told to avoid.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./qa/tests",
  fullyParallel: false, // shares one real server + real Anthropic/YouVersion rate limits
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "qa/playwright-report", open: "never" }]],
  use: {
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
  webServer: {
    command: "node server.js",
    url: "http://localhost:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { PORT: "3100" },
  },
});
