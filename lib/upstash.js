// Shared, tiny Upstash Redis REST client. Two things use this: session
// storage (lib/session-store.js) and per-IP usage caps (lib/rate-limit.js).
// Pulled out on its own once a second caller needed the exact same
// "POST a Redis command array, get back { result } or { error }" logic —
// keeping one copy means a fix (timeout tuning, error handling) only has to
// happen once.

import { fetchWithTimeout } from "./fetch-timeout.js";

const REDIS_TIMEOUT_MS = 8000;

// Read fresh on every call rather than cached at module-load time, so
// tests can flip between the Redis and in-memory paths by setting/
// unsetting these env vars mid-run without needing to re-import the
// module (ES module imports are cached; a top-level `const` read once at
// import time would defeat that).
export function isRedisConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

export async function redisCommand(command) {
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
