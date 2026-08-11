// Frontend for ad-fontes's web API (server.js). No build step, no
// framework — just enough JS to turn a typed reference into a query, and
// the JSON response into readable sections.

const BOOK_ALIASES = {
  genesis: "GEN", gen: "GEN", ge: "GEN",
  exodus: "EXO", exod: "EXO", exo: "EXO", ex: "EXO",
  leviticus: "LEV", lev: "LEV",
  numbers: "NUM", num: "NUM", nu: "NUM",
  deuteronomy: "DEU", deut: "DEU", deu: "DEU", dt: "DEU",
  joshua: "JOS", josh: "JOS", jos: "JOS",
  judges: "JDG", judg: "JDG", jdg: "JDG", jgs: "JDG",
  ruth: "RUT", rut: "RUT", ru: "RUT",
  "1samuel": "1SA", "1sam": "1SA", "1sa": "1SA", "1s": "1SA",
  "2samuel": "2SA", "2sam": "2SA", "2sa": "2SA", "2s": "2SA",
  "1kings": "1KI", "1kgs": "1KI", "1ki": "1KI",
  "2kings": "2KI", "2kgs": "2KI", "2ki": "2KI",
  "1chronicles": "1CH", "1chron": "1CH", "1chr": "1CH", "1ch": "1CH",
  "2chronicles": "2CH", "2chron": "2CH", "2chr": "2CH", "2ch": "2CH",
  ezra: "EZR", ezr: "EZR",
  nehemiah: "NEH", neh: "NEH",
  esther: "EST", esth: "EST", est: "EST",
  job: "JOB",
  psalms: "PSA", psalm: "PSA", psa: "PSA", ps: "PSA",
  proverbs: "PRO", prov: "PRO", pro: "PRO",
  ecclesiastes: "ECC", eccles: "ECC", eccl: "ECC", ecc: "ECC",
  songofsolomon: "SNG", songofsongs: "SNG", canticles: "SNG", song: "SNG", sng: "SNG", sos: "SNG",
  isaiah: "ISA", isa: "ISA",
  jeremiah: "JER", jer: "JER",
  lamentations: "LAM", lam: "LAM",
  ezekiel: "EZK", ezek: "EZK", ezk: "EZK",
  daniel: "DAN", dan: "DAN",
  hosea: "HOS", hos: "HOS",
  joel: "JOL", jol: "JOL",
  amos: "AMO", amo: "AMO",
  obadiah: "OBA", obad: "OBA", oba: "OBA",
  jonah: "JON", jon: "JON",
  micah: "MIC", mic: "MIC",
  nahum: "NAM", nah: "NAM", nam: "NAM",
  habakkuk: "HAB", hab: "HAB",
  zephaniah: "ZEP", zeph: "ZEP", zep: "ZEP",
  haggai: "HAG", hag: "HAG",
  zechariah: "ZEC", zech: "ZEC", zec: "ZEC",
  malachi: "MAL", mal: "MAL",
  matthew: "MAT", matt: "MAT", mat: "MAT",
  mark: "MRK", mrk: "MRK", mk: "MRK",
  luke: "LUK", luk: "LUK", lk: "LUK",
  john: "JHN", jhn: "JHN", jn: "JHN",
  acts: "ACT", act: "ACT",
  romans: "ROM", rom: "ROM",
  "1corinthians": "1CO", "1cor": "1CO", "1co": "1CO",
  "2corinthians": "2CO", "2cor": "2CO", "2co": "2CO",
  galatians: "GAL", gal: "GAL",
  ephesians: "EPH", eph: "EPH",
  philippians: "PHP", phil: "PHP", php: "PHP",
  colossians: "COL", col: "COL",
  "1thessalonians": "1TH", "1thess": "1TH", "1th": "1TH",
  "2thessalonians": "2TH", "2thess": "2TH", "2th": "2TH",
  "1timothy": "1TI", "1tim": "1TI", "1ti": "1TI",
  "2timothy": "2TI", "2tim": "2TI", "2ti": "2TI",
  titus: "TIT", tit: "TIT",
  philemon: "PHM", philem: "PHM", phm: "PHM",
  hebrews: "HEB", heb: "HEB",
  james: "JAS", jas: "JAS",
  "1peter": "1PE", "1pet": "1PE", "1pe": "1PE",
  "2peter": "2PE", "2pet": "2PE", "2pe": "2PE",
  "1john": "1JN", "1jn": "1JN",
  "2john": "2JN", "2jn": "2JN",
  "3john": "3JN", "3jn": "3JN",
  jude: "JUD", jud: "JUD",
  revelation: "REV", rev: "REV", revelations: "REV",
};

// Turns loose input ("John 3:16", "1 Cor 13:4", "gen 1.1", "JHN.3.16") into
// the "BOOK.CHAPTER.VERSE" form the server expects. Returns null if it can't
// make sense of it, so the caller can show a helpful error instead of
// sending garbage to the API.
function normalizeReference(input) {
  const trimmed = input.trim();
  const match = trimmed.match(/^((?:[1-3]\s?)?[A-Za-z]+)\.?\s+?(\d+)\s*[:.]\s*(\d+)$/);
  if (!match) return null;

  const [, rawBook, chapter, verse] = match;
  const key = rawBook.toLowerCase().replace(/\s+/g, "");
  const book = BOOK_ALIASES[key];
  if (!book) return null;

  return `${book}.${chapter}.${verse}`;
}

const form = document.getElementById("search-form");
const input = document.getElementById("ref-input");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

function setStatus(message, isError = false) {
  statusEl.hidden = !message;
  statusEl.textContent = message ?? "";
  statusEl.classList.toggle("error", isError);
}

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
  return `<h2 class="result-heading">Translations</h2>${rows}`;
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

  return `<h2 class="result-heading">Original language</h2>${body}`;
}

function renderCommentary(commentary) {
  if (commentary.error) {
    return `<h2 class="result-heading">Commentary</h2><p class="section-note">${escapeHtml(commentary.error)}</p>`;
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

  return `<h2 class="result-heading">Commentary</h2>${entries}
    <p class="section-note">Public domain, via <a href="${escapeHtml(commentary.url)}" target="_blank" rel="noopener">biblehub.com</a>.</p>`;
}

function renderSummary(summary, summaryError) {
  if (summaryError) {
    return `<h2 class="result-heading">Summary</h2><p class="section-note">${escapeHtml(summaryError)}</p>`;
  }
  if (!summary) return "";

  const notes = summary.studyNotes
    ? `<div class="study-notes">
        <p class="study-notes-heading">Study notes</p>
        ${escapeHtml(summary.studyNotes)}
      </div>`
    : "";

  return `<h2 class="result-heading">Summary</h2>
    <div class="summary-box">${escapeHtml(summary.shortSummary)}</div>
    ${notes}`;
}

const submitButton = form.querySelector('button[type="submit"]');

// Guards against a rapid double-submit (double-click, or mashing Enter while
// the AI summary call is still in flight) firing two overlapping requests.
// Without this, a stale response arriving after a newer one could overwrite
// the results the user actually asked for last.
let requestId = 0;

async function runSearch(rawInput) {
  const ref = normalizeReference(rawInput);
  if (!ref) {
    setStatus(
      `Couldn't parse "${rawInput}" as a Bible reference. Try a format like "John 3:16".`,
      true,
    );
    resultsEl.hidden = true;
    return;
  }

  const thisRequest = ++requestId;
  setStatus("Looking that up...");
  resultsEl.hidden = true;
  submitButton.disabled = true;

  try {
    const response = await fetch(`/api/passage?ref=${encodeURIComponent(ref)}`);
    const data = await response.json();

    // A newer search started while this one was still in flight — drop this
    // result rather than let it clobber what's now on screen.
    if (thisRequest !== requestId) return;

    if (!response.ok) {
      setStatus(data.error ?? `Request failed (${response.status}).`, true);
      return;
    }

    setStatus(null);
    resultsEl.innerHTML = [
      `<h2 class="result-heading">${escapeHtml(data.reference.usfm)}</h2>`,
      renderTranslations(data.translations),
      renderOriginalLanguage(data.originalLanguage),
      renderCommentary(data.commentary),
      renderSummary(data.summary, data.summaryError),
    ].join("");
    resultsEl.hidden = false;
  } catch (error) {
    if (thisRequest !== requestId) return;
    setStatus(`Network error: ${error.message}`, true);
  } finally {
    if (thisRequest === requestId) submitButton.disabled = false;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (input.value.trim()) runSearch(input.value);
});

document.querySelectorAll(".example").forEach((button) => {
  button.addEventListener("click", () => {
    input.value = button.dataset.ref;
    runSearch(button.dataset.ref);
  });
});
