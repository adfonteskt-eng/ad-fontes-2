// Pluggable storage for chat session history. Two backends:
//
// - Redis (Upstash REST API), used when UPSTASH_REDIS_REST_URL and
//   UPSTASH_REDIS_REST_TOKEN are both set. This is what actually resolves
//   the session-durability gap flagged early in this project: sessions
//   survive a server restart or redeploy, because they aren't living in
//   this process's memory at all. Chosen over a SQL database because the
//   data shape here — sessionId -> an opaque JSON blob that should expire
//   after a period of inactivity — maps directly onto Redis's native
//   per-key TTL with no schema to design; a relational database is the
//   right tool for the *later* accounts/billing work, not this.
// - An in-memory Map, used otherwise — zero setup for local development,
//   exactly this project's original behavior. Explicitly NOT durable
//   across a restart; that's the whole reason the Redis backend exists.
//
// Both backends expose the same small async interface so lib/chat.js
// doesn't need to know or care which one is active. Uses Upstash's plain
// REST API (a POST with the Redis command as a JSON array body) rather
// than an SDK — it's just fetch, consistent with this project's "no
// dependencies" approach everywhere else.

import { fetchWithTimeout } from "./fetch-timeout.js";

// Read fresh on every call rather than cached at module-load time, so
// tests can flip between the Redis and in-memory paths by setting/
// unsetting these env vars mid-run without needing to re-import the
// module (ES module imports are cached; a top-level `const` read once at
// import time would defeat that).
function isRedisConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

const REDIS_TIMEOUT_MS = 8000;
const KEY_PREFIX = "adfontes:session:";

// Idle expiry: a session with no activity for this long is treated as
// abandoned. Applies to both backends — Redis via native key TTL, the
// in-memory fallback via its own expiresAt check (see below).
export const SESSION_TTL_SECONDS = 2 * 60 * 60; // 2 hours

// --- Redis backend (Upstash REST API) --------------------------------------

async function redisCommand(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    },
    REDIS_TIMEOUT_MS,
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Upstash Redis returned ${response.status} ${response.statusText}\n${body}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(`Upstash Redis error: ${data.error}`);
  }
  return data.result;
}

async function redisGetSession(id) {
  const raw = await redisCommand(["GET", KEY_PREFIX + id]);
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    // A corrupted or unexpected value sitting in Redis (e.g. from a schema
    // change) shouldn't break the turn — treat it as "no session found"
    // and let a fresh one get created, same as an expired/missing key.
    return undefined;
  }
}

async function redisSetSession(id, value) {
  await redisCommand(["SET", KEY_PREFIX + id, JSON.stringify(value), "EX", SESSION_TTL_SECONDS]);
}

async function redisDeleteSession(id) {
  await redisCommand(["DEL", KEY_PREFIX + id]);
}

// --- In-memory backend (local dev / no Upstash configured) -----------------
// Same design this project always had: idle TTL + a hard count cap, using
// Map's insertion order for least-recently-active eviction (delete-then-
// reinsert on every touch moves an entry to the end). Redis needs neither
// of these — native EX handles expiry, and the free tier's own storage
// ceiling is the natural cap — so this bookkeeping only exists here.
const MEMORY_MAX_ENTRIES = 500;
const memoryStore = new Map(); // id -> { value, expiresAt }

function pruneMemoryStore() {
  const now = Date.now();
  for (const [id, entry] of memoryStore) {
    if (entry.expiresAt <= now) memoryStore.delete(id);
  }
  while (memoryStore.size > MEMORY_MAX_ENTRIES) {
    const oldestId = memoryStore.keys().next().value;
    memoryStore.delete(oldestId);
  }
}

function memoryGetSession(id) {
  pruneMemoryStore();
  const entry = memoryStore.get(id);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    memoryStore.delete(id);
    return undefined;
  }
  return entry.value;
}

function memorySetSession(id, value) {
  memoryStore.delete(id);
  memoryStore.set(id, { value, expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000 });
  pruneMemoryStore();
}

function memoryDeleteSession(id) {
  memoryStore.delete(id);
}

// --- Public interface --------------------------------------------------

export async function getSession(id) {
  if (!id) return undefined;
  return isRedisConfigured() ? redisGetSession(id) : memoryGetSession(id);
}

export async function setSession(id, value) {
  return isRedisConfigured() ? redisSetSession(id, value) : memorySetSession(id, value);
}

export async function deleteSession(id) {
  return isRedisConfigured() ? redisDeleteSession(id) : memoryDeleteSession(id);
}

/**
 * Number of sessions currently held — exact for the in-memory backend.
 * Returns null for the Redis backend: getting an exact count there would
 * mean a SCAN over the whole keyspace, which isn't worth the cost just for
 * a diagnostic number. Callers (tests, a future health-check endpoint)
 * should treat null as "not available," not as zero.
 */
export function getSessionCount() {
  return isRedisConfigured() ? null : memoryStore.size;
}

/** True when sessions are durably stored (Redis) vs. in-memory-only. */
export function isDurable() {
  return isRedisConfigured();
}

/** Clears the in-memory store. Test-only — Redis has no equivalent here (and shouldn't). */
export function clearMemoryStoreForTests() {
  memoryStore.clear();
}
