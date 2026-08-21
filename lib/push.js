// Web Push notifications -- a free-tier feature (see README -> PWA & push
// notifications), the push-channel equivalent of lib/daily-digest.js's email
// digest, plus a second, opt-in-only reading-plan-reminder push. Meant to be
// invoked once a day by scripts/send-daily-push.js, itself triggered by a
// Render Cron Job (see render.yaml) -- nothing here is wired into server.js's
// request handling, same "scheduled job, not a request handler" shape as
// lib/daily-digest.js.
//
// Uses the `web-push` package (one of this project's three real npm
// dependencies -- see the README's intro, and lib/export.js's header comment
// for the same reasoning applied to PDF/Word export) rather than hand-rolling
// the Web Push protocol's VAPID request signing and payload encryption --
// that's real, security-adjacent cryptography (an ECDH key exchange plus
// AES-128-GCM encryption per RFC 8291), not a "just a REST call" integration
// like everything else in lib/, so this is a deliberate exception to the
// "plain fetch, no SDK" convention rather than an accidental one.

import webpush from "web-push";

import { getDailyPassage } from "./daily-passage.js";
import { READING_PLANS } from "./reading-plans.js";
import {
  deletePushSubscription,
  listAllPushSubscriptions,
  listPushSubscriptionsForUser,
  listReadingPlanReminderOptedInUsers,
  listReadingPlanProgress,
} from "./supabase.js";

function isPushConfigured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
}

// Configuring web-push is a cheap, synchronous, idempotent call -- done
// lazily on first actual send rather than at module load, so importing this
// file (e.g. server.js, for GET /api/config's vapidPublicKey field) never
// requires push to be configured at all, same "additive, not required"
// pattern as Supabase/Upstash/Resend throughout this app.
let configured = false;
function ensureConfigured() {
  if (configured) return;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  configured = true;
}

// adfontes.site is this app's own real domain -- same default/override
// reasoning as lib/daily-digest.js's DEFAULT_SITE_URL.
const DEFAULT_SITE_URL = "https://adfontes.site";

/**
 * Sends one push notification to one subscription. Returns { ok: true } on
 * success, or { ok: false, gone: boolean, error } on failure -- `gone` is
 * true for a 404/410 response, the Web Push protocol's own signal that this
 * subscription is permanently dead (the browser unsubscribed, uninstalled,
 * or the endpoint otherwise expired) and should be deleted rather than
 * retried, same "the server told us, believe it" reasoning a bounced-email
 * webhook would get if this app had one. Never throws -- like
 * sendDailyDigest's per-recipient try/catch, one bad or expired
 * subscription shouldn't stop every other send.
 */
export async function sendPushToSubscription(subscription, payload) {
  ensureConfigured();
  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload),
    );
    return { ok: true };
  } catch (error) {
    const gone = error.statusCode === 404 || error.statusCode === 410;
    return { ok: false, gone, error };
  }
}

// Shared by both send*Push() functions below: sends `payload` to every
// subscription in `subscriptions`, deleting any that come back gone, and
// tallying the result the same { total, sent, failed } shape
// sendDailyDigest() returns.
async function sendToSubscriptions(subscriptions, payload) {
  let sent = 0;
  let failed = 0;
  for (const subscription of subscriptions) {
    const result = await sendPushToSubscription(subscription, payload);
    if (result.ok) {
      sent++;
      continue;
    }
    failed++;
    if (result.gone) {
      deletePushSubscription(subscription.user_id ?? subscription.userId, subscription.endpoint).catch((error) => {
        console.error(`Failed to clean up gone push subscription ${subscription.id}:`, error.message);
      });
    } else {
      console.error(`Failed to send push to subscription ${subscription.id}:`, result.error?.message ?? result.error);
    }
  }
  return { total: subscriptions.length, sent, failed };
}

/**
 * Sends today's featured-passage push to every push subscription across
 * every user -- the push-channel equivalent of sendDailyDigest(), and this
 * app's one non-opt-in push type (having a push_subscriptions row at all,
 * from turning notifications on in the account menu, IS the opt-in -- see
 * supabase/schema.sql's push_subscriptions comment). Throws if push itself
 * isn't configured, same "surface a real config problem to the cron log"
 * reasoning as sendDailyDigest's own required-config checks.
 */
export async function sendDailyPassagePush({ siteUrl = DEFAULT_SITE_URL, date } = {}) {
  if (!isPushConfigured()) {
    throw new Error("VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT are required to send push notifications.");
  }

  const { label, tag } = getDailyPassage(date);
  const subscriptions = await listAllPushSubscriptions();

  const { total, sent, failed } = await sendToSubscriptions(subscriptions, {
    title: `Today's passage: ${label}`,
    body: tag || "Open ad fontes to read it.",
    url: siteUrl,
  });

  return { total, sent, failed, label };
}

// A plan is "unfinished" if it's been started (has a progress row at all)
// but hasn't had every day checked off yet -- mirrors the completion check
// public/app.js's reading-plan UI would do, just server-side here since
// there's no request/response round trip to hand it off to.
function firstUnfinishedPlan(progressByPlan) {
  for (const plan of READING_PLANS) {
    const progress = progressByPlan[plan.id];
    if (!progress) continue; // never started -- nothing to remind about
    if (progress.completedDays.length < plan.days.length) return plan;
  }
  return null;
}

/**
 * Sends a reminder push to every paid user who's opted into reading-plan
 * reminders (profiles.reading_plan_reminders_opt_in) AND has at least one
 * started-but-unfinished plan -- everyone else (not opted in, or opted in
 * but every started plan is already finished) gets nothing, silently, same
 * "no news is fine" reasoning as sendDailyDigest skipping a user with no
 * email on file. Only reminds about the first unfinished plan found (in
 * READING_PLANS's own order) even if more than one is in progress, to keep
 * this to one push per user per day rather than a burst.
 */
export async function sendReadingPlanReminderPush({ siteUrl = DEFAULT_SITE_URL } = {}) {
  if (!isPushConfigured()) {
    throw new Error("VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT are required to send push notifications.");
  }

  const optedInUsers = await listReadingPlanReminderOptedInUsers();

  let candidates = 0;
  let sent = 0;
  let failed = 0;

  for (const user of optedInUsers) {
    const progressByPlan = await listReadingPlanProgress(user.id);
    const plan = firstUnfinishedPlan(progressByPlan);
    if (!plan) continue;

    const subscriptions = await listPushSubscriptionsForUser(user.id);
    if (subscriptions.length === 0) continue; // opted in, but no device ever enabled push

    candidates++;
    const completedCount = progressByPlan[plan.id].completedDays.length;
    const result = await sendToSubscriptions(subscriptions, {
      title: `Continue "${plan.title}"`,
      body: `${completedCount}/${plan.days.length} days done -- pick up where you left off.`,
      url: `${siteUrl}/plans`,
    });
    sent += result.sent;
    failed += result.failed;
  }

  return { candidates, sent, failed };
}

export { isPushConfigured };
