# ad-fontes

Fetches a passage from the [YouVersion Platform API](https://developers.youversion.com)
and prints it to the console. No dependencies — Node's built-in `fetch` and
`.env` loading do the work.

## Setup

Requires Node 20.12 or newer (`process.loadEnvFile` and global `fetch`).

```bash
cp .env.example .env   # then add your app key
```

## Usage

```bash
npm start
```

```
John 3:16

For God so loved the world that He gave His one and only Son, that everyone who believes in Him shall not perish but have eternal life.
```

Pass any USFM reference as an argument:

```bash
node index.js ROM.8.28
```

## Configuration

| Variable      | Description                                          |
| ------------- | ---------------------------------------------------- |
| `YVP_APP_KEY` | App key from developers.youversion.com. Required.     |
| `BIBLE_ID`    | Bible version id. Defaults to `3034` (Berean Standard Bible). |

`.env` is gitignored. Keep the app key out of source control.
