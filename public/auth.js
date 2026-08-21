// Optional accounts, via Supabase, plus the top-left site menu they live
// in (sign up/in, sign out, password reset — and, once signed in, the
// "previous conversations" list, the daily-digest toggle, and the paid-only
// "name your agent" field). This file is entirely self-contained and fails
// silently at every step: if Supabase isn't configured on the server (GET
// /api/config returns nulls — the default until SUPABASE_URL etc. are set),
// or the CDN script didn't load, the menu button just never appears and
// app.js's chat flow is completely unaffected. Accounts are additive
// everywhere, never required.
//
// Sign-in is email + password (not a magic link) — Supabase's "Confirm
// email" project setting stays ON (see README -> Accounts & study memory),
// so a brand-new signUp() never returns an active session; the account only
// becomes usable once the confirmation link is clicked. That confirmation
// link, and a "forgot password" reset link, both land back on this same
// page and are told apart by Supabase's own auth event
// (PASSWORD_RECOVERY for a reset link) or by a `type=recovery` URL param
// (checked up front too, so the recovery form appears immediately rather
// than flashing signed-out first) — see isPasswordRecoveryLink() and
// showRecovery() below. A confirmation link, by contrast, just completes
// signUp() and fires a normal SIGNED_IN event, no special handling needed.
//
// Exposes window.adFontesAuth.getAccessToken() for app.js to attach to
// /api/chat requests — defined synchronously, before any of the async
// setup below, so it's always safe to call even if everything past this
// point fails.

window.adFontesAuth = {
  getAccessToken: async () => null,
  // Set for real by loadPreferences() once signed in -- see that function
  // and showSignedOut() below. Defaults to false so a not-yet-loaded or
  // signed-out state never shows a paid-only control by omission.
  isPaid: false,
};

const menuButton = document.getElementById("site-menu-button");
const menuPanel = document.getElementById("site-menu-panel");
const signedOutSection = document.getElementById("menu-signed-out");
const signedInSection = document.getElementById("menu-signed-in");
const menuRecoverySection = document.getElementById("menu-recovery");
const userEmailLabel = document.getElementById("auth-user-email");
const signoutButton = document.getElementById("auth-signout");
const digestToggle = document.getElementById("auth-digest-optin");
const pushToggle = document.getElementById("auth-push-optin");
const pushUnsupportedNote = document.getElementById("auth-push-unsupported");
const readingPlanRemindersRow = document.getElementById("auth-reading-plan-reminders-row");
const readingPlanRemindersToggle = document.getElementById("auth-reading-plan-reminders-optin");

// Signed-out: the initial choice, and the three forms it can reveal.
const authChoiceButtons = document.getElementById("auth-choice-buttons");
const showSignupButton = document.getElementById("auth-show-signup");
const showSigninButton = document.getElementById("auth-show-signin");
const signupForm = document.getElementById("auth-signup-form");
const signupEmailInput = document.getElementById("auth-signup-email");
const signupPasswordInput = document.getElementById("auth-signup-password");
const signupSentNote = document.getElementById("auth-signup-sent");
const signinForm = document.getElementById("auth-signin-form");
const signinEmailInput = document.getElementById("auth-signin-email");
const signinPasswordInput = document.getElementById("auth-signin-password");
const showForgotButton = document.getElementById("auth-show-forgot");
const forgotForm = document.getElementById("auth-forgot-form");
const forgotEmailInput = document.getElementById("auth-forgot-email");
const forgotSentNote = document.getElementById("auth-forgot-sent");
const authErrorNote = document.getElementById("auth-error");
const authBackButtons = document.querySelectorAll("[data-auth-back]");

// Password recovery (a third state alongside signed-out/signed-in — see
// the file header comment).
const recoveryForm = document.getElementById("auth-recovery-form");
const recoveryPasswordInput = document.getElementById("auth-recovery-password");
const recoveryErrorNote = document.getElementById("auth-recovery-error");

// Paid-only "name your agent" field, plus the upsell shown to free accounts
// instead — see README -> Subscription / paid tier.
const agentNameField = document.getElementById("agent-name-field");
const agentNameInput = document.getElementById("auth-agent-name");
const agentNameSaveButton = document.getElementById("auth-agent-name-save");
const agentNameUpsell = document.getElementById("agent-name-upsell");

const menuHomeButton = document.getElementById("menu-home-button");
const menuTodayButton = document.getElementById("menu-today-button");
const menuPlansButton = document.getElementById("menu-plans-button");
const menuOutlinesButton = document.getElementById("menu-outlines-button");
const menuSubscriptionButton = document.getElementById("menu-subscription-button");
const menuNewChatButton = document.getElementById("menu-new-chat-button");
const menuConversationsHeader = document.getElementById("menu-conversations-header");
const conversationsList = document.getElementById("conversations-list");
const sortRecentButton = document.getElementById("conversations-sort-recent");
const sortBookButton = document.getElementById("conversations-sort-book");

const callout = document.getElementById("site-callout");
const calloutDismissButton = document.getElementById("site-callout-dismiss");
const CALLOUT_DISMISSED_KEY = "adfontes.callout.dismissed";

// --- Menu open/close ------------------------------------------------------

function openMenu() {
  menuPanel.hidden = false;
  menuButton.setAttribute("aria-expanded", "true");
}

function closeMenu() {
  menuPanel.hidden = true;
  menuButton.setAttribute("aria-expanded", "false");
}

menuButton.addEventListener("click", () => {
  if (menuPanel.hidden) openMenu();
  else closeMenu();
});

// Clicking anywhere outside the menu closes it; Escape does too. Clicks
// inside the panel itself (including on a conversation item, which also
// closes the menu explicitly after loading — see below) don't reach this
// listener's "outside" branch since it checks containment.
document.addEventListener("click", (event) => {
  if (menuPanel.hidden) return;
  if (menuButton.contains(event.target) || menuPanel.contains(event.target)) return;
  closeMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !menuPanel.hidden) closeMenu();
});

// "Home" and "New chat" (shown instead of the conversations list when it's
// empty — see renderConversations()) both start a fresh conversation and go
// home, same as the in-page Home button/logo click — see app.js's
// startNewConversation(). "Today's Passage," "Reading Plans," and
// "Subscription" just navigate to their own page without touching whatever
// conversation is in progress — see app.js's view system. All of these are
// defined here (rather than purely in app.js) because the menu is what
// needs to close itself afterward.
function goHomeFromMenu() {
  window.adFontesChat?.startNewConversation();
  closeMenu();
}

menuHomeButton.addEventListener("click", goHomeFromMenu);
menuNewChatButton.addEventListener("click", goHomeFromMenu);

menuTodayButton.addEventListener("click", () => {
  window.adFontesChat?.goToToday();
  closeMenu();
});

menuPlansButton.addEventListener("click", () => {
  window.adFontesChat?.goToPlans();
  closeMenu();
});

menuOutlinesButton.addEventListener("click", () => {
  window.adFontesChat?.goToOutlines();
  closeMenu();
});

menuSubscriptionButton.addEventListener("click", () => {
  window.adFontesChat?.goToSubscription();
  closeMenu();
});

// --- Sign-up nudge callout --------------------------------------------------

function dismissCallout() {
  callout.hidden = true;
  try {
    localStorage.setItem(CALLOUT_DISMISSED_KEY, "1");
  } catch {
    // Same "not worth failing over" reasoning as app.js's localStorage use.
  }
}

function maybeShowCallout(signedIn) {
  if (!callout) return;
  if (signedIn) {
    callout.hidden = true;
    return;
  }
  try {
    if (localStorage.getItem(CALLOUT_DISMISSED_KEY)) {
      callout.hidden = true;
      return;
    }
  } catch {
    // If localStorage is unavailable, fall through and just show it —
    // worst case it reappears every visit, which isn't harmful.
  }
  callout.hidden = false;
}

if (calloutDismissButton) {
  calloutDismissButton.addEventListener("click", dismissCallout);
}

// --- Signed-out sub-forms (choice / sign up / sign in / forgot) -----------
// Four states sharing #menu-signed-out: the initial choice, and each form
// it can reveal. Only one of these four is visible at a time; "Back"
// (shared across all three forms via the [data-auth-back] selector) and a
// fresh showSignedOut() call both return to the initial choice.

function resetSignedOutForms() {
  authChoiceButtons.hidden = false;
  signupForm.hidden = true;
  signinForm.hidden = true;
  forgotForm.hidden = true;
  signupSentNote.hidden = true;
  forgotSentNote.hidden = true;
  authErrorNote.hidden = true;
  signupForm.reset();
  signinForm.reset();
  forgotForm.reset();
}

function showAuthError(message) {
  authErrorNote.textContent = message;
  authErrorNote.hidden = false;
}

showSignupButton.addEventListener("click", () => {
  authErrorNote.hidden = true;
  authChoiceButtons.hidden = true;
  signupForm.hidden = false;
  signupEmailInput.focus();
});

showSigninButton.addEventListener("click", () => {
  authErrorNote.hidden = true;
  authChoiceButtons.hidden = true;
  signinForm.hidden = false;
  signinEmailInput.focus();
});

showForgotButton.addEventListener("click", () => {
  authErrorNote.hidden = true;
  signinForm.hidden = true;
  forgotForm.hidden = false;
  forgotEmailInput.focus();
});

authBackButtons.forEach((button) => button.addEventListener("click", resetSignedOutForms));

// --- Signed-in / signed-out / recovery panel state -------------------------

function showSignedOut() {
  signedOutSection.hidden = false;
  signedInSection.hidden = true;
  menuRecoverySection.hidden = true;
  resetSignedOutForms();
  maybeShowCallout(false);
  // Export buttons (see app.js's Study export section) read this to decide
  // whether to show at all -- signing out should hide them immediately,
  // same as everything else paid-gated, rather than waiting on the next
  // loadPreferences() call that will now never come.
  window.adFontesAuth.isPaid = false;
  window.adFontesChat?.refreshConversationExport?.();
}

function showSignedIn(email) {
  signedOutSection.hidden = true;
  signedInSection.hidden = false;
  menuRecoverySection.hidden = true;
  userEmailLabel.textContent = email ?? "";
  maybeShowCallout(true);
}

// Shown only right after clicking a password-reset email link — see the
// file header comment. Opens the menu itself (the user just arrived via an
// email link, not by clicking the hamburger) so the form is immediately
// visible rather than needing to be found.
function showRecovery() {
  signedOutSection.hidden = true;
  signedInSection.hidden = true;
  menuRecoverySection.hidden = false;
  recoveryErrorNote.hidden = true;
  menuButton.hidden = false;
  openMenu();
}

// A reset-password link's URL carries `type=recovery`, either in the query
// string or the hash fragment depending on flow — checked directly (rather
// than waiting on Supabase's PASSWORD_RECOVERY auth event alone) so the
// recovery form appears immediately instead of flashing "signed out" first
// while that event is still in flight.
function isPasswordRecoveryLink() {
  const hashParams = new URLSearchParams((window.location.hash || "").replace(/^#/, ""));
  if (hashParams.get("type") === "recovery") return true;
  const searchParams = new URLSearchParams(window.location.search);
  return searchParams.get("type") === "recovery";
}

// --- Previous conversations -------------------------------------------------

let conversationsSort = "recent"; // "recent" | "book"

function formatRelativeDate(isoString) {
  const then = new Date(isoString);
  if (Number.isNaN(then.getTime())) return "";
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderConversations(conversations) {
  conversationsList.innerHTML = "";

  // Nothing to show yet (signed out entirely, or signed in with no
  // conversations logged) -- "New chat" takes the list's place instead of
  // an empty header/sort-toggle with nothing under it.
  const hasConversations = conversations.length > 0;
  menuConversationsHeader.hidden = !hasConversations;
  menuNewChatButton.hidden = hasConversations;

  for (const conversation of conversations) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "conversation-item";

    const title = document.createElement("span");
    title.className = "conversation-title";
    title.textContent = conversation.title || "(untitled conversation)";

    const meta = document.createElement("span");
    meta.className = "conversation-meta";
    meta.textContent = [conversation.primaryBook, formatRelativeDate(conversation.updatedAt)]
      .filter(Boolean)
      .join(" · ");

    button.append(title, meta);
    button.addEventListener("click", () => loadConversation(conversation.id));
    item.appendChild(button);
    conversationsList.appendChild(item);
  }
}

async function loadConversations() {
  const token = await window.adFontesAuth.getAccessToken();
  if (!token) return;

  try {
    const response = await fetch(`/api/conversations?sort=${conversationsSort}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return; // e.g. a token that expired between page load and this call
    const { conversations } = await response.json();
    renderConversations(conversations ?? []);
  } catch {
    // A network hiccup here shouldn't be disruptive — the list just stays
    // whatever it was (likely empty), same "fail silently" spirit as the
    // rest of this file.
  }
}

async function loadConversation(id) {
  const token = await window.adFontesAuth.getAccessToken();
  if (!token) return;

  try {
    const response = await fetch(`/api/conversations/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return;
    const conversation = await response.json();
    window.adFontesChat?.loadConversation(conversation);
    closeMenu();
  } catch {
    // Leave the menu open and the chat log untouched — better than a
    // half-loaded conversation.
  }
}

// --- Preferences: daily digest, paid status, agent name ---------------------
// One GET /api/preferences backs all three -- see server.js. isPaid is
// read-only from here (set by hand in Supabase for now -- see README ->
// Subscription / paid tier, there's no real checkout yet), so it only ever
// toggles which of agent-name-field / agent-name-upsell is shown; only
// dailyDigestOptIn and agentName are ever PUT back.

// Guards against the digest-toggle change listener firing (and PUTting)
// while loadPreferences() itself sets digestToggle.checked from the
// server's answer -- otherwise loading the current "off" preference would
// look indistinguishable from the user unchecking it, and re-save the same
// value right back (harmless, but a needless request every page load).
let settingDigestToggleFromServer = false;
// Same reasoning, for the reading-plan-reminders checkbox (see the Push
// notifications section further down).
let settingReadingPlanRemindersToggleFromServer = false;

// The reading-plan-reminders row only makes sense once push is actually on
// for this device AND the account is paid (reading plans are Pro) -- called
// from loadPreferences() (isPaid just became known) and from the push
// toggle's own change handler (push just turned on/off), since either one
// changing can flip whether this row should show.
function updateReadingPlanRemindersVisibility() {
  if (!readingPlanRemindersRow) return;
  readingPlanRemindersRow.hidden = !(pushToggle?.checked && window.adFontesAuth.isPaid);
}

async function loadPreferences() {
  const token = await window.adFontesAuth.getAccessToken();
  if (!token) return;

  try {
    const response = await fetch("/api/preferences", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return;
    const { dailyDigestOptIn, isPaid, agentName, readingPlanRemindersOptIn } = await response.json();

    // Exposed the same way getAccessToken() is -- app.js's Study export
    // section (notes can be exported by any signed-in user only once paid,
    // unlike outlines/reading plans which are hidden entirely behind their
    // own locked view already) reads this synchronously to decide whether to
    // show an Export control at all, rather than relying solely on the
    // server's 403 as the only signal.
    window.adFontesAuth.isPaid = Boolean(isPaid);
    window.adFontesChat?.refreshConversationExport?.();

    if (digestToggle) {
      settingDigestToggleFromServer = true;
      digestToggle.checked = Boolean(dailyDigestOptIn);
      settingDigestToggleFromServer = false;
    }

    if (readingPlanRemindersToggle) {
      settingReadingPlanRemindersToggleFromServer = true;
      readingPlanRemindersToggle.checked = Boolean(readingPlanRemindersOptIn);
      settingReadingPlanRemindersToggleFromServer = false;
    }
    updateReadingPlanRemindersVisibility();

    if (agentNameField && agentNameUpsell) {
      agentNameField.hidden = !isPaid;
      agentNameUpsell.hidden = Boolean(isPaid);
      if (isPaid && agentNameInput) agentNameInput.value = agentName ?? "";
    }
  } catch {
    // Leave everything at whatever it last showed -- same "fail silently,
    // don't disrupt the rest of the menu" spirit as loadConversations().
  }
}

if (digestToggle) {
  digestToggle.addEventListener("change", async () => {
    if (settingDigestToggleFromServer) return;
    const token = await window.adFontesAuth.getAccessToken();
    if (!token) return;

    const desired = digestToggle.checked;
    try {
      const response = await fetch("/api/preferences", {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ dailyDigestOptIn: desired }),
      });
      if (!response.ok) {
        // Couldn't save -- put the checkbox back to reflect reality rather
        // than showing a state the server never actually stored.
        digestToggle.checked = !desired;
      }
    } catch {
      digestToggle.checked = !desired;
    }
  });
}

if (readingPlanRemindersToggle) {
  readingPlanRemindersToggle.addEventListener("change", async () => {
    if (settingReadingPlanRemindersToggleFromServer) return;
    const token = await window.adFontesAuth.getAccessToken();
    if (!token) return;

    const desired = readingPlanRemindersToggle.checked;
    try {
      const response = await fetch("/api/preferences", {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ readingPlanRemindersOptIn: desired }),
      });
      if (!response.ok) readingPlanRemindersToggle.checked = !desired;
    } catch {
      readingPlanRemindersToggle.checked = !desired;
    }
  });
}

if (agentNameSaveButton) {
  agentNameSaveButton.addEventListener("click", async () => {
    const token = await window.adFontesAuth.getAccessToken();
    if (!token) return;

    const desired = agentNameInput.value.trim();
    agentNameSaveButton.disabled = true;
    try {
      const response = await fetch("/api/preferences", {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ agentName: desired }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        alert(data.error ?? "Could not save that name.");
      }
    } catch (error) {
      alert(`Network error: ${error.message}`);
    } finally {
      agentNameSaveButton.disabled = false;
    }
  });
}

function setConversationsSort(sort) {
  conversationsSort = sort;
  sortRecentButton.setAttribute("aria-pressed", String(sort === "recent"));
  sortBookButton.setAttribute("aria-pressed", String(sort === "book"));
  loadConversations();
}

sortRecentButton.addEventListener("click", () => setConversationsSort("recent"));
sortBookButton.addEventListener("click", () => setConversationsSort("book"));

// --- Push notifications (see README -> PWA & push notifications) -----------
// Free for any signed-in account, one subscription per device/browser --
// public/sw.js is the piece that actually receives a push and shows the
// notification; this is just the subscribe/unsubscribe UI and the
// GET/POST/DELETE calls that keep server.js's push_subscriptions table in
// sync with what the browser's PushManager actually has. Wired from inside
// initAuth() (below), once config.vapidPublicKey and getAccessToken are
// both known, rather than at module load like the digest toggle -- unlike
// dailyDigestOptIn, subscribing needs the VAPID public key from GET
// /api/config, and there's a real "browser doesn't support this at all"
// case (pushUnsupportedNote) that has nothing to do with sign-in.

// A PushManager subscribe() call needs the VAPID public key as a raw
// Uint8Array, not the base64url string GET /api/config hands back --
// this is the standard conversion (see MDN's Web Push guide), not anything
// specific to this app.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

// Guards the push toggle the same way settingDigestToggleFromServer guards
// the digest one -- set while refreshPushToggleState() below reflects the
// browser's actual subscription state into the checkbox, so that doesn't
// itself trigger a subscribe/unsubscribe round trip.
let settingPushToggleFromServer = false;

async function setupPush(config) {
  if (!pushToggle) return;

  if (!config.vapidPublicKey) {
    // Push isn't configured on the server at all (no VAPID_* env vars --
    // see lib/push.js) -- hide the feature entirely rather than showing a
    // toggle that could never actually do anything.
    pushToggle.closest("label")?.setAttribute("hidden", "");
    return;
  }

  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    pushToggle.closest("label")?.setAttribute("hidden", "");
    if (pushUnsupportedNote) pushUnsupportedNote.hidden = false;
    return;
  }

  let registration;
  try {
    registration = await navigator.serviceWorker.register("/sw.js");
  } catch (error) {
    console.warn("Service worker registration failed; push notifications are unavailable this session.", error.message);
    pushToggle.closest("label")?.setAttribute("hidden", "");
    return;
  }

  async function subscribe() {
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
    });
    const token = await window.adFontesAuth.getAccessToken();
    if (!token) return false;
    const response = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });
    return response.ok;
  }

  async function unsubscribe() {
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    const token = await window.adFontesAuth.getAccessToken();
    if (!token) return;
    await fetch(`/api/push/subscribe?endpoint=${encodeURIComponent(endpoint)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => {
      // The subscription is already gone from the browser's own PushManager
      // either way (unsubscribe() above already succeeded) -- a failure to
      // also clean up the server-side row just means lib/push.js finds out
      // the same way it would for any other dead subscription: the next
      // send to it comes back 404/410 and gets deleted then (see
      // lib/push.js's sendPushToSubscription).
    });
  }

  // Reflects the browser's real subscription state into the checkbox --
  // called on load (below) and whenever sign-in state changes, since
  // "signed in on this device" and "subscribed to push" are independent
  // facts that can each change without the other (e.g. signing out doesn't
  // itself unsubscribe this device).
  async function refreshPushToggleState() {
    try {
      const subscription = await registration.pushManager.getSubscription();
      settingPushToggleFromServer = true;
      pushToggle.checked = Boolean(subscription);
      settingPushToggleFromServer = false;
    } catch {
      // Leave the checkbox as-is -- same "fail silently" spirit as
      // loadPreferences().
    }
    updateReadingPlanRemindersVisibility();
  }

  pushToggle.addEventListener("change", async () => {
    if (settingPushToggleFromServer) return;
    const desired = pushToggle.checked;
    pushToggle.disabled = true;
    try {
      if (desired) {
        if (Notification.permission === "denied") {
          alert("Notifications are blocked for this site in your browser's settings.");
          pushToggle.checked = false;
        } else {
          const permission = await Notification.requestPermission();
          pushToggle.checked = permission === "granted" && (await subscribe());
        }
      } else {
        await unsubscribe();
      }
    } catch (error) {
      console.error("Push subscribe/unsubscribe failed:", error.message);
      pushToggle.checked = !desired;
    } finally {
      pushToggle.disabled = false;
      updateReadingPlanRemindersVisibility();
    }
  });

  await refreshPushToggleState();
}

// --- Setup ------------------------------------------------------------------

async function initAuth() {
  let config;
  try {
    const response = await fetch("/api/config");
    config = await response.json();
  } catch {
    return; // server unreachable or malformed response — leave the menu hidden
  }

  if (!config.supabaseUrl || !config.supabasePublishableKey) return; // not configured — nothing to do
  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    // The CDN script failed to load (offline, blocked, CDN outage) — this
    // should never silently make chat itself unusable, so just skip the
    // sign-in feature rather than throwing.
    console.warn("Supabase client script did not load; sign-in is unavailable this session.");
    return;
  }

  const client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey);

  window.adFontesAuth.getAccessToken = async () => {
    const {
      data: { session },
    } = await client.auth.getSession();
    return session?.access_token ?? null;
  };

  setupPush(config); // not awaited -- registering the service worker and reading the browser's current subscription shouldn't hold up the rest of sign-in setup below

  // True from the moment a recovery link is detected (either the upfront
  // URL check below, or Supabase's own PASSWORD_RECOVERY event) until the
  // recovery form's submit handler explicitly clears it -- see the file
  // header comment. While true, the normal signed-in/signed-out handling
  // below is skipped so it can't clobber the recovery form back to
  // "signed out" mid-flow.
  let inRecoveryFlow = isPasswordRecoveryLink();
  if (inRecoveryFlow) showRecovery();

  client.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      inRecoveryFlow = true;
      showRecovery();
      return;
    }
    if (inRecoveryFlow) return;
    if (session) {
      showSignedIn(session.user?.email);
      loadConversations();
      loadPreferences();
    } else {
      showSignedOut();
    }
    window.adFontesReadingPlans?.refresh();
    window.adFontesOutlines?.refresh();
  });

  const {
    data: { session: initialSession },
  } = await client.auth.getSession();
  if (!inRecoveryFlow) {
    if (initialSession) {
      showSignedIn(initialSession.user?.email);
      loadConversations();
      loadPreferences();
    } else {
      showSignedOut();
    }
  }
  // Reading plans' progress and the outlines library both depend on who's
  // signed in (or isn't), unlike conversations/preferences which have
  // nothing to show at all when signed out -- so both refresh regardless of
  // the branch above. window.adFontesReadingPlans/adFontesOutlines are both
  // defined unconditionally by app.js (even before this file's async setup
  // finishes), same "always safe to call" contract as window.adFontesAuth.
  window.adFontesReadingPlans?.refresh();
  window.adFontesOutlines?.refresh();
  menuButton.hidden = false;

  signupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = signupEmailInput.value.trim();
    const password = signupPasswordInput.value;
    if (!email || !password) return;

    authErrorNote.hidden = true;
    const submitButton = signupForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    try {
      // emailRedirectTo pins the confirmation link to wherever this page is
      // actually running (works the same on localhost and the deployed
      // site) instead of falling back to the Supabase project's dashboard-
      // configured Site URL. The target still has to be on the project's
      // allow list — Authentication -> URL Configuration in the Supabase
      // dashboard — see README -> Accounts & study memory.
      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) {
        showAuthError(error.message);
        return;
      }
      // Confirm-email is required on this project, so a brand-new signUp()
      // never returns an active session -- data.session is null and a
      // confirmation email is on its way. (If that project setting were
      // ever turned off, data.session would already be set here, and
      // onAuthStateChange's SIGNED_IN handler above takes it from there
      // instead.)
      if (data.session) return;
      signupForm.hidden = true;
      signupSentNote.hidden = false;
    } catch (error) {
      showAuthError(error.message ?? "Something went wrong.");
    } finally {
      submitButton.disabled = false;
    }
  });

  signinForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = signinEmailInput.value.trim();
    const password = signinPasswordInput.value;
    if (!email || !password) return;

    authErrorNote.hidden = true;
    const submitButton = signinForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    try {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) {
        showAuthError(error.message);
        return;
      }
      // onAuthStateChange's SIGNED_IN handler above takes it from here.
    } catch (error) {
      showAuthError(error.message ?? "Something went wrong.");
    } finally {
      submitButton.disabled = false;
    }
  });

  forgotForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = forgotEmailInput.value.trim();
    if (!email) return;

    authErrorNote.hidden = true;
    const submitButton = forgotForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    try {
      const { error } = await client.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin,
      });
      if (error) {
        showAuthError(error.message);
        return;
      }
      forgotForm.hidden = true;
      forgotSentNote.hidden = false;
    } catch (error) {
      showAuthError(error.message ?? "Something went wrong.");
    } finally {
      submitButton.disabled = false;
    }
  });

  recoveryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = recoveryPasswordInput.value;
    if (!password) return;

    recoveryErrorNote.hidden = true;
    const submitButton = recoveryForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    try {
      const { error } = await client.auth.updateUser({ password });
      if (error) {
        recoveryErrorNote.textContent = error.message;
        recoveryErrorNote.hidden = false;
        return;
      }
      recoveryForm.reset();
      inRecoveryFlow = false;
      // Drop the recovery params from the URL so a refresh afterward
      // doesn't re-trigger recovery mode.
      history.replaceState(null, "", window.location.pathname);
      // A real session already exists at this point -- a recovery link
      // signs the user in temporarily so updateUser() has something to act
      // on. Once the new password is set, treat this exactly like any
      // other sign-in.
      const {
        data: { session },
      } = await client.auth.getSession();
      if (session) {
        showSignedIn(session.user?.email);
        loadConversations();
        loadPreferences();
        window.adFontesReadingPlans?.refresh();
        window.adFontesOutlines?.refresh();
      } else {
        showSignedOut();
      }
    } catch (error) {
      recoveryErrorNote.textContent = error.message ?? "Something went wrong.";
      recoveryErrorNote.hidden = false;
    } finally {
      submitButton.disabled = false;
    }
  });

  signoutButton.addEventListener("click", async () => {
    await client.auth.signOut();
    showSignedOut();
    window.adFontesChat?.startNewConversation();
  });
}

initAuth();
