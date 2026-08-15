// lib/daily-digest.js: sends today's featured passage to every opted-in
// user via Resend's HTTP API, using listDigestOptedInUsers() (lib/
// supabase.js) to find recipients. Tested against a stub fetch covering
// both real network calls this module makes -- Supabase's PostgREST
// (profiles) and Resend's /emails endpoint -- rather than mocking either
// module's internals, same "match the real request shape" reasoning as
// test/supabase.test.mjs.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { sendDailyDigest } from "../lib/daily-digest.js";

const SUPABASE_URL = "https://fake-project.supabase.co";
const RESEND_API_KEY = "re_fake_key";
const FROM = "ad fontes <digest@adfontes.site>";

let realFetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
  process.env.SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_fake";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_fake";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  delete process.env.SUPABASE_SECRET_KEY;
});

// A fixed date -> a fixed, known daily passage, so assertions on subject
// lines/body content aren't tied to whatever day the test happens to run.
const FIXED_DATE = new Date("2026-01-01T00:00:00Z"); // day-of-year 1 -> DAILY_PASSAGES[1] -> Genesis 1:27

function stubFetch({ users = [], resendFails = new Set() } = {}) {
  const resendRequests = [];
  globalThis.fetch = async (requestUrl, opts = {}) => {
    const url = new URL(requestUrl);

    if (url.pathname === "/rest/v1/profiles") {
      return { ok: true, status: 200, text: async () => JSON.stringify(users) };
    }

    if (url.href === "https://api.resend.com/emails") {
      resendRequests.push(opts);
      const body = JSON.parse(opts.body);
      if (resendFails.has(body.to)) {
        return { ok: false, status: 422, statusText: "Unprocessable Entity", text: async () => '{"message":"invalid recipient"}' };
      }
      return { ok: true, status: 200, text: async () => '{"id":"fake-email-id"}' };
    }

    return { ok: false, status: 404, statusText: "Not Found", text: async () => "unknown path" };
  };
  return { resendRequests };
}

test("sendDailyDigest throws without an apiKey", async () => {
  stubFetch({ users: [{ id: "u1", email: "a@example.com" }] });
  await assert.rejects(() => sendDailyDigest({ from: FROM }), /RESEND_API_KEY/);
});

test("sendDailyDigest throws without a from address", async () => {
  stubFetch({ users: [{ id: "u1", email: "a@example.com" }] });
  await assert.rejects(() => sendDailyDigest({ apiKey: RESEND_API_KEY }), /DIGEST_FROM_EMAIL/);
});

test("sendDailyDigest sends nothing and reports zero when there are no opted-in users", async () => {
  stubFetch({ users: [] });
  const result = await sendDailyDigest({ apiKey: RESEND_API_KEY, from: FROM, date: FIXED_DATE });
  assert.deepEqual(result, { total: 0, sent: 0, failed: 0, usfm: "GEN.1.27", label: "Genesis 1:27" });
});

test("sendDailyDigest sends one email per opted-in user with the day's passage", async () => {
  const { resendRequests } = stubFetch({
    users: [
      { id: "u1", email: "one@example.com" },
      { id: "u2", email: "two@example.com" },
    ],
  });

  const result = await sendDailyDigest({ apiKey: RESEND_API_KEY, from: FROM, date: FIXED_DATE });

  assert.equal(result.total, 2);
  assert.equal(result.sent, 2);
  assert.equal(result.failed, 0);
  assert.equal(resendRequests.length, 2);

  const first = JSON.parse(resendRequests[0].body);
  assert.equal(first.from, FROM);
  assert.equal(first.to, "one@example.com");
  assert.match(first.subject, /Genesis 1:27/);
  assert.match(first.html, /Genesis 1:27/);
  assert.equal(resendRequests[0].headers.authorization, `Bearer ${RESEND_API_KEY}`);
});

test("sendDailyDigest counts a user with no email as failed, without calling Resend for them", async () => {
  const { resendRequests } = stubFetch({
    users: [
      { id: "u1", email: null },
      { id: "u2", email: "two@example.com" },
    ],
  });

  const result = await sendDailyDigest({ apiKey: RESEND_API_KEY, from: FROM, date: FIXED_DATE });

  assert.equal(result.total, 2);
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 1);
  assert.equal(resendRequests.length, 1, "should not have called Resend for the emailless user");
});

test("sendDailyDigest continues past one recipient's Resend failure and still sends the rest", async () => {
  const { resendRequests } = stubFetch({
    users: [
      { id: "u1", email: "bad@example.com" },
      { id: "u2", email: "good@example.com" },
    ],
    resendFails: new Set(["bad@example.com"]),
  });

  const result = await sendDailyDigest({ apiKey: RESEND_API_KEY, from: FROM, date: FIXED_DATE });

  assert.equal(result.total, 2);
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 1);
  assert.equal(resendRequests.length, 2, "should have attempted both, not stopped after the first failure");
});

test("sendDailyDigest defaults the email link to https://adfontes.site", async () => {
  const { resendRequests } = stubFetch({ users: [{ id: "u1", email: "one@example.com" }] });
  await sendDailyDigest({ apiKey: RESEND_API_KEY, from: FROM, date: FIXED_DATE });
  const body = JSON.parse(resendRequests[0].body);
  assert.match(body.html, /https:\/\/adfontes\.site/);
});

test("sendDailyDigest uses a custom siteUrl when given one", async () => {
  const { resendRequests } = stubFetch({ users: [{ id: "u1", email: "one@example.com" }] });
  await sendDailyDigest({ apiKey: RESEND_API_KEY, from: FROM, date: FIXED_DATE, siteUrl: "http://localhost:3000" });
  const body = JSON.parse(resendRequests[0].body);
  assert.match(body.html, /http:\/\/localhost:3000/);
});
