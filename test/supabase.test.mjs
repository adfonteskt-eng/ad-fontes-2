// lib/supabase.js: server-side Auth token verification + study_entries
// read/write, both plain fetch against Supabase's documented REST APIs.
// Tested against a stub implementing that real contract (Auth REST's
// GET /auth/v1/user, PostgREST's /rest/v1/study_entries) rather than
// mocking the module's own internals, so a wrong request shape would fail
// these tests the same way it'd fail against the real API.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  verifyUser,
  logStudyEntry,
  searchStudyHistory,
  appendToConversation,
  listConversations,
  getConversation,
  createNote,
  listNotes,
  deleteNote,
  isSupabaseConfigured,
} from "../lib/supabase.js";

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
  const conversations = new Map(); // id -> row, mirrors an upsert-by-id table
  const notes = [];
  let nextNoteId = 1;

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
      // No Authorization header should be sent for secret-key PostgREST
      // calls — see postgrest()'s comment in lib/supabase.js. Sending the
      // secret key there too (even matching apikey) is what caused the real
      // "permissions error" in production: Supabase forwards it to Postgres
      // and rejects it there for not being a JWT.
      assert.equal(headers.Authorization, undefined, "should not send an Authorization header for secret-key requests");

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

    if (url.pathname === "/rest/v1/conversations") {
      assert.equal(headers.apikey, SECRET_KEY, "conversations access should use the secret key");
      assert.equal(headers.Authorization, undefined, "should not send an Authorization header for secret-key requests");

      if (opts.method === "POST") {
        // A real upsert (on_conflict=id, Prefer: resolution=merge-duplicates)
        // replaces the whole row -- this fake mirrors that rather than
        // trying to merge fields, since appendToConversation always sends a
        // complete row.
        const rows = JSON.parse(opts.body);
        for (const row of rows) conversations.set(row.id, row);
        return { ok: true, status: 201, text: async () => "" };
      }

      // GET
      const params = url.searchParams;
      let results = [...conversations.values()].filter((c) => `eq.${c.user_id}` === params.get("user_id"));
      const idFilter = params.get("id");
      if (idFilter) results = results.filter((c) => `eq.${c.id}` === idFilter);
      results = [...results].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      return { ok: true, status: 200, text: async () => JSON.stringify(results) };
    }

    if (url.pathname === "/rest/v1/notes") {
      assert.equal(headers.apikey, SECRET_KEY, "notes access should use the secret key");
      assert.equal(headers.Authorization, undefined, "should not send an Authorization header for secret-key requests");

      if (opts.method === "POST") {
        const rows = JSON.parse(opts.body);
        const now = new Date().toISOString();
        const created = rows.map((row) => {
          const full = { id: nextNoteId++, ...row, created_at: now, updated_at: now };
          notes.push(full);
          return full;
        });
        return { ok: true, status: 201, text: async () => JSON.stringify(created) };
      }

      const params = url.searchParams;

      if (opts.method === "DELETE") {
        const idFilter = params.get("id");
        const userFilter = params.get("user_id");
        const toDelete = notes.filter((n) => `eq.${n.id}` === idFilter && `eq.${n.user_id}` === userFilter);
        for (const row of toDelete) notes.splice(notes.indexOf(row), 1);
        return { ok: true, status: 200, text: async () => JSON.stringify(toDelete) };
      }

      // GET
      let results = notes.filter((n) => `eq.${n.user_id}` === params.get("user_id"));
      const refFilter = params.get("reference");
      if (refFilter) results = results.filter((n) => `eq.${n.reference}` === refFilter);
      results = [...results].sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { ok: true, status: 200, text: async () => JSON.stringify(results) };
    }

    return { ok: false, status: 404, statusText: "Not Found", text: async () => "unknown path" };
  };

  return { requests, studyEntries, conversations, notes };
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

// --- appendToConversation / listConversations / getConversation ----------

test("appendToConversation no-ops when Supabase isn't configured", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, status: 201, text: async () => "" };
  };
  await appendToConversation("user-1", "11111111-1111-1111-1111-111111111111", {
    title: "t",
    primaryBook: "JHN",
    entries: [{ role: "user", text: "hi" }],
  });
  assert.equal(called, false);
});

test("appendToConversation no-ops when there are no entries to append", async () => {
  const { requests } = stubSupabase();
  await appendToConversation("user-1", "11111111-1111-1111-1111-111111111111", { entries: [] });
  assert.equal(requests.length, 0);
});

test("appendToConversation creates a row on first use with the given title/primaryBook", async () => {
  const { conversations } = stubSupabase();
  const id = "11111111-1111-1111-1111-111111111111";
  await appendToConversation("user-1", id, {
    title: "What does John 3:16 mean?",
    primaryBook: "JHN",
    entries: [
      { role: "user", text: "What does John 3:16 mean?" },
      { role: "assistant", text: "It's about God's love...", gathered: null },
    ],
  });

  const row = conversations.get(id);
  assert.ok(row, "expected a conversations row to be created");
  assert.equal(row.user_id, "user-1");
  assert.equal(row.title, "What does John 3:16 mean?");
  assert.equal(row.primary_book, "JHN");
  assert.equal(row.render_log.length, 2);
});

test("appendToConversation keeps the original title/primaryBook on later turns", async () => {
  const { conversations } = stubSupabase();
  const id = "11111111-1111-1111-1111-111111111111";
  await appendToConversation("user-1", id, {
    title: "First message",
    primaryBook: "JHN",
    entries: [{ role: "user", text: "First message" }],
  });
  await appendToConversation("user-1", id, {
    title: "Second message", // a candidate, but should NOT overwrite the existing title
    primaryBook: "ROM",
    entries: [{ role: "user", text: "Second message" }],
  });

  const row = conversations.get(id);
  assert.equal(row.title, "First message", "title should stick to the conversation's first message");
  assert.equal(row.primary_book, "JHN", "primaryBook should stick to whatever was first gathered");
  assert.equal(row.render_log.length, 2, "entries should accumulate across turns");
});

test("listConversations returns [] when Supabase isn't configured, without calling fetch", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, status: 200, text: async () => "[]" };
  };
  assert.deepEqual(await listConversations("user-1"), []);
  assert.equal(called, false);
});

test("listConversations scopes to the given user and never returns render_log", async () => {
  const { conversations } = stubSupabase();
  conversations.set("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    user_id: "user-1",
    title: "Mine",
    primary_book: "GEN",
    render_log: [{ role: "user", text: "..." }],
    updated_at: "2026-01-01T00:00:00Z",
  });
  conversations.set("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", {
    id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    user_id: "user-2",
    title: "Someone else's",
    primary_book: null,
    render_log: [],
    updated_at: "2026-01-02T00:00:00Z",
  });

  const results = await listConversations("user-1");
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Mine");
});

test("getConversation returns null when Supabase isn't configured, without calling fetch", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, status: 200, text: async () => "[]" };
  };
  assert.equal(await getConversation("user-1", "11111111-1111-1111-1111-111111111111"), null);
  assert.equal(called, false);
});

test("getConversation returns the full render_log for the owning user", async () => {
  const { conversations } = stubSupabase();
  const id = "11111111-1111-1111-1111-111111111111";
  conversations.set(id, {
    id,
    user_id: "user-1",
    title: "A study",
    primary_book: "ROM",
    render_log: [{ role: "user", text: "hi" }],
    updated_at: "2026-01-01T00:00:00Z",
  });

  const row = await getConversation("user-1", id);
  assert.equal(row.title, "A study");
  assert.equal(row.render_log.length, 1);
});

test("getConversation returns null for another user's conversation (ownership scoping, not a separate check)", async () => {
  const { conversations } = stubSupabase();
  const id = "11111111-1111-1111-1111-111111111111";
  conversations.set(id, {
    id,
    user_id: "user-2",
    title: "Not yours",
    primary_book: null,
    render_log: [],
    updated_at: "2026-01-01T00:00:00Z",
  });

  assert.equal(await getConversation("user-1", id), null);
});

test("getConversation returns null for a nonexistent id", async () => {
  stubSupabase();
  assert.equal(await getConversation("user-1", "99999999-9999-9999-9999-999999999999"), null);
});

// --- createNote / listNotes / deleteNote ----------------------------------

test("createNote posts with the secret key and returns the created row", async () => {
  const { requests } = stubSupabase();
  const note = await createNote("user-1", { reference: "JHN.3.16", body: "God's love for the world." });

  const postRequest = requests.find((r) => r.url.pathname === "/rest/v1/notes" && r.opts.method === "POST");
  assert.ok(postRequest, "should have POSTed to notes");
  assert.deepEqual(JSON.parse(postRequest.opts.body), [
    { user_id: "user-1", reference: "JHN.3.16", body: "God's love for the world." },
  ]);
  assert.equal(note.reference, "JHN.3.16");
  assert.equal(note.body, "God's love for the world.");
  assert.ok(note.id, "should return the created row's id");
});

test("listNotes returns [] when Supabase isn't configured, without calling fetch", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, status: 200, text: async () => "[]" };
  };
  assert.deepEqual(await listNotes("user-1", "JHN.3.16"), []);
  assert.equal(called, false);
});

test("listNotes scopes to the given user and exact reference, newest first", async () => {
  const { notes } = stubSupabase();
  notes.push(
    { id: 1, user_id: "user-1", reference: "JHN.3.16", body: "older", created_at: "2026-01-01T00:00:00Z" },
    { id: 2, user_id: "user-1", reference: "JHN.3.16", body: "newer", created_at: "2026-02-01T00:00:00Z" },
    { id: 3, user_id: "user-1", reference: "JHN.3.17", body: "different verse", created_at: "2026-02-02T00:00:00Z" },
    { id: 4, user_id: "user-2", reference: "JHN.3.16", body: "someone else's", created_at: "2026-02-03T00:00:00Z" },
  );

  const results = await listNotes("user-1", "JHN.3.16");
  assert.equal(results.length, 2);
  assert.equal(results[0].body, "newer", "should be newest-first");
  assert.ok(results.every((n) => n.body !== "different verse" && n.body !== "someone else's"));
});

test("deleteNote removes the row and returns true when it belongs to the given user", async () => {
  const { notes } = stubSupabase();
  notes.push({ id: 1, user_id: "user-1", reference: "JHN.3.16", body: "mine", created_at: "2026-01-01T00:00:00Z" });

  const deleted = await deleteNote("user-1", 1);
  assert.equal(deleted, true);
  assert.equal(notes.length, 0);
});

test("deleteNote returns false and deletes nothing for another user's note (ownership scoping, not a separate check)", async () => {
  const { notes } = stubSupabase();
  notes.push({ id: 1, user_id: "user-2", reference: "JHN.3.16", body: "not yours", created_at: "2026-01-01T00:00:00Z" });

  const deleted = await deleteNote("user-1", 1);
  assert.equal(deleted, false);
  assert.equal(notes.length, 1, "the other user's row should be untouched");
});

test("deleteNote returns false for a nonexistent id", async () => {
  stubSupabase();
  assert.equal(await deleteNote("user-1", 999), false);
});
