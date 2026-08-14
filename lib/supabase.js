// Server-side Supabase client for accounts + the compounding study memory
// feature. Plain fetch against Supabase's documented REST APIs (Auth REST
// for verifying a user's access token, PostgREST for reading/writing
// study_entries) rather than the @supabase/supabase-js SDK — consistent
// with how lib/upstash.js talks to Redis, and it means this project's
// server-side code stays at zero npm dependencies even with accounts added.
//
// The browser IS expected to use the official @supabase/supabase-js
// library (loaded via CDN in public/, not through npm) for the actual
// sign-in flow — magic-link/PKCE auth is genuinely fiddly to get right by
// hand, and that's exactly the kind of security-sensitive code worth using
// the officially maintained client for. This module only ever receives an
// access token the browser already obtained and verifies it; it never
// initiates a sign-in itself.
//
// Two Supabase API keys are involved, and they are NOT interchangeable —
// see https://supabase.com/docs/guides/getting-started/api-keys:
//   - SUPABASE_PUBLISHABLE_KEY ("Publishable key" in the dashboard, or the
//     legacy "anon" key on older projects) — low-privilege, safe to expose
//     in a browser. Used here as the `apikey` header when verifying a
//     user's own access token.
//   - SUPABASE_SECRET_KEY ("Secret keys" in the dashboard, or the legacy
//     "service_role" key) — elevated privilege, bypasses Row Level
//     Security entirely. Server-only, never sent to the browser. Used for
//     every study_entries read/write, since this server already verified
//     the user itself and scopes every query by their id manually.

import { fetchWithTimeout } from "./fetch-timeout.js";

const SUPABASE_TIMEOUT_MS = 8000;

function isSupabaseConfigured() {
  return Boolean(
    process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY && process.env.SUPABASE_SECRET_KEY,
  );
}

// --- Auth: verifying a user's access token ---------------------------------

/**
 * Verifies a Supabase access token (a JWT the browser attaches to a
 * request, obtained via its own sign-in flow) and returns { id, email } for
 * the user it belongs to, or null if the token is missing, malformed,
 * expired, or otherwise invalid. Never throws for an invalid token — an
 * unauthenticated request to a route that supports (but doesn't require)
 * accounts should just proceed anonymously, not fail the whole request.
 *
 * Does throw if Supabase itself is unreachable/erroring (a real
 * infrastructure problem, not "this particular token is bad") — same
 * "distinguish a bad request from a broken dependency" reasoning as
 * lib/upstash.js's redisCommand().
 */
export async function verifyUser(accessToken) {
  if (!accessToken || !isSupabaseConfigured()) return null;

  const response = await fetchWithTimeout(
    `${process.env.SUPABASE_URL}/auth/v1/user`,
    {
      headers: {
        apikey: process.env.SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
    },
    SUPABASE_TIMEOUT_MS,
  );

  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase Auth returned ${response.status} ${response.statusText}\n${body}`);
  }

  const user = await response.json();
  if (!user?.id) return null;
  return { id: user.id, email: user.email ?? null };
}

// --- Study history (PostgREST) ---------------------------------------------

async function postgrest(path, options = {}) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`;
  const response = await fetchWithTimeout(
    url,
    {
      ...options,
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
        "content-type": "application/json",
        ...options.headers,
      },
    },
    SUPABASE_TIMEOUT_MS,
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase (PostgREST) returned ${response.status} ${response.statusText}\n${body}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Records one study_entries row for a signed-in user. Fire-and-forget from
 * the caller's perspective in spirit (see lib/chat.js) — a logging failure
 * here shouldn't be allowed to break the actual chat reply the user is
 * waiting on, so callers should catch/ignore errors from this rather than
 * let them propagate into the turn's critical path.
 */
export async function logStudyEntry(userId, { reference = null, topic = null, summary }) {
  if (!isSupabaseConfigured()) return;
  await postgrest("study_entries", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify([{ user_id: userId, reference, topic, summary }]),
  });
}

/**
 * Searches a user's own study_entries for ones matching `keyword` (against
 * reference and a plain substring match on topic/summary — not semantic
 * search; see the schema.sql comment on why embeddings are a deliberate
 * v2, not a v1 gap) or returns their most recent entries if no keyword is
 * given. Returns [] (not null/undefined) when Supabase isn't configured or
 * nothing matches, so callers can iterate the result unconditionally.
 */
export async function searchStudyHistory(userId, { keyword, limit = 10 } = {}) {
  if (!isSupabaseConfigured()) return [];

  const params = new URLSearchParams({
    user_id: `eq.${userId}`,
    order: "created_at.desc",
    limit: String(Math.min(limit, 50)),
    select: "reference,topic,summary,created_at",
  });

  if (keyword && keyword.trim()) {
    // PostgREST "or" filter across two columns, each a case-insensitive
    // substring match. Reference matching is exact-ish (a USFM code is
    // short and structured) via ilike too, so "john" still finds "JHN.3.16"
    // entries by matching against topic/summary instead, not reference.
    const escaped = keyword.trim().replace(/[,()]/g, ""); // PostgREST filter syntax uses these as delimiters
    params.set("or", `(topic.ilike.*${escaped}*,summary.ilike.*${escaped}*,reference.ilike.*${escaped}*)`);
  }

  const rows = await postgrest(`study_entries?${params.toString()}`, { method: "GET" });
  return rows ?? [];
}

export { isSupabaseConfigured };
