// Optional accounts, via Supabase, plus the top-left site menu they live
// in (sign in/up, sign out, and — once signed in — the "previous
// conversations" list). This file is entirely self-contained and fails
// silently at every step: if Supabase isn't configured on the server (GET
// /api/config returns nulls — the default until SUPABASE_URL etc. are
// set), or the CDN script didn't load, the menu button just never appears
// and app.js's chat flow is completely unaffected. Accounts are additive
// everywhere, never required.
//
// Exposes window.adFontesAuth.getAccessToken() for app.js to attach to
// /api/chat requests — defined synchronously, before any of the async
// setup below, so it's always safe to call even if everything past this
// point fails.

window.adFontesAuth = {
  getAccessToken: async () => null,
};

const menuButton = document.getElementById("site-menu-button");
const menuPanel = document.getElementById("site-menu-panel");
const signedOutSection = document.getElementById("menu-signed-out");
const signedInSection = document.getElementById("menu-signed-in");
const signinForm = document.getElementById("auth-signin-form");
const emailInput = document.getElementById("auth-email");
const signinSentNote = document.getElementById("auth-signin-sent");
const userEmailLabel = document.getElementById("auth-user-email");
const signoutButton = document.getElementById("auth-signout");

const conversationsList = document.getElementById("conversations-list");
const conversationsEmpty = document.getElementById("conversations-empty");
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

// --- Signed-in / signed-out panel state ------------------------------------

function showSignedOut() {
  signedOutSection.hidden = false;
  signedInSection.hidden = true;
  signinForm.hidden = false;
  signinSentNote.hidden = true;
  maybeShowCallout(false);
}

function showSignedIn(email) {
  signedOutSection.hidden = true;
  signedInSection.hidden = false;
  userEmailLabel.textContent = email ?? "";
  maybeShowCallout(true);
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
  conversationsEmpty.hidden = conversations.length > 0;

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

function setConversationsSort(sort) {
  conversationsSort = sort;
  sortRecentButton.setAttribute("aria-pressed", String(sort === "recent"));
  sortBookButton.setAttribute("aria-pressed", String(sort === "book"));
  loadConversations();
}

sortRecentButton.addEventListener("click", () => setConversationsSort("recent"));
sortBookButton.addEventListener("click", () => setConversationsSort("book"));

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

  const {
    data: { session: initialSession },
  } = await client.auth.getSession();
  if (initialSession) {
    showSignedIn(initialSession.user?.email);
    loadConversations();
  } else {
    showSignedOut();
  }
  menuButton.hidden = false;

  // Fires on sign-in (including a magic link completing, which lands here
  // as the browser processes the token in the URL on page load), sign-out,
  // and token refresh — keeps the menu in sync without polling.
  client.auth.onAuthStateChange((_event, session) => {
    if (session) {
      showSignedIn(session.user?.email);
      loadConversations();
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
    window.adFontesChat?.startNewConversation();
  });
}

initAuth();
