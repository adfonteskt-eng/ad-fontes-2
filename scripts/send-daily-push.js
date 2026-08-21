// Entry point for the daily push cron job -- see render.yaml's
// ad-fontes-daily-push cron service, or run by hand: `npm run push`. Not
// part of the web server; a one-shot script, same shape as
// scripts/send-daily-digest.js, that sends two kinds of push notification
// (lib/push.js) and exits:
//
//   1. The daily-passage push, to every push subscription across every
//      user -- the free-tier, non-opt-in one (see README -> PWA & push
//      notifications).
//   2. The reading-plan-reminder push, only to paid users who've opted in
//      AND have an unfinished plan.

import { sendDailyPassagePush, sendReadingPlanReminderPush } from "../lib/push.js";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // no .env file — fall through to whatever is already in the environment
  // (the normal case in production: env vars come from the hosting
  // platform, not a checked-in file)
}

const siteUrl = process.env.PUBLIC_SITE_URL || undefined; // undefined lets lib/push.js's own default apply

const daily = await sendDailyPassagePush({ siteUrl });
console.log(`Daily-passage push (${daily.label}): ${daily.sent}/${daily.total} sent, ${daily.failed} failed.`);

const reminders = await sendReadingPlanReminderPush({ siteUrl });
console.log(`Reading-plan-reminder push: ${reminders.sent}/${reminders.candidates} sent, ${reminders.failed} failed.`);

// Same "every send failing when there was at least one recipient points at
// a config problem, not isolated bad subscriptions" reasoning as
// scripts/send-daily-digest.js -- a nonzero exit here is what a cron
// scheduler's own failure notifications key off of.
if ((daily.total > 0 && daily.sent === 0) || (reminders.candidates > 0 && reminders.sent === 0)) {
  process.exit(1);
}
