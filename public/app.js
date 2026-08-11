// Frontend for ad-fontes's web API (server.js). No build step, no
// framework. The chat box is the only entry point — type a bare reference
// or a full question, and the server (lib/chat.js) decides what to gather
// via tool use. Each reply can come with source material (translations,
// original-language interlinear, commentary) for whatever passage Claude
// looked up, which gets rendered inline with that turn.

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
  return `<h3 class="source-heading">Translations</h3>${rows}`;
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

  return `<h3 class="source-heading">Original language</h3>${body}`;
}

function renderCommentary(commentary) {
  if (commentary.error) {
    return `<h3 class="source-heading">Commentary</h3><p class="section-note">${escapeHtml(commentary.error)}</p>`;
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

  return `<h3 class="source-heading">Commentary</h3>${entries}
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
const chatClearButton = document.getElementById("chat-clear");

let chatSessionId = null;

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
// SVG (no image asset, no build step) with the flicker/glow done in CSS;
// `.thinking-icon` picks up currentColor via var(--accent)/var(--ink-soft)
// set directly on the shapes so it stays in sync with the color palette.
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

function appendSources(gatheredList) {
  const html = renderSources(gatheredList);
  if (!html) return;
  const el = document.createElement("div");
  el.innerHTML = html;
  chatLog.appendChild(el.firstElementChild);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function sendChatMessage(message) {
  hideEmptyState();
  appendChatMessage("user", message);
  const pending = appendPendingMessage();
  chatSendButton.disabled = true;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: chatSessionId, message }),
    });
    const data = await response.json();

    pending.remove();

    if (!response.ok) {
      appendChatMessage("error", data.error ?? `Request failed (${response.status}).`);
      return;
    }

    chatSessionId = data.sessionId;
    appendChatMessage("assistant", data.reply);
    appendSources(data.gathered);
  } catch (error) {
    pending.remove();
    appendChatMessage("error", `Network error: ${error.message}`);
  } finally {
    chatSendButton.disabled = false;
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

// --- Empty state & example prompts --------------------------------------
// Shown until the first message of a conversation, then hidden — reset by
// "New conversation". Examples are drawn fresh from a larger pool each time
// so the same four don't show on every visit.

const emptyState = document.getElementById("chat-empty-state");
const examplesContainer = document.querySelector(".examples");

function hideEmptyState() {
  emptyState.hidden = true;
  examplesContainer.hidden = true;
}

function showEmptyState() {
  emptyState.hidden = false;
  examplesContainer.hidden = false;
}

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

chatClearButton.addEventListener("click", () => {
  chatSessionId = null;
  chatLog.innerHTML = "";
  showEmptyState();
  renderExamples();
  chatInput.focus();
});

renderExamples();
