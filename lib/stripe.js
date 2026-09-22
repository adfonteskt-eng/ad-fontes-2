// Stripe Billing/Checkout integration (see README -> Subscription / paid
// tier). Plain `fetch` against Stripe's REST API, no `stripe` npm SDK --
// consistent with lib/supabase.js and lib/upstash.js (this project's
// deliberate "stay dependency-free unless something is genuinely fiddly to
// get right by hand" rule -- see the README intro's dependencies paragraph).
// Stripe's REST API is plain form-encoded POSTs with a well-documented
// webhook-signature algorithm, not in the same category as magic-link/PKCE
// auth or ZIP decompression, so there's no real case for a fourth
// dependency here.
//
// Flow: server.js's POST /api/billing/checkout creates a Checkout Session
// and redirects the browser to Stripe's hosted payment page (checkout_type:
// hosted, per the Stripe implementation planner -- no Stripe.js/Elements on
// the frontend at all, so no publishable key is needed server- or
// client-side). Stripe then calls back to POST /api/webhooks/stripe on
// subscription events, which is what actually flips profiles.is_paid --
// never the checkout redirect itself, since a customer can abandon or the
// browser can close before landing back on success_url. POST
// /api/billing/portal creates a Customer Portal session so a signed-in paid
// user can self-manage (upgrade/downgrade/cancel/update payment method)
// without any custom UI here -- see README -> Subscription / paid tier.

import { createHmac, timingSafeEqual } from "node:crypto";
import { fetchWithTimeout } from "./fetch-timeout.js";

const STRIPE_TIMEOUT_MS = 8000;
const STRIPE_API_BASE = "https://api.stripe.com/v1";

// 14-day free trial, card on file -- see the Stripe implementation planner's
// Billing Model decision (subs_billing_free_access -> YES -> collect payment
// info at signup -> Free Trial). A plain constant, not an env var: changing
// the trial length is a product decision that should show up in a diff, not
// silently drift via an unreviewed dashboard/env change.
export const TRIAL_PERIOD_DAYS = 14;

export function isStripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

// Stripe's REST API takes application/x-www-form-urlencoded bodies with
// PHP-style bracket notation for nested objects/arrays (e.g.
// `line_items[0][price]=price_x&subscription_data[trial_period_days]=14`) --
// there's no JSON body mode. This flattens a plain JS object/array into that
// shape once, so every call site below can just build a normal nested
// object instead of hand-assembling query strings.
function toFormParams(obj, prefix = "", params = new URLSearchParams()) {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const paramKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item !== null && typeof item === "object") {
          toFormParams(item, `${paramKey}[${index}]`, params);
        } else {
          params.append(`${paramKey}[${index}]`, String(item));
        }
      });
    } else if (typeof value === "object") {
      toFormParams(value, paramKey, params);
    } else {
      params.append(paramKey, String(value));
    }
  }
  return params;
}

async function stripeRequest(path, body) {
  const response = await fetchWithTimeout(
    `${STRIPE_API_BASE}/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: toFormParams(body).toString(),
    },
    STRIPE_TIMEOUT_MS,
  );

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Stripe API error (${path}): ${data?.error?.message ?? response.statusText}`);
  }
  return data;
}

/**
 * Creates a Stripe Checkout Session for a subscription and returns its
 * hosted-page URL to redirect the browser to. `priceId` is one of
 * STRIPE_PRICE_MONTHLY/STRIPE_PRICE_ANNUAL (see .env.example). Passes the
 * signed-in user's id as both `client_reference_id` and
 * `subscription_data.metadata.user_id` -- the webhook handler needs to map a
 * `customer.subscription.*` event back to a profiles row, and a
 * subscription's metadata is the reliable place to find that (unlike the
 * one-time checkout.session.completed event, which isn't fired again on
 * renewal/plan-change).
 */
export async function createCheckoutSession({ userId, userEmail, priceId, successUrl, cancelUrl, stripeCustomerId }) {
  return stripeRequest("checkout/sessions", {
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: userId,
    // Reuse the existing Stripe customer if this user has one (e.g. they
    // cancelled and are resubscribing) so billing history stays on one
    // customer record; otherwise let Checkout create one from their email.
    ...(stripeCustomerId ? { customer: stripeCustomerId } : { customer_email: userEmail }),
    subscription_data: {
      trial_period_days: TRIAL_PERIOD_DAYS,
      metadata: { user_id: userId },
    },
  });
}

/**
 * Creates a Stripe Customer Portal session and returns its URL -- lets a
 * signed-in paid user upgrade/downgrade/cancel/update their payment method
 * on Stripe's own hosted UI, no custom subscription-management code needed
 * here (per the implementation planner's Lifecycle Management decision).
 */
export async function createPortalSession({ stripeCustomerId, returnUrl }) {
  return stripeRequest("billing_portal/sessions", {
    customer: stripeCustomerId,
    return_url: returnUrl,
  });
}

// Stripe tolerates this much clock drift between when it signed the event
// and when this server checks it -- matches Stripe's own documented
// recommendation, guards against a replayed old request being accepted.
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/**
 * Verifies a webhook request's `Stripe-Signature` header against the raw
 * request body (must be the exact bytes Stripe sent -- see server.js, which
 * reads this route's body without JSON-parsing it first, unlike every other
 * POST route) and returns the parsed event, or throws if the signature is
 * missing, malformed, doesn't match, or is too old. Hand-rolled HMAC-SHA256
 * check per Stripe's documented algorithm
 * (https://docs.stripe.com/webhooks#verify-manually) -- straightforward
 * enough not to need the SDK just for this one function.
 */
export function verifyWebhookEvent(rawBody, signatureHeader, webhookSecret) {
  if (!signatureHeader) throw new Error("Missing Stripe-Signature header.");

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((part) => {
      const [key, value] = part.split("=");
      return [key, value];
    }),
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) throw new Error("Malformed Stripe-Signature header.");

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > WEBHOOK_TOLERANCE_SECONDS) {
    throw new Error("Stripe webhook timestamp outside tolerance -- possible replay.");
  }

  const expected = createHmac("sha256", webhookSecret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(signature, "hex");
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new Error("Stripe webhook signature mismatch.");
  }

  return JSON.parse(rawBody);
}
