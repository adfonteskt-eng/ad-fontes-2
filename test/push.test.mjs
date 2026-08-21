// lib/push.js: Web Push sending, on top of a stubbed Supabase (the same
// "stub the real REST contract, not the module's internals" approach as
// test/supabase.test.mjs) and a stubbed `web-push` sendNotification (which
// talks to a real push service over node:https, not fetch — see this
// module's own header comment — so it gets its own mock rather than reusing
// the fetch stub the rest of this suite uses for Supabase).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import webpush from "web-push";
import {
  isPushConfigured,
  sendPushToSubscription,
  sendDailyPassagePush,
  sendReadingPlanReminderPush,
} from "../lib/push.js";

const URL_ROOT = "https://fake-project.supabase.co";
const SECRET_KEY = "sb_secret_fake";

let realFetch;
let realSendNotification;

beforeEach(() => {
  realFetch = globalThis.fetch;
  realSendNotification = webpush.sendNotification;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  webpush.sendNotification = realSendNotification;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
});

function configureVapid() {
  // Shape matters to web-push's own setVapidDetails validation (it decodes
  // these as real base64url EC keys), so these are a genuine
  // generateVAPIDKeys() output, not just plausible-looking strings — not
  // secret, since nothing here ever actually sends over the real network.
  process.env.VAPID_PUBLIC_KEY = "BEl62iUYgUivxIkv69yViEuiBIa40HI0DLLuxazjBwGXlDLPGVn3EqBmZ1KKQKgHnKcnhKKvGXVvzYUqQTJhcO4";
  process.env.VAPID_PRIVATE_KEY = "hjLd_r8UlH9nrDh4WVwKF-Nc7YoNsi1KfF6XSTHm8QY";
  process.env.VAPID_SUBJECT = "mailto:test@example.com";
}

function configureSupabase() {
  process.env.SUPABASE_URL = URL_ROOT;
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_fake";
  process.env.SUPABASE_SECRET_KEY = SECRET_KEY;
}

// A fake profiles table + push_subscriptions table + reading_plan_progress
// table, backed by real arrays/Maps so requests reflect state written by
// earlier calls within a test — same spirit as supabase.test.mjs's
// stubSupabase(), just scoped to what lib/push.js's queries actually touch.
function stubSupabase() {
  configureSupabase();
  const profiles = new Map(); // id -> { id, email, is_paid, reading_plan_reminders_opt_in }
  const pushSubscriptions = []; // { id, user_id, endpoint, p256dh, auth }
  let nextSubId = 1;
  const readingPlanProgress = new Map(); // `${user_id}:${plan_id}` -> { completed_days }

  globalThis.fetch = async (requestUrl, opts = {}) => {
    const url = new URL(requestUrl);
    const headers = opts.headers ?? {};

    if (url.pathname === "/rest/v1/profiles") {
      assert.equal(headers.apikey, SECRET_KEY);
      const params = url.searchParams;
      let results = [...profiles.values()];
      if (params.get("reading_plan_reminders_opt_in") === "eq.true") {
        results = results.filter((p) => p.reading_plan_reminders_opt_in === true);
      }
      if (params.get("is_paid") === "eq.true") {
        results = results.filter((p) => p.is_paid === true);
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(results) };
    }

    if (url.pathname === "/rest/v1/push_subscriptions") {
      assert.equal(headers.apikey, SECRET_KEY);
      const params = url.searchParams;

      if (opts.method === "DELETE") {
        const userFilter = params.get("user_id");
        // URLSearchParams.get() already percent-decodes -- deletePushSubscription
        // (lib/supabase.js) encodeURIComponent()s the endpoint when building the
        // query string precisely so a URL containing its own special characters
        // survives as one filter value, but by the time it's parsed back out
        // here it's the plain endpoint string again, same as user_id above.
        const endpointFilter = params.get("endpoint");
        const toDelete = pushSubscriptions.filter(
          (s) => `eq.${s.user_id}` === userFilter && `eq.${s.endpoint}` === endpointFilter,
        );
        for (const row of toDelete) pushSubscriptions.splice(pushSubscriptions.indexOf(row), 1);
        return { ok: true, status: 200, text: async () => JSON.stringify(toDelete) };
      }

      // GET
      let results = pushSubscriptions;
      const userFilter = params.get("user_id");
      if (userFilter) results = results.filter((s) => `eq.${s.user_id}` === userFilter);
      return { ok: true, status: 200, text: async () => JSON.stringify(results) };
    }

    if (url.pathname === "/rest/v1/reading_plan_progress") {
      assert.equal(headers.apikey, SECRET_KEY);
      const params = url.searchParams;
      const userFilter = params.get("user_id");
      const results = [...readingPlanProgress.values()].filter((r) => `eq.${r.user_id}` === userFilter);
      return { ok: true, status: 200, text: async () => JSON.stringify(results) };
    }

    throw new Error(`Unexpected request in push.test.mjs stub: ${opts.method ?? "GET"} ${url.pathname}`);
  };

  return {
    addProfile(row) {
      profiles.set(row.id, { is_paid: true, reading_plan_reminders_opt_in: false, ...row });
    },
    addSubscription(row) {
      const full = { id: nextSubId++, ...row };
      pushSubscriptions.push(full);
      return full;
    },
    setProgress(userId, planId, completedDays) {
      readingPlanProgress.set(`${userId}:${planId}`, { user_id: userId, plan_id: planId, completed_days: completedDays });
    },
    pushSubscriptions,
  };
}

test("isPushConfigured is false until all three VAPID env vars are set", () => {
  assert.equal(isPushConfigured(), false);
  configureVapid();
  assert.equal(isPushConfigured(), true);
});

test("sendPushToSubscription returns { ok: true } on a successful send", async () => {
  configureVapid();
  webpush.sendNotification = async () => ({ statusCode: 201 });
  const result = await sendPushToSubscription(
    { endpoint: "https://push.example.com/abc", p256dh: "key", auth: "secret" },
    { title: "Hi" },
  );
  assert.deepEqual(result, { ok: true });
});

test("sendPushToSubscription reports gone:true for a 410 (subscription expired)", async () => {
  configureVapid();
  const error = new Error("Gone");
  error.statusCode = 410;
  webpush.sendNotification = async () => {
    throw error;
  };
  const result = await sendPushToSubscription({ endpoint: "e", p256dh: "k", auth: "a" }, { title: "Hi" });
  assert.equal(result.ok, false);
  assert.equal(result.gone, true);
});

test("sendPushToSubscription reports gone:false for a non-410/404 failure (a real error, not a dead subscription)", async () => {
  configureVapid();
  const error = new Error("Server error");
  error.statusCode = 500;
  webpush.sendNotification = async () => {
    throw error;
  };
  const result = await sendPushToSubscription({ endpoint: "e", p256dh: "k", auth: "a" }, { title: "Hi" });
  assert.equal(result.ok, false);
  assert.equal(result.gone, false);
});

test("sendDailyPassagePush throws when VAPID isn't configured", async () => {
  stubSupabase();
  await assert.rejects(() => sendDailyPassagePush(), /VAPID_PUBLIC_KEY/);
});

test("sendDailyPassagePush sends to every subscription across every user", async () => {
  configureVapid();
  const stub = stubSupabase();
  stub.addProfile({ id: "user-1", email: "a@example.com" });
  stub.addProfile({ id: "user-2", email: "b@example.com" });
  stub.addSubscription({ user_id: "user-1", endpoint: "https://push.example.com/1", p256dh: "k1", auth: "a1" });
  stub.addSubscription({ user_id: "user-2", endpoint: "https://push.example.com/2", p256dh: "k2", auth: "a2" });

  const sentTo = [];
  webpush.sendNotification = async (subscription) => {
    sentTo.push(subscription.endpoint);
    return { statusCode: 201 };
  };

  const result = await sendDailyPassagePush({ siteUrl: "https://adfontes.site" });
  assert.equal(result.total, 2);
  assert.equal(result.sent, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(sentTo.sort(), ["https://push.example.com/1", "https://push.example.com/2"]);
});

test("sendDailyPassagePush deletes a subscription that comes back gone (410)", async () => {
  configureVapid();
  const stub = stubSupabase();
  stub.addProfile({ id: "user-1", email: "a@example.com" });
  stub.addSubscription({ user_id: "user-1", endpoint: "https://push.example.com/dead", p256dh: "k", auth: "a" });

  const error = new Error("Gone");
  error.statusCode = 410;
  webpush.sendNotification = async () => {
    throw error;
  };

  const result = await sendDailyPassagePush();
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);

  // deletePushSubscription is fire-and-forget (see lib/push.js) — give its
  // promise a tick to actually run before checking it took effect.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stub.pushSubscriptions.length, 0, "the gone subscription should have been cleaned up");
});

test("sendReadingPlanReminderPush skips a user who hasn't opted in", async () => {
  configureVapid();
  const stub = stubSupabase();
  stub.addProfile({ id: "user-1", reading_plan_reminders_opt_in: false });
  stub.addSubscription({ user_id: "user-1", endpoint: "e", p256dh: "k", auth: "a" });
  stub.setProgress("user-1", "gospel-in-six-verses", [1, 2]);

  webpush.sendNotification = async () => ({ statusCode: 201 });

  const result = await sendReadingPlanReminderPush();
  assert.equal(result.candidates, 0);
  assert.equal(result.sent, 0);
});

test("sendReadingPlanReminderPush skips an opted-in user whose only started plan is already finished", async () => {
  configureVapid();
  const stub = stubSupabase();
  stub.addProfile({ id: "user-1", reading_plan_reminders_opt_in: true });
  stub.addSubscription({ user_id: "user-1", endpoint: "e", p256dh: "k", auth: "a" });
  // gospel-in-six-verses has 6 days — mark all 6 done.
  stub.setProgress("user-1", "gospel-in-six-verses", [1, 2, 3, 4, 5, 6]);

  webpush.sendNotification = async () => ({ statusCode: 201 });

  const result = await sendReadingPlanReminderPush();
  assert.equal(result.candidates, 0);
  assert.equal(result.sent, 0);
});

test("sendReadingPlanReminderPush skips an opted-in, unfinished-plan user with no push subscriptions", async () => {
  configureVapid();
  const stub = stubSupabase();
  stub.addProfile({ id: "user-1", reading_plan_reminders_opt_in: true });
  stub.setProgress("user-1", "gospel-in-six-verses", [1]);
  // No subscription added for user-1.

  webpush.sendNotification = async () => ({ statusCode: 201 });

  const result = await sendReadingPlanReminderPush();
  assert.equal(result.candidates, 0);
  assert.equal(result.sent, 0);
});

test("sendReadingPlanReminderPush sends to an opted-in user with an unfinished plan and a subscription", async () => {
  configureVapid();
  const stub = stubSupabase();
  stub.addProfile({ id: "user-1", reading_plan_reminders_opt_in: true });
  stub.addSubscription({ user_id: "user-1", endpoint: "https://push.example.com/1", p256dh: "k", auth: "a" });
  stub.setProgress("user-1", "gospel-in-six-verses", [1, 2]);

  let sentPayload = null;
  webpush.sendNotification = async (_subscription, payload) => {
    sentPayload = JSON.parse(payload);
    return { statusCode: 201 };
  };

  const result = await sendReadingPlanReminderPush({ siteUrl: "https://adfontes.site" });
  assert.equal(result.candidates, 1);
  assert.equal(result.sent, 1);
  assert.match(sentPayload.title, /Gospel in Six Verses/);
  assert.match(sentPayload.body, /2\/6/);
  assert.equal(sentPayload.url, "https://adfontes.site/plans");
});
