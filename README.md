# ad-fontes

Prints a Bible verse in English from the [YouVersion Platform API](https://developers.youversion.com),
then the tagged Greek beneath it — each word with its Strong's number and a short
lexicon definition. No dependencies.

## Setup

Requires Node 20.12 or newer (`process.loadEnvFile` and global `fetch`).

```bash
cp .env.example .env   # then add your app key
npm run fetch-data     # ~34 MB of STEPBible text files
```

## Usage

```bash
npm start
```

```
John 3:16

For God so loved the world that He gave His one and only Son, that everyone who believes in Him shall not perish but have eternal life.

Greek — NA28 critical text (25 words)

    οὕτως     houtōs    G3779   thus(-ly)
    γὰρ       gar       G1063   for
    ἠγάπησεν  ēgapēsen  G0025   to love
    ὁ         ho        G3588   the/this/who
    θεὸς      theos     G2316   God
    ...

1 variant word in the TR/Byzantine tradition hidden. Show with --variants (marked ±).
```

Any New Testament verse works:

```bash
node index.js ROM.8.28
```

## Manuscript variants

The tagged Greek marks which manuscript tradition each word belongs to. By
default only words in the **NA28 critical text** are shown, since that's what
modern English translations (including the BSB used here) follow.

John 3:16 has one such word — `αὐτοῦ` ("his"), present in the Textus
Receptus/Byzantine tradition behind the KJV but not in NA28. Pass `--variants`
to include these; they're marked `±`.

```bash
node index.js JHN.3.16 --variants
```

## Configuration

| Variable      | Description                                          |
| ------------- | ---------------------------------------------------- |
| `YVP_APP_KEY` | App key from developers.youversion.com. Required.     |
| `BIBLE_ID`    | Bible version id. Defaults to `3034` (Berean Standard Bible). |

`.env` is gitignored. Keep the app key out of source control.

## Scope

New Testament Greek only. Old Testament verses print the English text and note
that Hebrew lookups aren't wired up — that would need the `TBESH` lexicon and the
four `TOTHT` tagged-Hebrew files from the same repo.

## Data & licence

Greek text and lexicon come from
[STEPBible-Data](https://github.com/STEPBible/STEPBible-Data) — created by
STEPBible.org based on work at Tyndale House Cambridge, licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Three files are used:

| File | Purpose |
| ---- | ------- |
| `TBESG` | Translators Brief lexicon of Extended Strongs for Greek |
| `TAGNT Mat-Jhn` | Tagged Greek NT, Matthew–John |
| `TAGNT Act-Rev` | Tagged Greek NT, Acts–Revelation |

They are downloaded by `npm run fetch-data` into `data/`, which is gitignored.
The licence notice asks that the data be distributed from a single source rather
than redistributed, so this repo points at the source instead of vendoring it.
