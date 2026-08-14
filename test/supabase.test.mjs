// lib/supabase.js: server-side Auth token verification + study_entries
// read/write, both plain fetch against Supabase's documented REST APIs.
// Tested against a stub implementing that real contract (Auth REST's
// GET /auth/v1/user, PostgREST's /rest/v1/study_entries) rather than
// mocking the module's own internals, so a wrong request shape would fail
// these tests the same way it'd fail against the real API.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { verifyUser, logStudyEntry, searchStudyHistory, isSupabaseConfigured } from "../lib/supabase.js";

const URL_ROOT = "https://fake-project.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_fake";
const SECRET_KEY = "sb_secret_fake";

let realFetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  delete process.env.SUPABASE_SECRET_KEY;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  delete process.env.SUPABASE_SECRET_KEY;
});

function configure() {
  process.env.SUPABASE_URL = URL_ROOT;
  process.env.SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE_KEY;
  process.env.SUPABASE_SECRET_KEY = SECRET_KEY;
}

// A fake user + a fake table, backed by real Maps/arrays so requests
// actually reflect state written by earlier calls within a test.
function stubSupabase({ validToken = "valid-token", user = { id: "user-1", email: "kaleb@example.com" } } = {}) {
  configure();
  const requests = [];
  const studyEntries = [];

  globalThis.fetch = async (requestUrl, opts = {}) => {
    const url = new URL(requestUrl);
    requests.push({ url, opts });
    const headers = opts.headers ?? {};

    if (url.pathname === "/auth/v1/user") {
      assert.equal(headers.apikey, PUBLISHABLE_KEY, "should use the publishable key as apikey for token verification");
      const auth = headers.Authorization ?? "";
      const token = auth.replace(/^Bearer /, "");
      if (token !== validToken) {
        return { ok: false, status: 401, statusText: "Unauthorized", text: async () => '{"error":"invalid_token"}' };
      }
      return { ok: true, status: 200, json: async () => user };
    }

    if (url.pathname === "/rest/v1/study_entries") {
      assert.equal(headers.apikey, SECRET_KEY, "study_entries access should use the secret key");
      assert.equal(headers.Authorization, `Bearer ${SECRET_KEY}`);

      if (opts.method === "POST") {
        const rows = JSON.parse(opts.body);
        studyEntries.push(...rows);
        return { ok: true, status: 201, text: async () => "" };
      }

      // GET: apply the same filters PostgREST would.
      const params = url.searchParams;
      let results = studyEntries.filter((e) => `eq.${e.user_id}` === params.get("user_id"));
      const orFilter = params.get("or");
      if (orFilter) {
        const keyword = orFilter.match(/ilike\.\*(.*?)\*/)[1].toLowerCase();
        results = results.filter(
          (e) =>
            (e.topic ?? "").toLowerCase().includes(keyword) ||
            (e.summary ?? "").toLowerCase().includes(keyword) ||
            (e.reference ?? "").toLowerCase().includes(keyword),
        );
      }
      results = [...results].sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { ok: true, status: 200, text: async () => JSON.stringify(results) };
    }

    return { ok: false, status: 404, statusText: "Not Found", text: async () => "unknown path" };
  };

  return { requests, studyEntries };
}

// --- verifyUser --------------------------------------------------------

test("verifyUser returns null immediately for no token, without calling fetch", async () => {
  configure();
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  assert.equal(await verifyUser(undefined), null);
  assert.equal(called, false);
});

test("verifyUser returns null when Supabase isn't configured, without calling fetch", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  assert.equal(await verifyUser("some-token"), null);
  assert.equal(called, false);
  assert.equal(isSupabaseConfigured(), false);
});

test("verifyUser sends the publishable key + bearer token and returns { id, email } on success", async () => {
  stubSupabase({ validToken: "good-token", user: { id: "abc-123", email: "kaleb@example.com" } });
  const result = await verifyUser("good-token");
  assert.deepEqual(result, { id: "abc-123", email: "kaleb@example.com" });
});

test("verifyUser returns null (not a throw) for an invalid/expired token", async () => {
  stubSupabase({ validToken: "good-token" });
  assert.equal(await verifyUser("stale-or-wrong-token"), null);
});

test("verifyUser throws on a genuine Supabase-side error, distinct from a bad token", async () => {
  configure();
  globalThis.fetch = async () => ({ ok: false, status: 500, statusText: "Internal Server Error", text: async () => "boom" });
  await assert.rejects(() => verifyUser("any-token"), /Supabase Auth returned 500/);
});

// --- logStudyEntry -------------------------------------------------------

test("logStudyEntry no-ops when Supabase isn't configured", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, status: 201, text: async () => "" };
  };
  await logStudyEntry("user-1", { reference: "JHN.3.16", summary: "test" });
  assert.equal(called, false);
});

test("logStudyEntry posts a row with the secret key and the given fields", async () => {
  const { requests } = stubSupabase();
  await logStudyEntry("user-1", { reference: "JHN.3.16", summary: "Discussed God's love for the world." });

  const postRequest = requests.find((r) => r.url.pathname === "/rest/v1/study_entries" && r.opts.method === "POST");
  assert.ok(postRequest, "should have POSTed to study_entries");
  const body = JSON.parse(postRequest.opts.body);
  assert.deepEqual(body, [
    { user_id: "user-1", reference: "JHN.3.16", topic: null, summary: "Discussed God's love for the world." },
  ]);
});

// --- searchStudyHistory --------------------------------------------------

test("searchStudyHistory returns [] when Supabase isn't configured, without calling fetch", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, status: 200, text: async () => "[]" };
  };
  assert.deepEqual(await searchStudyHistory("user-1"), []);
  assert.equal(called, false);
});

test("searchStudyHistory with no keyword returns the user's most recent entries", async () => {
  const { studyEntries } = stubSupabase();
  studyEntries.push(
    { user_id: "user-1", reference: "JHN.3.16", topic: null, summary: "older", created_at: "2026-01-01T00:00:00Z" },
    { user_id: "user-1", reference: "ROM.8.28", topic: null, summary: "newer", created_at: "2026-02-01T00:00:00Z" },
    { user_id: "user-2", reference: "GEN.1.1", topic: null, summary: "someone else's", created_at: "2026-03-01T00:00:00Z" },
  );

  const results = await searchStudyHistory("user-1");
  assert.equal(results.length, 2);
  assert.equal(results[0].reference, "ROM.8.28", "should be newest-first");
  assert.ok(results.every((r) => r.summary !== "someone else's"), "should never return another user's rows");
});

test("searchStudyHistory with a keyword filters by reference, topic, or summary", async () => {
  const { studyEntries } = stubSupabase();
  studyEntries.push(
    { user_id: "user-1", reference: "JHN.3.16", topic: null, summary: "God's love for the world.", created_at: "2026-01-01T00:00:00Z" },
    { user_id: "user-1", reference: "GEN.1.1", topic: null, summary: "Creation account.", created_at: "2026-01-02T00:00:00Z" },
    { user_id: "user-1", reference: null, topic: "love", summary: "Word study on agape vs phileo.", created_at: "2026-01-03T00:00:00Z" },
  );

  const results = await searchStudyHistory("user-1", { keyword: "love" });
  assert.equal(results.length, 2, "should match the entry with 'love' in the summary and the one with 'love' as topic");
});
