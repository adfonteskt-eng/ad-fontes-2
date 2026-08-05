// Fetches a passage from the YouVersion Platform API and prints it.
//   Usage: npm start            -> John 3:16
//          node index.js ROM.8.28

const API_BASE = "https://api.youversion.com/v1";
const DEFAULT_REFERENCE = "JHN.3.16";

// Load the .env sitting next to this script, so it works from any directory.
// Real environment variables still win, and a missing .env is fine as long as
// the key is exported some other way.
try {
  process.loadEnvFile(new URL(".env", import.meta.url));
} catch {
  // no .env file — fall through to whatever is already in the environment
}

async function fetchPassage(reference, { appKey, bibleId }) {
  const url = `${API_BASE}/bibles/${bibleId}/passages/${reference}`;
  const response = await fetch(url, {
    headers: {
      "X-YVP-App-Key": appKey,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `YouVersion API returned ${response.status} ${response.statusText}\n${body}`,
    );
  }

  return response.json();
}

async function main() {
  const appKey = process.env.YVP_APP_KEY;
  if (!appKey) {
    throw new Error(
      "YVP_APP_KEY is not set. Copy .env.example to .env and add your app key.",
    );
  }

  const bibleId = process.env.BIBLE_ID ?? "3034";
  const reference = process.argv[2] ?? DEFAULT_REFERENCE;

  const passage = await fetchPassage(reference, { appKey, bibleId });

  console.log(`${passage.reference}\n\n${passage.content}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
