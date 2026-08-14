// Optional accounts, via Supabase. This file is entirely self-contained
// and fails silently at every step: if Supabase isn't configured on the
// server (GET /api/config returns nulls — the default until SUPABASE_URL
// etc. are set), or the CDN script didn't load, the sign-in widget just
// never appears and app.js's chat flow is completely unaffected. Accounts
// are additive everywhere, never required.
//
// Exposes window.adFontesAuth.getAccessToken() for app.js to attach to
// /api/chat requests — defined synchronously, before any of the async
// setup below, so it's always safe to call even if everything past this
// point fails.

window.adFontesAuth = {
  getAccessToken: async () => null,
};

const authWidget = document.getElementById("auth-widget");
const signinForm = document.getElementById("auth-signin-form");
const emailInput = document.getElementById("auth-email");
const signinSentNote = document.getElementById("auth-signin-sent");
const signedInPanel = document.getElementById("auth-signed-in");
const userEmailLabel = document.getElementById("auth-user-email");
const signoutButton = document.getElementById("auth-signout");

function showSignedOut() {
  signinForm.hidden = false;
  signinSentNote.hidden = true;
  signedInPanel.hidden = true;
}

function showSignedIn(email) {
  signinForm.hidden = true;
  signinSentNote.hidden = true;
  signedInPanel.hidden = false;
  userEmailLabel.textContent = email ?? "";
}

async function initAuth() {
  let config;
  try {
    const response = await fetch("/api/config");
    config = await response.json();
  } catch {
    return; // server unreachable or malformed response — leave the widget hidden
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

  const {
    data: { session: initialSession },
  } = await client.auth.getSession();
  if (initialSession) {
    showSignedIn(initialSession.user?.email);
  } else {
    showSignedOut();
  }
  authWidget.hidden = false;

  // Fires on sign-in (including a magic link completing, which lands here
  // as the browser processes the token in the URL on page load), sign-out,
  // and token refresh — keeps the widget in sync without polling.
  client.auth.onAuthStateChange((_event, session) => {
    if (session) {
      showSignedIn(session.user?.email);
    } else {
      showSignedOut();
    }
  });

  signinForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = emailInput.value.trim();
    if (!email) return;

    const submitButton = signinForm.querySelector("button");
    submitButton.disabled = true;
    try {
      const { error } = await client.auth.signInWithOtp({ email });
      if (error) {
        console.error("Failed to send magic link:", error.message);
        alert(`Couldn't send a sign-in link: ${error.message}`);
        return;
      }
      signinForm.hidden = true;
      signinSentNote.hidden = false;
    } finally {
      submitButton.disabled = false;
    }
  });

  signoutButton.addEventListener("click", async () => {
    await client.auth.signOut();
    showSignedOut();
  });
}

initAuth();
