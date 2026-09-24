// Shared Playwright QA helpers.

// A CSP violation that silently drops a legitimate inline style/script
// doesn't crash anything visible — the browser just refuses the one
// blocked thing and moves on, which is exactly why this has to be
// checked with a real listener rather than "does the page look okay."
// The `securitypolicyviolation` event is the authoritative signal (fired
// by the browser itself, not scraped from whatever Chrome happens to log
// to the console that build), so this is registered via addInitScript()
// — which runs before any of the page's own scripts, so nothing blocked
// during initial load can be missed — rather than reading console
// messages after the fact.
export async function collectCspViolations(page) {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__cspViolations.push({
        directive: event.violatedDirective,
        blockedURI: event.blockedURI,
        sourceFile: event.sourceFile,
        lineNumber: event.lineNumber,
      });
    });
  });
}

export async function getCspViolations(page) {
  return page.evaluate(() => window.__cspViolations ?? []);
}

export function describeCspViolations(violations) {
  return violations
    .map((v) => `${v.directive} blocked ${v.blockedURI || "(inline)"} at ${v.sourceFile}:${v.lineNumber}`)
    .join("\n");
}
