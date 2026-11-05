// Token usage and estimated AI cost per chat turn.
//
// Every Claude response carries a `usage` block (input, output, cache
// reads, cache writes). chatTurn() adds them up across a turn's tool loop,
// and recordUsage() writes one JSON log line per turn (visible in Render's
// Logs tab) plus, when Upstash is configured, running daily totals at
// adfontes:usage:<YYYY-MM-DD> so `npm run usage` can report real cost per
// answer. Never blocks or fails a chat turn.
import { isRedisConfigured, redisCommand } from "./upstash.js";

// USD per million tokens. Defaults are Claude Sonnet-class list prices;
// override with env vars if the model or pricing changes. Cache writes use
// the 1-hour TTL rate (2x input) because lib/chat.js caches for 1h.
export function pricing() {
  const n = (name, fallback) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= 0 && process.env[name] !== "" && process.env[name] !== undefined ? v : fallback;
  };
  return {
    input: n("PRICE_INPUT_PER_MTOK", 3),
    output: n("PRICE_OUTPUT_PER_MTOK", 15),
    cacheRead: n("PRICE_CACHE_READ_PER_MTOK", 0.3),
    cacheWrite: n("PRICE_CACHE_WRITE_PER_MTOK", 6),
  };
}

export function emptyUsage() {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** Adds one API response's `usage` block into a running total (mutates and returns it). */
export function addUsage(total, usage) {
  if (!usage) return total;
  total.calls += 1;
  total.input += usage.input_tokens ?? 0;
  total.output += usage.output_tokens ?? 0;
  total.cacheRead += usage.cache_read_input_tokens ?? 0;
  total.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  return total;
}

export function estimateCostUsd(total, prices = pricing()) {
  const cost =
    (total.input * prices.input +
      total.output * prices.output +
      total.cacheRead * prices.cacheRead +
      total.cacheWrite * prices.cacheWrite) /
    1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

const DAY_TTL_SECONDS = 120 * 24 * 3600;

export function usageKey(date = new Date()) {
  return `adfontes:usage:${date.toISOString().slice(0, 10)}`;
}

/**
 * Logs one turn's usage and adds it to today's totals. Fire-and-forget:
 * returns a promise that never rejects.
 */
export async function recordUsage(total, { model, isPaid = false, signedIn = false } = {}) {
  const costUsd = estimateCostUsd(total);
  console.log(
    JSON.stringify({ event: "chat_usage", model, signedIn, isPaid, ...total, costUsd }),
  );
  if (!isRedisConfigured()) return;
  try {
    const key = usageKey();
    const tier = isPaid ? "paid" : signedIn ? "free" : "anon";
    const fields = {
      turns: 1,
      calls: total.calls,
      input: total.input,
      output: total.output,
      cache_read: total.cacheRead,
      cache_write: total.cacheWrite,
      cost_microusd: Math.round(costUsd * 1_000_000),
      [`turns_${tier}`]: 1,
      [`cost_microusd_${tier}`]: Math.round(costUsd * 1_000_000),
    };
    for (const [field, value] of Object.entries(fields)) {
      if (value) await redisCommand(["HINCRBY", key, field, String(value)]);
    }
    await redisCommand(["EXPIRE", key, String(DAY_TTL_SECONDS)]);
  } catch (error) {
    console.error("Failed to record usage:", error.message);
  }
}
