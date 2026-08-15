// Sends the daily digest email -- today's featured passage (see
// lib/daily-passage.js) -- to every signed-in user who's opted in (see
// profiles.daily_digest_opt_in / lib/supabase.js's setDigestOptIn). This is
// a scheduled job's worth of logic, not a request handler: it's meant to be
// invoked once a day by scripts/send-daily-digest.js, itself triggered by a
// Render Cron Job (see render.yaml) or any other scheduler -- nothing in
// this module or its caller is wired into server.js's request handling.
//
// Talks to Resend's HTTP API directly with plain fetch, same "no SDK"
// convention as lib/supabase.js and lib/upstash.js -- see lib/supabase.js's
// header comment for why. This is a *separate* Resend API key from the one
// already living inside Supabase's SMTP settings (used for magic-link
// emails): Supabase never hands that key back out to the app, so sending
// mail from here needs its own, set as RESEND_API_KEY. Both keys can be the
// same underlying Resend account/key value if you want -- Resend doesn't
// care how many things use one key -- they're just two separate places it
// has to be configured.

import { fetchWithTimeout } from "./fetch-timeout.js";
import { getDailyPassage } from "./daily-passage.js";
import { listDigestOptedInUsers } from "./supabase.js";

const RESEND_TIMEOUT_MS = 10000;

// adfontes.site is this app's own real domain (already verified with Resend
// for the magic-link SMTP setup) -- a reasonable default so a digest can be
// sent without also having to set a redundant env var just to point back at
// the app itself. Override with PUBLIC_SITE_URL if that ever changes.
const DEFAULT_SITE_URL = "https://adfontes.site";

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The homepage already shows "today's featured passage" on load
// (getDailyPassage() is deterministic per UTC calendar day -- see
// lib/daily-passage.js), so the email can just link to the site root rather
// than needing any deep-linking machinery of its own. Whoever clicks it on
// the same UTC day sees the exact passage the email named.
function digestEmailHtml({ label, tag, siteUrl }) {
  const safeLabel = escapeHtml(label);
  const safeTag = tag ? escapeHtml(tag) : null;
  return `<div style="font-family:Georgia,serif;color:#2a2a2a;">
    <h2 style="margin-bottom:0;">Today's passage: ${safeLabel}</h2>
    ${safeTag ? `<p style="color:#555;">${safeTag}</p>` : ""}
    <p><a href="${siteUrl}" style="color:#8a5a3b;">Open it in ad fontes</a></p>
    <p style="color:#999;font-size:0.85em;">You're getting this because you turned on the daily passage email. Turn it off anytime from the account menu at ${siteUrl}.</p>
  </div>`;
}

async function sendOneEmail({ apiKey, from, to, subject, html }) {
  const response = await fetchWithTimeout(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, html }),
    },
    RESEND_TIMEOUT_MS,
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend returned ${response.status} ${response.statusText}: ${body}`);
  }
}

/**
 * Sends today's daily-passage digest to every opted-in user, one at a time.
 * Returns { total, sent, failed, usfm, label } rather than throwing on an
 * individual recipient's failure -- one bad address or a transient Resend
 * error shouldn't stop everyone else's email, same "don't let one failure
 * take down the whole run" reasoning as lib/rate-limit.js and friends. Does
 * throw for something that would affect every send (missing config, or
 * listDigestOptedInUsers() itself erroring) since there's nothing useful to
 * do in that case except surface the error to the caller/cron log.
 */
export async function sendDailyDigest({ apiKey, from, siteUrl = DEFAULT_SITE_URL, date } = {}) {
  if (!apiKey) throw new Error("RESEND_API_KEY is required to send the daily digest.");
  if (!from) throw new Error("DIGEST_FROM_EMAIL is required to send the daily digest.");

  const { usfm, label, tag } = getDailyPassage(date);
  const users = await listDigestOptedInUsers();

  let sent = 0;
  let failed = 0;
  for (const user of users) {
    if (!user.email) {
      failed++;
      continue;
    }
    try {
      await sendOneEmail({
        apiKey,
        from,
        to: user.email,
        subject: `Today's passage: ${label}`,
        html: digestEmailHtml({ label, tag, siteUrl }),
      });
      sent++;
    } catch (error) {
      failed++;
      console.error(`Failed to send daily digest to ${user.email}:`, error.message);
    }
  }

  return { total: users.length, sent, failed, usfm, label };
}
