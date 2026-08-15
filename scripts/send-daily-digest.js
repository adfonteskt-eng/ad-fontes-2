// Entry point for the daily digest cron job -- see render.yaml's
// ad-fontes-daily-digest cron service, or run by hand: `npm run digest`.
// Not part of the web server; a one-shot script that sends today's featured
// passage to every opted-in user (lib/daily-digest.js), logs a summary
// line, and exits.

import { sendDailyDigest } from "../lib/daily-digest.js";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // no .env file — fall through to whatever is already in the environment
  // (the normal case in production: env vars come from the hosting
  // platform, not a checked-in file)
}

const { total, sent, failed, label } = await sendDailyDigest({
  apiKey: process.env.RESEND_API_KEY,
  from: process.env.DIGEST_FROM_EMAIL,
  siteUrl: process.env.PUBLIC_SITE_URL,
});

console.log(`Daily digest (${label}): ${sent}/${total} sent, ${failed} failed.`);

// Every send failing (when there was at least one recipient to send to)
// points at a config problem -- a bad API key, an unverified from address
// -- not isolated bad addresses. A nonzero exit here is what a cron
// scheduler's own failure notifications (Render's included) key off of.
if (total > 0 && sent === 0) {
  process.exit(1);
}
