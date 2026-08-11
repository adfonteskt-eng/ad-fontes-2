# ad-fontes

A scripture-studying partner. Give it a Bible reference and it prints, in one go:

- The passage in several English translations (via the [YouVersion Platform API](https://developers.youversion.com))
- The tagged Greek (New Testament) or Hebrew (Old Testament) — each word with its Strong's number and a short lexicon definition
- A handful of public-domain commentaries on the passage
- An AI-generated plain-language takeaway and study notes summarizing all of the above

No dependencies.

## Roadmap

- **Phase 1 — Gather.** Pull the primary-source material for a passage into one
  structured object: translations, original-language interlinear, commentary.
  Done — `lib/gather.js`.
- **Phase 2 — Summarize.** Turn that material into something a person can read
  quickly: a short takeaway plus deeper study notes. Done — `lib/summarize.js`.
- **Phase 3 — Productize.** Turn this from a CLI into a website, app, or browser
  extension. In progress — a minimal website (`server.js` + `public/`) is up,
  reusing `gatherPassage()`/`summarizePassage()` directly rather than parsing
  CLI output. Not yet done: deployment (currently local-only), and an app or
  browser extension if that's still wanted after the website.

## Setup

Requires Node 20.12 or newer (`process.loadEnvFile` and global `fetch`).

```bash
cp .env.example .env   # then add your app key
npm run fetch-data     # ~104 MB of STEPBible text files (~34 MB Greek + ~70 MB Hebrew)
```

## Usage

```bash
npm start
```

```
============================================================
JHN.3.16
============================================================

BSB — Berean Standard Bible
For God so loved the world that He gave His one and only Son, that everyone who believes in Him shall not perish but have eternal life.

KJV — King James Version
For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.

WEB — World English Bible
...

------------------------------------------------------------
Original language
------------------------------------------------------------

Greek — NA28 critical text (25 words)

    οὕτως     houtōs    G3779    thus(-ly)
    γὰρ       gar       G1063    for
    ἠγάπησεν  ēgapēsen  G0025    to love
    ὁ         ho        G3588    the/this/who
    θεὸς      theos     G2316    God
    ...

1 variant word in the TR/Byzantine tradition hidden. Show with --variants (marked ±).

------------------------------------------------------------
Commentary
------------------------------------------------------------

Matthew Henry (Concise)
  ...

Jamieson-Fausset-Brown
  ...

------------------------------------------------------------
Summary
------------------------------------------------------------

[plain-language takeaway]

Study notes

[translation differences, word-study highlights, where commentators agree/disagree]
```

Any reference works, Old or New Testament:

```bash
node index.js GEN.1.1
node index.js PSA.23.1
node index.js ROM.8.28
node index.js JHN.3.16 --variants
node index.js JHN.3.16 --no-commentary
node index.js JHN.3.16 --no-summary
```

## Website

```bash
npm run web            # http://localhost:3000
PORT=8080 npm run web  # or pick a different port
```

A single page: type a reference (loose formats like "John 3:16" or "1 Cor 13:4"
work, not just USFM), get the same four sections as the CLI. No build step —
plain HTML/CSS/JS in `public/`, served by a zero-dependency `node:http` server
(`server.js`) that wraps `gatherPassage()`/`summarizePassage()` in one endpoint:

```
GET /api/passage?ref=JHN.3.16&variants=false&commentary=true&summary=true
```

This is local-only for now — nothing about it is deployed anywhere yet.

## Translations

Defaults to BSB, KJV, WEB, and ASV. Override with `BIBLE_IDS` in `.env` (comma-separated
YouVersion version ids) if your app key only has access to a different set — YouVersion
app keys are approved per-app for specific translations, so the defaults here may not all
be available to every key. Translations that fail to fetch are noted inline rather than
aborting the whole run.

## Manuscript variants (Greek NT)

The tagged Greek marks which manuscript tradition each word belongs to. By
default only words in the **NA28 critical text** are shown, since that's what
modern English translations (including the BSB used here) follow.

John 3:16 has one such word — `αὐτοῦ` ("his"), present in the Textus
Receptus/Byzantine tradition behind the KJV but not in NA28. Pass `--variants`
to include these; they're marked `±`.

```bash
node index.js JHN.3.16 --variants
```

The Hebrew OT side doesn't have this same NA28-vs-TR split — TAHOT instead
records manuscript variants (Qere/Ketiv, Aleppo, BHS, etc.) per word, and
every word position gets exactly one displayed row.

## Commentary

Pulls five public-domain, full-Bible-coverage commentaries from biblehub.com's
per-verse commentary page: Matthew Henry's Concise Commentary, Jamieson-Fausset-Brown,
Barnes' Notes, Gill's Exposition, and the Geneva Study Bible. Long entries are
truncated to keep the output readable; skip the section entirely with `--no-commentary`.

This is the one part of ad-fontes that scrapes a web page instead of parsing a
downloaded data file (there's no clean, keyless bulk commentary API), so it's the
piece most likely to need a fix if biblehub ever changes its page markup — if the
section comes back empty, that's the first place to check (`lib/commentary.js`).

## Summary (Phase 2)

If `ANTHROPIC_API_KEY` is set, ad-fontes sends everything gathered above —
translations, original-language words with glosses, commentary excerpts — to
Claude and asks for two things: a short plain-language takeaway (what the
passage says and why it matters, no jargon) and study notes (meaningful
translation differences, word-study highlights, where commentators agree or
genuinely disagree). It's instructed not to invent citations or pad out thin
material, and to present interpretive disagreement as disagreement rather than
pick a side.

Without an API key, this section is skipped with a one-line note — everything
else still works. Skip it explicitly with `--no-summary`, or change the model
with `SUMMARY_MODEL` in `.env`.

## Configuration

| Variable            | Description                                          |
| ------------------- | ---------------------------------------- |
| `YVP_APP_KEY`        | App key from developers.youversion.com. Required.     |
| `BIBLE_IDS`          | Comma-separated Bible version ids. Defaults to BSB, KJV, WEB, ASV. |
| `BIBLE_ID`           | Single-translation override, kept for backward compatibility. Ignored if `BIBLE_IDS` is set. |
| `ANTHROPIC_API_KEY`  | Key from console.anthropic.com. Optional — enables the summary section. |
| `SUMMARY_MODEL`      | Which Claude model generates the summary. Defaults to `claude-sonnet-5`. |

`.env` is gitignored. Keep both keys out of source control.

## Data & licence

Greek and Hebrew text and lexicons come from
[STEPBible-Data](https://github.com/STEPBible/STEPBible-Data) — created by
STEPBible.org based on work at Tyndale House Cambridge, licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Files used:

| File | Purpose |
| ---- | ------- |
| `TBESG` | Translators Brief lexicon of Extended Strongs for Greek |
| `TAGNT Mat-Jhn`, `TAGNT Act-Rev` | Tagged Greek NT |
| `TBESH` | Translators Brief lexicon of Extended Strongs for Hebrew |
| `TAHOT Gen-Deu`, `TAHOT Jos-Est`, `TAHOT Job-Sng`, `TAHOT Isa-Mal` | Tagged Hebrew OT |

They are downloaded by `npm run fetch-data` into `data/`, which is gitignored.
The licence notice asks that the data be distributed from a single source rather
than redistributed, so this repo points at the source instead of vendoring it.

Commentary text (Matthew Henry, JFB, Barnes, Gill, Geneva) is public domain and
fetched live from biblehub.com per verse rather than bundled.

## Project layout

| File | Role |
| ---- | ---- |
| `lib/gather.js` | Phase 1. `gatherPassage(usfm, opts)` → structured object, no printing. |
| `lib/summarize.js` | Phase 2. `summarizePassage(gathered, opts)` → `{ shortSummary, studyNotes }`. |
| `lib/interlinear.js` | Greek/Hebrew parsing against the STEPBible data files. |
| `lib/commentary.js` | biblehub.com scraper. |
| `index.js` | CLI: calls the two functions above and prints the result. |
| `server.js` | Web API: same two functions, one JSON endpoint, plus static file serving. |
| `public/` | Website frontend — plain HTML/CSS/JS, no build step. |
| `scripts/fetch-data.js` | Downloads the STEPBible data files into `data/`. |
