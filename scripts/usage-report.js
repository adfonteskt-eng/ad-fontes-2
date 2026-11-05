// Prints daily AI usage and estimated cost from Upstash (written by
// lib/usage.js). Usage: npm run usage [days]   (default 14)
try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // no .env; rely on the real environment
}
import { isRedisConfigured, redisCommand } from "../lib/upstash.js";
import { usageKey } from "../lib/usage.js";

const days = Number(process.argv[2]) || 14;
if (!isRedisConfigured()) {
  console.error("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set (put them in .env).");
  process.exit(1);
}

const rows = [];
for (let i = days - 1; i >= 0; i--) {
  const date = new Date(Date.now() - i * 86400_000);
  const flat = (await redisCommand(["HGETALL", usageKey(date)])) ?? [];
  const h = {};
  for (let j = 0; j < flat.length; j += 2) h[flat[j]] = Number(flat[j + 1]);
  if (!h.turns) continue;
  const cost = (h.cost_microusd ?? 0) / 1e6;
  rows.push({
    date: date.toISOString().slice(0, 10),
    answers: h.turns,
    "avg in+cache": Math.round(((h.input ?? 0) + (h.cache_read ?? 0) + (h.cache_write ?? 0)) / h.turns),
    "avg out": Math.round((h.output ?? 0) / h.turns),
    "cost $": cost.toFixed(2),
    "$/answer": (cost / h.turns).toFixed(4),
    "paid/free/anon": `${h.turns_paid ?? 0}/${h.turns_free ?? 0}/${h.turns_anon ?? 0}`,
  });
}
if (rows.length === 0) console.log(`No usage recorded in the last ${days} days.`);
else console.table(rows);
