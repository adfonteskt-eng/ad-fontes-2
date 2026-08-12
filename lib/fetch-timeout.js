// Every external call this project makes (YouVersion, biblehub, Anthropic)
// used plain fetch() with no timeout at all — if any of those three services
// hangs instead of erroring cleanly, the request just sits there forever.
// For gatherPassage() that means Promise.all never resolves; for the chat
// loop it means a user's message just spins with no feedback. A timeout
// turns "hangs forever" into "fails after N seconds," which the existing
// error-handling in gather.js/commentary.js/chat.js already knows how to
// degrade gracefully (per-translation errors, a commentary error field, a
// chat error message) — it just needed something to actually trigger it.
export async function fetchWithTimeout(url, options = {}, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      let host = url;
      try {
        host = new URL(url).host;
      } catch {
        // url wasn't a valid absolute URL — fall back to printing it as-is.
      }
      throw new Error(`Request to ${host} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
