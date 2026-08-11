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

function appendSources(gatheredList) {
  const html = renderSources(gatheredList);
  if (!html) return;
  const el = document.createElement("div");
  el.innerHTML = html;
  chatLog.appendChild(el.firstElementChild);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function sendChatMessage(message) {
  appendChatMessage("user", message);
  const pending = appendChatMessage("pending", "Thinking…");
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

chatClearButton.addEventListener("click", () => {
  chatSessionId = null;
  chatLog.innerHTML = "";
  chatInput.focus();
});

document.querySelectorAll(".example").forEach((button) => {
  button.addEventListener("click", () => {
    sendChatMessage(button.dataset.question);
  });
});
