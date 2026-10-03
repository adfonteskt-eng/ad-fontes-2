// lib/stripe.js — Checkout/Portal session creation (form-encoded Stripe
// REST calls) and webhook-signature verification. Network is stubbed
// throughout; nothing here needs a real Stripe key, and verifyWebhookEvent
// is exercised against hand-computed HMACs, not a real Stripe secret.
//
// This suite existed as a documented gap (see docs/STATE.md's 2026-09-21
// audit: "lib/stripe.js has zero test coverage") going into the launch
// readiness pass -- added then, not because the code itself changed.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  TRIAL_PERIOD_DAYS,
  isStripeConfigured,
  createCheckoutSession,
  createPortalSession,
  verifyWebhookEvent,
} from "../lib/stripe.js";

let realFetch;
let realSecretKey;

before(() => {
  realFetch = globalThis.fetch;
  realSecretKey = process.env.STRIPE_SECRET_KEY;
});

after(() => {
  globalThis.fetch = realFetch;
  if (realSecretKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = realSecretKey;
});

beforeEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
});

// Captures the last outgoing request (method/url/headers/parsed form body)
// so a test can assert on exactly what was sent to Stripe, and resolves
// with `respondWith` (defaulting to a bare `{}` success) -- mirrors the
// stubYouVersion()-style helpers in test/gather.test.mjs.
function stubStripe({ respondWith = {}, ok = true, status = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const body = typeof options.body === "string" ? options.body : "";
    calls.push({
      url: url.toString(),
      method: options.method,
      authorization: options.headers?.Authorization,
      contentType: options.headers?.["content-type"],
      form: new URLSearchParams(body),
    });
    return {
      ok,
      status,
      statusText: ok ? "OK" : "Error",
      json: async () => respondWith,
    };
  };
  return calls;
}

test("isStripeConfigured() reflects whether STRIPE_SECRET_KEY is set", () => {
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal(isStripeConfigured(), false);
  process.env.STRIPE_SECRET_KEY = "sk_test_whatever";
  assert.equal(isStripeConfigured(), true);
});

test("createCheckoutSession() posts the expected fields and reuses an existing Stripe customer when given one", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_abc";
  const calls = stubStripe({ respondWith: { id: "cs_123", url: "https://checkout.stripe.com/cs_123" } });

  const result = await createCheckoutSession({
    userId: "user-1",
    userEmail: "user1@example.com",
    priceId: "price_monthly",
    successUrl: "https://adfontes.site/subscription?checkout=success",
    cancelUrl: "https://adfontes.site/subscription?checkout=cancelled",
    stripeCustomerId: "cus_existing",
  });

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(call.method, "POST");
  assert.equal(call.authorization, "Bearer sk_test_abc");
  assert.equal(call.contentType, "application/x-www-form-urlencoded");
  assert.equal(call.form.get("mode"), "subscription");
  assert.equal(call.form.get("line_items[0][price]"), "price_monthly");
  assert.equal(call.form.get("line_items[0][quantity]"), "1");
  assert.equal(call.form.get("success_url"), "https://adfontes.site/subscription?checkout=success");
  assert.equal(call.form.get("cancel_url"), "https://adfontes.site/subscription?checkout=cancelled");
  assert.equal(call.form.get("client_reference_id"), "user-1");
  assert.equal(call.form.get("customer"), "cus_existing", "an existing customer id should be reused");
  assert.equal(call.form.get("customer_email"), null, "customer and customer_email are mutually exclusive");
  assert.equal(call.form.get("subscription_data[trial_period_days]"), String(TRIAL_PERIOD_DAYS));
  assert.equal(call.form.get("subscription_data[metadata][user_id]"), "user-1");
  assert.deepEqual(result, { id: "cs_123", url: "https://checkout.stripe.com/cs_123" });
});

test("createCheckoutSession() falls back to customer_email when there's no existing Stripe customer", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_abc";
  const calls = stubStripe();

  await createCheckoutSession({
    userId: "user-2",
    userEmail: "user2@example.com",
    priceId: "price_annual",
    successUrl: "https://adfontes.site/subscription?checkout=success",
    cancelUrl: "https://adfontes.site/subscription?checkout=cancelled",
    stripeCustomerId: null,
  });

  const call = calls[0];
  assert.equal(call.form.get("customer_email"), "user2@example.com");
  assert.equal(call.form.get("customer"), null, "no customer id was given, so it shouldn't be sent");
});

test("createPortalSession() posts the customer id and return url, and returns the parsed session", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_abc";
  const calls = stubStripe({ respondWith: { id: "bps_1", url: "https://billing.stripe.com/bps_1" } });

  const result = await createPortalSession({
    stripeCustomerId: "cus_existing",
    returnUrl: "https://adfontes.site/subscription",
  });

  const call = calls[0];
  assert.equal(call.url, "https://api.stripe.com/v1/billing_portal/sessions");
  assert.equal(call.form.get("customer"), "cus_existing");
  assert.equal(call.form.get("return_url"), "https://adfontes.site/subscription");
  assert.deepEqual(result, { id: "bps_1", url: "https://billing.stripe.com/bps_1" });
});

test("a non-ok Stripe response throws with Stripe's own error message", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_abc";
  stubStripe({
    ok: false,
    status: 402,
    respondWith: { error: { message: "Your card was declined." } },
  });

  await assert.rejects(
    () =>
      createCheckoutSession({
        userId: "user-3",
        userEmail: "user3@example.com",
        priceId: "price_monthly",
        successUrl: "https://adfontes.site/subscription?checkout=success",
        cancelUrl: "https://adfontes.site/subscription?checkout=cancelled",
      }),
    /Your card was declined\./,
  );
});

// verifyWebhookEvent() -- hand-rolled per Stripe's documented
// t=<ts>,v1=<hmac-sha256 of "<ts>.<raw body>"> scheme (see lib/stripe.js's
// own doc comment). Builds a real signature with a known secret so these
// tests catch a regression in the parsing/HMAC/timing-safe-compare logic
// itself, not just whatever Stripe happens to send.
const WEBHOOK_SECRET = "whsec_test_secret";

function signPayload(rawBody, { secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

test("verifyWebhookEvent() accepts a correctly signed, fresh payload and returns the parsed event", () => {
  const rawBody = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated" });
  const header = signPayload(rawBody);

  const event = verifyWebhookEvent(rawBody, header, WEBHOOK_SECRET);

  assert.deepEqual(event, { id: "evt_1", type: "customer.subscription.updated" });
});

test("verifyWebhookEvent() rejects a missing Stripe-Signature header", () => {
  assert.throws(() => verifyWebhookEvent("{}", undefined, WEBHOOK_SECRET), /Missing Stripe-Signature/);
  assert.throws(() => verifyWebhookEvent("{}", "", WEBHOOK_SECRET), /Missing Stripe-Signature/);
});

test("verifyWebhookEvent() rejects a malformed header missing t or v1", () => {
  assert.throws(() => verifyWebhookEvent("{}", "v1=abc123", WEBHOOK_SECRET), /Malformed Stripe-Signature/);
  assert.throws(() => verifyWebhookEvent("{}", "t=1700000000", WEBHOOK_SECRET), /Malformed Stripe-Signature/);
});

test("verifyWebhookEvent() rejects a signature that doesn't match the body", () => {
  const rawBody = JSON.stringify({ id: "evt_2" });
  const header = signPayload(rawBody);
  const tamperedBody = JSON.stringify({ id: "evt_2_tampered" });

  assert.throws(() => verifyWebhookEvent(tamperedBody, header, WEBHOOK_SECRET), /signature mismatch/);
});

test("verifyWebhookEvent() rejects a signature of the wrong length without throwing an unrelated crypto error", () => {
  const rawBody = JSON.stringify({ id: "evt_3" });
  const timestamp = Math.floor(Date.now() / 1000);
  const shortHeader = `t=${timestamp},v1=deadbeef`; // valid hex, wrong length vs. a real sha256 hmac

  assert.throws(() => verifyWebhookEvent(rawBody, shortHeader, WEBHOOK_SECRET), /signature mismatch/);
});

test("verifyWebhookEvent() rejects a signature signed with the wrong secret", () => {
  const rawBody = JSON.stringify({ id: "evt_4" });
  const header = signPayload(rawBody, { secret: "whsec_wrong_secret" });

  assert.throws(() => verifyWebhookEvent(rawBody, header, WEBHOOK_SECRET), /signature mismatch/);
});

test("verifyWebhookEvent() rejects a timestamp outside the replay-protection tolerance", () => {
  const rawBody = JSON.stringify({ id: "evt_5" });
  const staleTimestamp = Math.floor(Date.now() / 1000) - 10 * 60; // 10 minutes old, tolerance is 5
  const header = signPayload(rawBody, { timestamp: staleTimestamp });

  assert.throws(() => verifyWebhookEvent(rawBody, header, WEBHOOK_SECRET), /outside tolerance/);
});

test("verifyWebhookEvent() accepts a timestamp just inside the tolerance window", () => {
  const rawBody = JSON.stringify({ id: "evt_6" });
  const freshTimestamp = Math.floor(Date.now() / 1000) - 4 * 60; // 4 minutes old, tolerance is 5
  const header = signPayload(rawBody, { timestamp: freshTimestamp });

  const event = verifyWebhookEvent(rawBody, header, WEBHOOK_SECRET);
  assert.deepEqual(event, { id: "evt_6" });
});
