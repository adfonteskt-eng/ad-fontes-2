// Per-IP daily usage caps for the free beta. There's no login yet, so an IP
// address is the only thing available to meter against — not a robust
// identity (shared IPs, VPNs, mobile carriers doing NAT), but good enough to
// stop a single runaway or abusive client from running up the Anthropic
// bill while the app is free and open to anyone with the URL. Revisit once
// there are accounts to meter against instead.
//
// Same Redis/in-memory backend split as lib/session-store.js, and for the
// same reason: a per-process in-memory counter resets every time the server
// restarts, which on a host like Render happens often enough (deploys,
// periodic restarts) that a determined-enough user could just wait it out.
// Redis makes the cap actually hold across restarts.

import { isRedisConfigured, redisCommand } from "./upstash.js";

const KEY_PREFIX = "adfontes:ratelimit:";

// Fixed window, not sliding: the cap resets WINDOW_SECONDS after the FIRST
// request in the window, not "24h ago from now" on every check. Simpler to
// reason about and cheap to implement (one counter + one expiry per key)
// versus a true sliding window, at the cost of a client being able to burst
// right at the reset boundary — an acceptable tradeoff for a soft cost
// guardrail, not a security control.
const WINDOW_SECONDS = 24 * 60 * 60;

// Daily caps, per IP. These exist to bound worst-case Anthropic spend from
// one client during the free, unauthenticated beta — not to police normal
// study sessions. Reading a chapter, asking a handful of follow-ups, and
// checking a few cross-references stays well under either number. Override
// via env if real usage data says these should move; no code change needed.
//
// Back-of-envelope cost ceiling at current Claude Sonnet 5 pricing ($2/$10
// per million input/output tokens): a fresh, cache-miss chat turn — system
// prompt + tool definitions + a couple of gather_passage/search_lexicon
// round-trips — runs roughly $0.02-0.03; a passage summary (no caching,
// see lib/summarize.js) roughly $0.01-0.02. At the defaults below, that's
// a worst case around $1.50-2.50/day for one IP that never benefits from
// prompt caching at all (e.g. a script hitting a fresh session every time)
// — real conversational use, where later turns in the same session are
// mostly cache reads at 0.1x input price, costs meaningfully less than
// this ceiling implies. Worth redoing this math if the model or its
// pricing changes (see CACHE_TTL in lib/chat.js for the same pricing
// figures cited more fully).
export const CHAT_DAILY_LIMIT = Number(process.env.CHAT_DAILY_LIMIT) || 60;
export const SUMMARY_DAILY_LIMIT = Number(process.env.SUMMARY_DAILY_LIMIT) || 40;

// --- Redis backend (Upstash REST API) --------------------------------------
//
// INCR the counter, then EXPIRE it with NX (only set a TTL if the key
// doesn't already have one — supported since Redis 7). Calling EXPIRE NX on
// every single request, not just when INCR returns 1, is deliberate: it
// means even if the process dies between this request's INCR and EXPIRE
// calls, the very next request self-heals by setting the TTL then instead
// of leaving the key stuck at no-expiry (which would lock that IP out
// permanently once it hit the cap). The only cost of that self-healing is a
// window that can run slightly longer than 24h in the rare case it fires
// late — never shorter, and never "stuck forever."
async function redisIncrement(key, windowSeconds = WINDOW_SECONDS) {
  const count = await redisCommand(["INCR", key]);
  await redisCommand(["EXPIRE", key, windowSeconds, "NX"]);
  return count;
}

// --- In-memory backend (local dev / no Upstash configured) -----------------
// Mirrors the same fixed-window semantics: a counter plus a fixed reset
// time, created on the first request seen and left alone (not renewed) on
// every request after that until it expires.
const MEMORY_MAX_ENTRIES = 1000;
const memoryStore = new Map(); // key -> { count, expiresAt }

function pruneMemoryStore() {
  const now = Date.now();
  for (const [key, entry] of memoryStore) {
    if (entry.expiresAt <= now) memoryStore.delete(key);
  }
  while (memoryStore.size > MEMORY_MAX_ENTRIES) {
    const oldestKey = memoryStore.keys().next().value;
    memoryStore.delete(oldestKey);
  }
}

function memoryIncrement(key, windowSeconds = WINDOW_SECONDS) {
  pruneMemoryStore();
  const now = Date.now();
  const entry = memoryStore.get(key);
  if (!entry || entry.expiresAt <= now) {
    memoryStore.set(key, { count: 1, expiresAt: now + windowSeconds * 1000 });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

// --- Public interface --------------------------------------------------

/**
 * Increments and checks the daily counter for `${kind}:${identifier}`
 * (e.g. kind "chat", identifier an IP address) against `limit`.
 *
 * Increments unconditionally, including the request that trips the limit —
 * so retrying a blocked request doesn't cost nothing, which matters for the
 * count to mean anything as a spend guardrail. Returns
 * { allowed, count, limit } rather than throwing, leaving the caller to
 * decide how to respond (this module has no idea what a 429 is).
 */
export async function checkAndIncrement(kind, identifier, limit, { windowSeconds = WINDOW_SECONDS } = {}) {
  const key = `${KEY_PREFIX}${kind}:${identifier}`;
  const count = isRedisConfigured() ? await redisIncrement(key, windowSeconds) : memoryIncrement(key, windowSeconds);
  return { allowed: count <= limit, count, limit };
}

/** Clears the in-memory store. Test-only — Redis has no equivalent here (and shouldn't). */
export function clearMemoryStoreForTests() {
  memoryStore.clear();
}

// --- Free tier: weekly question allowance ------------------------------
//
// Separate from the per-IP daily abuse cap above. Off unless
// FREE_WEEKLY_LIMIT is set (e.g. 10): signed-in free accounts are metered
// per account, anonymous visitors per IP (ANON_WEEKLY_LIMIT, defaulting to
// the same number), and paid accounts aren't metered here at all. Weeks are
// calendar weeks starting Monday 00:00 UTC, so "resets Monday" is true for
// everyone; the key carries the week's start date and expires after it.

export function freeTierLimits(env = process.env) {
  const free = Number(env.FREE_WEEKLY_LIMIT) || 0;
  const anonRaw = env.ANON_WEEKLY_LIMIT;
  const anon = anonRaw === undefined || anonRaw === "" ? free : Number(anonRaw) || 0;
  return { free, anon, enabled: free > 0 || anon > 0 };
}

/** Monday (UTC) of the week containing `now`, as YYYY-MM-DD, plus the next Monday. */
export function weekWindow(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + 7);
  return { start: d.toISOString().slice(0, 10), resetsOn: next.toISOString().slice(0, 10) };
}

/**
 * Counts one question against the weekly free allowance. Returns null when
 * the caller isn't metered (feature off, or a paid account), otherwise
 * { allowed, used, limit, resetsOn }.
 */
export async function checkFreeTier({ userId = null, isPaid = false, ip }, { now = new Date(), env = process.env } = {}) {
  const { free, anon } = freeTierLimits(env);
  if (isPaid) return null;
  const limit = userId ? free : anon;
  if (!limit) return null;
  const { start, resetsOn } = weekWindow(now);
  const identifier = userId ? `user:${userId}` : `ip:${ip}`;
  const { count } = await checkAndIncrement(`free-week:${start}`, identifier, limit, { windowSeconds: 8 * 24 * 60 * 60 });
  return { allowed: count <= limit, used: Math.min(count, limit), limit, resetsOn };
}
