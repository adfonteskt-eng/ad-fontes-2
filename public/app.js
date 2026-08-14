// Frontend for ad-fontes's web API (server.js). No build step, no
// framework. The chat box is the only entry point — type a bare reference
// or a full question, and the server (lib/chat.js) decides what to gather
// via tool use. Each reply can come with source material (translations,
// original-language interlinear, commentary) for whatever passage Claude
// looked up, which gets rendered inline with that turn.
//
// One document, two client-side views (home and conversation — see the
// "Home / conversation views" section below) rather than two separate
// pages — there's nothing here that needs a real server round-trip to
// switch between them.

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

function renderTranslations(translations) {
  if (!translations || translations.length === 0) return "";
  const rows = translations
    .map(({ translation, content, error }) => {
      if (error) {
        return `<div class="translation unavailable">
          <h3>${escapeHtml(translation.abbr)}</h3>
          <p>Unavailable: ${escapeHtml(error)}</p>
        </div>`;
      }
      return `<div class="translation">
        <h3>${escapeHtml(translation.abbr)} — ${escapeHtml(translation.name)}</h3>
        <p>${escapeHtml(content)}</p>
      </div>`;
    })
    .join("");
  return `<h2 class="source-heading">Translations</h2>${rows}`;
}

function renderOriginalLanguage(ol) {
  let heading = "";
  let body;

  if (ol.type === "unsupported") {
    body = `<p class="section-note">No original-language text mapped for this book.</p>`;
  } else if (ol.missingFiles && ol.missingFiles.length > 0) {
    const label = ol.type === "greek" ? "Greek" : "Hebrew";
    body = `<p class="section-note">${label} data not downloaded on the server yet — run <code>npm run fetch-data</code>. Missing: ${escapeHtml(ol.missingFiles.join(", "))}</p>`;
  } else if (ol.error) {
    body = `<p class="section-note">${escapeHtml(ol.error)}</p>`;
  } else if (!ol.words || ol.words.length === 0) {
    body = `<p class="section-note">No original-language text found for this reference.</p>`;
  } else {
    const label = ol.type === "greek" ? "Greek — NA28 critical text" : "Hebrew — Leningrad Codex, Qere-corrected";
    heading = `${label} (${ol.words.length} words)`;

    const rows = ol.words
      .map((w) => {
        const variantClass = w.isCriticalText === false ? "interlinear-variant" : "";
        return `<tr class="${variantClass}">
          <td class="interlinear-surface">${escapeHtml(w.surface)}</td>
          <td>${escapeHtml(w.transliteration)}</td>
          <td class="interlinear-strongs">${escapeHtml(w.strongs)}</td>
          <td>${escapeHtml(w.gloss ?? w.contextGloss ?? "—")}</td>
        </tr>`;
      })
      .join("");

    body = `<p class="section-note">${escapeHtml(heading)}</p>
      <div class="interlinear-wrap">
        <table class="interlinear">
          <thead><tr><th>Word</th><th>Transliteration</th><th>Strong's</th><th>Gloss</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    if (ol.type === "greek" && ol.variantCount > 0) {
      body += `<p class="section-note">${ol.variantCount} variant word${ol.variantCount === 1 ? "" : "s"} in the TR/Byzantine tradition hidden.</p>`;
    }
    if (ol.hebrewVerseRef) {
      body += `<p class="section-note">Note: Hebrew versification differs here — this is Hebrew ${escapeHtml(ol.book)}.${escapeHtml(ol.hebrewVerseRef)}. (Most often a psalm superscription counted as part of the verse numbering in Hebrew but not English, offsetting the rest of the psalm by one.)</p>`;
    }
    if (ol.source) {
      body += `<p class="section-note">${escapeHtml(ol.source)}</p>`;
    }
  }

  return `<h2 class="source-heading">Original language</h2>${body}`;
}

function renderCommentary(commentary) {
  if (commentary.error) {
    return `<h2 class="source-heading">Commentary</h2><p class="section-note">${escapeHtml(commentary.error)}</p>`;
  }
  if (!commentary.entries || commentary.entries.length === 0) {
    return "";
  }

  const entries = commentary.entries
    .map(
      (entry) => `<details class="commentary-entry">
        <summary>${escapeHtml(entry.name)}</summary>
        <div class="body">${escapeHtml(entry.body)}${entry.truncated ? "\n[...truncated]" : ""}</div>
      </details>`,
    )
    .join("");

  return `<h2 class="source-heading">Commentary</h2>${entries}
    <p class="section-note">Public domain, via <a href="${escapeHtml(commentary.url)}" target="_blank" rel="noopener">biblehub.com</a>.</p>`;
}

// One gathered passage (translations + original language + commentary) as a
// collapsible block, so it sits alongside Claude's reply without competing
// with it for attention. Open by default — closing it is the deliberate
// action, since seeing the material is most of the point of this app.
function renderSourcePassage(gathered) {
  return `<details class="source-passage" open>
    <summary>${escapeHtml(gathered.reference.usfm)}</summary>
    <div class="source-body">
      ${renderTranslations(gathered.translations)}
      ${renderOriginalLanguage(gathered.originalLanguage)}
      ${renderCommentary(gathered.commentary)}
    </div>
  </details>`;
}

function renderSources(gatheredList) {
  if (!gatheredList || gatheredList.length === 0) return "";
  return `<div class="chat-sources">${gatheredList.map(renderSourcePassage).join("")}</div>`;
}

// --- Chat ---------------------------------------------------------------

const chatLog = document.getElementById("chat-log");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatSendButton = chatForm.querySelector('button[type="submit"]');
const homeButton = document.getElementById("nav-home-button");
const homeLink = document.getElementById("home-link");

// The "e.g. John 3:16, or..." hint is only useful before someone's typed
// their first message — once a conversation is underway, the textarea
// emptying after each send would otherwise keep bringing that hint back,
// which reads as clutter rather than help. Captured from the HTML once at
// load so "New conversation" can restore the exact original text.
const DEFAULT_INPUT_PLACEHOLDER = chatInput.placeholder;

function clearInputPlaceholder() {
  chatInput.placeholder = "";
}

let chatSessionId = null;
// The durable Supabase conversation this session's turns append to, for a
// signed-in user — see lib/chat.js's chatTurn() docstring on why this is a
// separate id from chatSessionId. null for an anonymous chat (the server
// always echoes conversationId: null in that case), or before the first
// reply of a signed-in one arrives.
let chatConversationId = null;

// --- Client-side persistence ---------------------------------------------
// This mirrors the rendered log into localStorage so a page refresh
// restores what was on screen instead of starting over blank.
//
// Server-side, whether the underlying conversation survives a restart
// depends on deployment config (lib/session-store.js: Upstash Redis if
// configured, in-memory Map otherwise — see README). Without Redis
// configured, a restart clears the server-side session even though the
// browser still shows the old messages; chatTurn() handles an unrecognized
// sessionId gracefully (starts a fresh server-side session rather than
// erroring), so this doesn't break, it just means Claude's actual memory of
// the restored-looking conversation is gone even though the messages are
// still on screen. With Redis configured, both sides genuinely agree.
const STORAGE_KEY = "adfontes.chat.v1";
// Caps how much rendered history localStorage carries — mirrors the spirit
// of lib/chat.js's own MAX_HISTORY_MESSAGES trim (a safety cap, not expected
// to be hit in normal use, since gathered source blocks are the bulk of the
// size and most conversations are a handful of turns).
const CLIENT_HISTORY_CAP = 40;

let chatLogData = []; // mirrors the rendered log: { role, text, gathered? }

function saveChatState() {
  try {
    if (chatLogData.length > CLIENT_HISTORY_CAP) {
      chatLogData = chatLogData.slice(chatLogData.length - CLIENT_HISTORY_CAP);
    }
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ sessionId: chatSessionId, conversationId: chatConversationId, log: chatLogData }),
    );
  } catch {
    // localStorage can fail (private browsing, quota, disabled entirely) —
    // persistence is a convenience, never something a chat message should
    // be blocked by, so a failure here is silently ignored.
  }
}

function clearChatState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Same reasoning as saveChatState — not worth surfacing to the user.
  }
}

function loadChatState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.log)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function appendChatMessage(role, text) {
  const el = document.createElement("div");
  el.className = `chat-message ${role}`;
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

// A small flickering candle in place of a generic spinner — fits the site's
// identity better than a plain "Thinking…" line on its own. Built as inline
// SVG (no image asset, no build step); the flicker/glow animation lives in
// CSS (.thinking-icon rules in style.css). Shape fills reference the same
// --accent/--ink-soft custom properties as the rest of the page, so this
// stays in sync automatically if the palette changes.
const THINKING_ICON = `<svg class="thinking-icon" width="18" height="24" viewBox="0 0 20 26" aria-hidden="true">
  <circle class="glow" cx="10" cy="8" r="7" fill="var(--accent)" opacity="0.18"></circle>
  <rect x="7" y="14" width="6" height="10" rx="1" fill="var(--ink-soft)"></rect>
  <rect x="6" y="12" width="8" height="2.2" rx="1" fill="var(--accent)"></rect>
  <path class="flame" d="M10 2C10 2 6 6.5 6 9.5C6 11.99 7.79 14 10 14C12.21 14 14 11.99 14 9.5C14 6.5 10 2 10 2Z" fill="var(--accent)"></path>
</svg>`;

function appendPendingMessage() {
  const el = document.createElement("div");
  el.className = "chat-message pending";
  el.innerHTML = `${THINKING_ICON}<span>Thinking…</span>`;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

// On a host that spins a free instance down after inactivity (Render's free
// plan does — see README -> Deployment), the very first request after a
// quiet period can take 30-60s just to wake the server, on top of however
// long the actual reply takes. Without any signal, that looks identical to
// the app being broken. A normal reply lands well under this threshold, so
// it never appears in the common case — only when there's genuinely a long
// wait already underway, at which point it's a reassurance, not clutter.
const COLD_START_HINT_DELAY_MS = 8000;
const COLD_START_HINT_TEXT =
  "Still working… if this is the first message in a while, the server may be waking up (can take up to a minute).";

function appendSources(gatheredList) {
  const html = renderSources(gatheredList);
  if (!html) return;
  const el = document.createElement("div");
  el.innerHTML = html;
  chatLog.appendChild(el.firstElementChild);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function sendChatMessage(message) {
  goToConversationView();
  clearInputPlaceholder();
  appendChatMessage("user", message);
  chatLogData.push({ role: "user", text: message });
  saveChatState();

  const pending = appendPendingMessage();
  chatSendButton.disabled = true;
  const coldStartTimer = setTimeout(() => {
    const label = pending.querySelector("span");
    if (label) label.textContent = COLD_START_HINT_TEXT;
  }, COLD_START_HINT_DELAY_MS);

  try {
    // window.adFontesAuth is defined by auth.js unconditionally (even when
    // accounts aren't configured at all — see that file), so this is
    // always safe to call and resolves to null when there's no signed-in
    // session to attach.
    const accessToken = await window.adFontesAuth.getAccessToken();
    const headers = { "content-type": "application/json" };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;

    const response = await fetch("/api/chat", {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: chatSessionId, conversationId: chatConversationId, message }),
    });
    const data = await response.json();

    pending.remove();

    if (!response.ok) {
      const errorText = data.error ?? `Request failed (${response.status}).`;
      appendChatMessage("error", errorText);
      chatLogData.push({ role: "error", text: errorText });
      saveChatState();
      return;
    }

    chatSessionId = data.sessionId;
    chatConversationId = data.conversationId ?? null;
    appendChatMessage("assistant", data.reply);
    appendSources(data.gathered);
    chatLogData.push({ role: "assistant", text: data.reply, gathered: data.gathered ?? null });
    saveChatState();
  } catch (error) {
    pending.remove();
    const errorText = `Network error: ${error.message}`;
    appendChatMessage("error", errorText);
    chatLogData.push({ role: "error", text: errorText });
    saveChatState();
  } finally {
    clearTimeout(coldStartTimer);
    chatSendButton.disabled = false;
    // Return focus to the input so another message can be typed right away
    // without tapping back into the field — skipped if the user has text
    // selected (reading/copying something while waiting for the reply),
    // so refocusing doesn't clear a selection out from under them.
    if (window.getSelection().toString().length === 0) {
      chatInput.focus();
    }
  }
}

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;
  chatInput.value = "";
  sendChatMessage(message);
});

// Enter sends, Shift+Enter inserts a newline (textarea's default for Enter
// is a newline, so this needs to be handled explicitly).
chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

// --- Home / conversation views -------------------------------------------
// Two client-side "pages" sharing one document: home (the empty-state block
// -- examples, daily passage + tag + callout -- see below) and conversation
// (the chat log). The message input (#chat-form) is common to both; it's
// the entry point either way, so it's never toggled by view. history.
// pushState/replaceState keeps the URL (`/` vs `/chat`) in sync with
// whichever is showing, so the browser's back/forward buttons work like
// real page navigation -- server.js serves index.html for both paths (see
// its GET /chat route), so a hard refresh or a direct link to /chat still
// loads correctly. There's no per-conversation URL yet (resuming an old
// conversation from the menu still just lands on the generic /chat) --
// deep-linking a specific saved conversation is a reasonable future step,
// just not this one.

const emptyState = document.getElementById("chat-empty-state");
const examplesContainer = document.querySelector(".examples");
const HOME_PATH = "/";
const CONVERSATION_PATH = "/chat";

// Pure DOM update, no history/URL side effects -- the one function every
// other navigation helper below funnels through, and also what the
// popstate handler calls directly (browser back/forward should change what
// you see without mutating the conversation itself or pushing more history).
function renderView(view) {
  const isHome = view === "home";
  emptyState.hidden = !isHome;
  examplesContainer.hidden = !isHome;
  chatLog.hidden = isHome;
  homeButton.hidden = isHome; // nothing to go "home" from while already there
}

function goToConversationView({ push = true } = {}) {
  renderView("conversation");
  if (push && location.pathname !== CONVERSATION_PATH) {
    history.pushState({ view: "conversation" }, "", CONVERSATION_PATH);
  }
}

function goToHomeView({ push = true } = {}) {
  renderView("home");
  if (push && location.pathname !== HOME_PATH) {
    history.pushState({ view: "home" }, "", HOME_PATH);
  }
}

window.addEventListener("popstate", (event) => {
  const view = event.state?.view ?? (location.pathname === CONVERSATION_PATH ? "conversation" : "home");
  renderView(view);
});

const EXAMPLE_POOL = [
  { label: "John 3:16", question: "What does John 3:16 mean?" },
  { label: "Genesis 1:1", question: "What does Genesis 1:1 tell us about creation?" },
  { label: "1 Cor 13:4", question: "What kind of love does Paul describe in 1 Corinthians 13:4?" },
  { label: "Romans 8:28", question: "What does Romans 8:28 actually promise?" },
  { label: "Psalm 23:1", question: "What does it mean that 'the LORD is my shepherd' in Psalm 23:1?" },
  { label: "Matthew 5:3", question: "What does it mean to be 'poor in spirit' in Matthew 5:3?" },
  { label: "Ephesians 2:8", question: "What does Ephesians 2:8 mean by saved 'by grace through faith'?" },
  { label: "Philippians 4:6", question: "What is Paul saying about anxiety in Philippians 4:6?" },
  { label: "Isaiah 53:5", question: "Who is Isaiah 53:5 describing, and what does it mean?" },
  { label: "1 John 4:8", question: "What does it mean that 'God is love' in 1 John 4:8?" },
  { label: "Sermon on Romans 8", question: "Can you put together a sermon outline on Romans 8:28-30?" },
];

function shuffled(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function renderExamples() {
  examplesContainer.querySelectorAll(".example").forEach((button) => button.remove());
  for (const { label, question } of shuffled(EXAMPLE_POOL).slice(0, 4)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "example";
    button.textContent = label;
    button.addEventListener("click", () => sendChatMessage(question));
    examplesContainer.appendChild(button);
  }
}

// --- Today's passage -----------------------------------------------------
// A lightweight habit hook: the same reference for everyone on a given day
// (lib/daily-passage.js), shown only as part of the empty state — once a
// conversation is underway it's already hidden along with the rest of that
// block, no extra wiring needed. Clicking it just sends a normal chat
// message, reusing the exact same flow as typing a reference by hand or
// clicking an example prompt, so this adds no new rendering logic at all.
const dailyPassageContainer = document.getElementById("daily-passage");
const dailyPassageButton = document.getElementById("daily-passage-button");
const dailyPassageTag = document.getElementById("daily-passage-tag");

async function loadDailyPassage() {
  try {
    const response = await fetch("/api/daily");
    if (!response.ok) return; // fails silently -- this is a nice-to-have, not core functionality
    const { usfm, label, tag } = await response.json();
    if (!label) return;
    dailyPassageButton.textContent = label;
    dailyPassageButton.addEventListener("click", () => sendChatMessage(`What does ${label} (${usfm}) mean?`));
    if (tag) dailyPassageTag.textContent = tag;
    dailyPassageContainer.hidden = false;
  } catch {
    // Network hiccup or the endpoint being briefly unavailable shouldn't
    // block or clutter the rest of the page -- same reasoning as
    // saveChatState()'s localStorage failures being silently ignored.
  }
}

// Replays a { role, text, gathered? } log through the same render functions
// a live turn uses — shared by restoreChatState() (from localStorage) and
// loadConversation() (from the server, via the top-left menu's "previous
// conversations" list) so a restored/resumed log looks pixel-identical to
// one that just arrived, in either case.
function renderChatLog(entries) {
  for (const entry of entries) {
    if (entry.role === "user") {
      appendChatMessage("user", entry.text);
    } else if (entry.role === "assistant") {
      appendChatMessage("assistant", entry.text);
      if (entry.gathered) appendSources(entry.gathered);
    } else if (entry.role === "error") {
      appendChatMessage("error", entry.text);
    }
  }
}

// Resets to a blank conversation AND navigates home -- this is what both
// the "Home" button and clicking the logo do (see the listeners below).
// Takes over "New conversation"'s old job: there's no separate way to
// abandon an in-progress chat anymore, since going home now always starts
// fresh (browser back/forward, by contrast, never resets state -- see the
// popstate handler above -- so an accidental trip home is still recoverable).
function startNewConversation() {
  chatSessionId = null;
  chatConversationId = null;
  chatLogData = [];
  clearChatState();
  chatLog.innerHTML = "";
  renderExamples();
  chatInput.placeholder = DEFAULT_INPUT_PLACEHOLDER;
  goToHomeView();
  chatInput.focus();
}

homeButton.addEventListener("click", startNewConversation);

// The logo's default click behavior would be a real navigation to "/" --
// intercepted here because a full page reload wouldn't clear localStorage/
// in-memory state on its own (this is a single-page app under the hood),
// so it wouldn't actually feel like "starting fresh," just a slower way to
// land back on whatever conversation was already saved.
homeLink.addEventListener("click", (event) => {
  event.preventDefault();
  startNewConversation();
});

// Restore a previous conversation from localStorage, if there is one. Does
// NOT touch the URL itself -- the caller (the init sequence at the bottom
// of this file) decides push vs. replace, since this also runs on plain
// page load where neither is quite right on its own.
function restoreChatState() {
  const saved = loadChatState();
  if (!saved || saved.log.length === 0) return false;

  chatSessionId = saved.sessionId ?? null;
  chatConversationId = saved.conversationId ?? null;
  chatLogData = saved.log;
  clearInputPlaceholder(); // restoring a conversation means this isn't a first visit
  renderChatLog(saved.log);
  renderView("conversation");
  return true;
}

// Loads a conversation fetched from GET /api/conversations/:id (see
// auth.js's loadConversation(), which calls this after the network
// request resolves) — swaps the whole chat log over to it, the same way
// "New conversation" swaps to an empty one. Note: continuing to chat from
// here keeps the same conversation id (so it stays the same row in
// Supabase), but if the id's live server-side session already idled out,
// Claude starts that next reply without the old back-and-forth as context
// — see lib/chat.js's chatTurn() docstring.
function loadConversation(conversation) {
  // Optimistically reuse the conversation's id as the live sessionId too —
  // harmless either way: if that Redis/in-memory session is still alive
  // (a recently-active conversation), Claude keeps its real context; if
  // not, lib/chat.js's chatTurn() just treats it as unrecognized and starts
  // a fresh one, same as any other expired sessionId. conversationId is set
  // explicitly and unconditionally, since that's what actually keeps the
  // next message appending to this same durable row regardless of what
  // happens with the live session.
  chatSessionId = conversation.id;
  chatConversationId = conversation.id;
  chatLogData = conversation.renderLog ?? [];
  chatLog.innerHTML = "";
  clearInputPlaceholder();
  renderChatLog(chatLogData);
  // Always the conversation view, even for the (unusual) case of an empty
  // render_log -- the user explicitly picked this conversation from the
  // menu, so bouncing them back to home instead would be more surprising
  // than an empty chat log.
  goToConversationView();
  saveChatState();
  chatInput.focus();
}

window.adFontesChat = { loadConversation, startNewConversation };

renderExamples();
if (restoreChatState()) {
  history.replaceState({ view: "conversation" }, "", CONVERSATION_PATH);
} else {
  renderView("home");
  history.replaceState({ view: "home" }, "", HOME_PATH);
}
loadDailyPassage();
