// lib/export.js: the shared export model builders (outlineExportModel/
// noteExportModel/conversationExportModel) and the four format renderers
// (renderAsText/renderAsMarkdown/renderAsPdf/renderAsDocx) plus the
// exportModel() entry point server.js's GET /api/export/:type/:id actually
// calls. PDF/DOCX correctness is checked at the "does this look like a real
// file of that type, and is it non-trivially sized" level -- byte-for-byte
// PDF/OOXML assertions would just be re-testing pdfkit/docx themselves,
// which isn't this project's code to test.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  outlineExportModel,
  noteExportModel,
  conversationExportModel,
  studyTrailExportModel,
  renderAsText,
  renderAsMarkdown,
  renderAsPdf,
  renderAsDocx,
  exportModel,
  EXPORT_FORMATS,
} from "../lib/export.js";

test("outlineExportModel carries the title, reference, and saved date into meta", () => {
  const model = outlineExportModel({
    title: "Sermon on the Mount, part 1",
    reference: "MAT.5.1-12",
    body: "I. Introduction\nII. The Beatitudes",
    createdAt: "2026-01-15T00:00:00Z",
  });
  assert.equal(model.title, "Sermon on the Mount, part 1");
  assert.ok(model.meta.some((line) => line.includes("MAT.5.1-12")));
  assert.equal(model.blocks.length, 1);
  assert.equal(model.blocks[0].text, "I. Introduction\nII. The Beatitudes");
  assert.equal(model.blocks[0].label, undefined, "an outline's single block has no speaker label");
});

test("outlineExportModel falls back to a placeholder title and omits a reference line when there is none", () => {
  const model = outlineExportModel({ title: "", reference: null, body: "Some content.", createdAt: "2026-01-15T00:00:00Z" });
  assert.equal(model.title, "Untitled outline");
  assert.ok(!model.meta.some((line) => line.startsWith("Reference:")));
});

test("noteExportModel titles itself after the reference, or plainly \"Note\" without one", () => {
  const withRef = noteExportModel({ reference: "JHN.3.16", body: "God's love.", createdAt: "2026-01-01T00:00:00Z" });
  assert.equal(withRef.title, "Note on JHN.3.16");

  const withoutRef = noteExportModel({ reference: null, body: "A topical thought.", createdAt: "2026-01-01T00:00:00Z" });
  assert.equal(withoutRef.title, "Note");
});

test("conversationExportModel labels each turn You/Ad Fontes and appends referenced passages", () => {
  const model = conversationExportModel({
    title: "John 3:16 study",
    updatedAt: "2026-01-01T00:00:00Z",
    renderLog: [
      { role: "user", text: "What does John 3:16 mean?" },
      {
        role: "assistant",
        text: "It describes God's love for the world.",
        gathered: [{ reference: { usfm: "JHN.3.16" } }],
      },
    ],
  });
  assert.equal(model.blocks.length, 2);
  assert.equal(model.blocks[0].label, "You");
  assert.equal(model.blocks[0].text, "What does John 3:16 mean?");
  assert.equal(model.blocks[1].label, "Ad Fontes");
  assert.match(model.blocks[1].text, /Passages referenced: JHN\.3\.16/);
});

test("conversationExportModel defaults to \"Conversation\" when untitled and handles an empty render_log", () => {
  const model = conversationExportModel({ title: null, updatedAt: null, renderLog: [] });
  assert.equal(model.title, "Conversation");
  assert.deepEqual(model.blocks, []);
});

// --- studyTrailExportModel (spec item 11: Study Trail) --------------------
// No new recording mechanism -- see lib/export.js's own comment -- so
// what's worth testing is the walk-and-dedupe logic over a render_log
// shaped exactly like lib/chat.js's chatTurn() actually persists it.

test("studyTrailExportModel distills every artifact type from a render_log, one stop each, in encounter order", () => {
  const model = studyTrailExportModel({
    title: "James study",
    updatedAt: "2026-01-01T00:00:00Z",
    renderLog: [
      { role: "user", text: "Tell me about James" },
      {
        role: "assistant",
        text: "...",
        briefings: [{ reference: "JAS", genre: "Wisdom literature" }],
        gathered: [{ reference: { usfm: "JAS.1.19" } }],
      },
      { role: "user", text: "What connects to it?" },
      {
        role: "assistant",
        text: "...",
        crossReferences: [{ reference: "JAS.1.19", results: [], totalCount: 8 }],
        maps: [{ title: "Paul's First Missionary Journey" }],
        wordStudies: [{ strongsNumber: "G3709", totalCount: 36 }],
      },
    ],
  });

  assert.equal(model.title, "Study Trail — James study");
  assert.deepEqual(
    model.blocks.map((b) => b.label),
    ["Briefing", "Passage studied", "Cross-references", "Map", "Word study"],
  );
  assert.equal(model.blocks[0].text, "JAS — Wisdom literature");
  assert.equal(model.blocks[1].text, "JAS.1.19");
  assert.match(model.blocks[2].text, /JAS\.1\.19 — 8 connections/);
  assert.equal(model.blocks[3].text, "Paul's First Missionary Journey");
  assert.match(model.blocks[4].text, /G3709 — 36 occurrences/);
});

test("studyTrailExportModel deduplicates a passage/map/etc. gathered more than once across turns, keeping first occurrence", () => {
  const model = studyTrailExportModel({
    title: "Repeat study",
    renderLog: [
      { role: "assistant", text: "...", gathered: [{ reference: { usfm: "JHN.3.16" } }] },
      { role: "assistant", text: "...", gathered: [{ reference: { usfm: "JHN.3.16" } }, { reference: { usfm: "ROM.5.8" } }] },
    ],
  });
  assert.equal(model.blocks.length, 2);
  assert.equal(model.blocks[0].text, "JHN.3.16");
  assert.equal(model.blocks[1].text, "ROM.5.8");
});

test("studyTrailExportModel ignores user-role entries and ones with no structured artifacts", () => {
  const model = studyTrailExportModel({
    title: "Chit-chat",
    renderLog: [
      { role: "user", text: "Hi" },
      { role: "assistant", text: "Hello! What would you like to study?" },
    ],
  });
  assert.equal(model.blocks.length, 1);
  assert.match(model.blocks[0].text, /fills in as you study/);
});

test("studyTrailExportModel defaults to a plain \"Study Trail\" title when the conversation is untitled", () => {
  const model = studyTrailExportModel({ title: null, renderLog: [] });
  assert.equal(model.title, "Study Trail");
});

const SAMPLE_MODEL = {
  title: "Test Title",
  meta: ["Reference: JHN.3.16", "Saved January 1, 2026"],
  blocks: [
    { label: "You", text: "First line." },
    { text: "Second block, no label." },
  ],
};

test("renderAsText includes the title, meta, and every block's text, labels prefixed with a colon", () => {
  const text = renderAsText(SAMPLE_MODEL);
  assert.match(text, /^Test Title/);
  assert.match(text, /Reference: JHN\.3\.16/);
  assert.match(text, /You:/);
  assert.match(text, /First line\./);
  assert.match(text, /Second block, no label\./);
});

test("renderAsMarkdown headers the title with #, meta italicized, labels bolded", () => {
  const md = renderAsMarkdown(SAMPLE_MODEL);
  assert.match(md, /^# Test Title/);
  assert.match(md, /\*Reference: JHN\.3\.16.*\*/);
  assert.match(md, /\*\*You:\*\*/);
  assert.match(md, /First line\./);
});

test("renderAsPdf produces a real PDF (starts with the %PDF magic bytes) of non-trivial size", async () => {
  const buffer = await renderAsPdf(SAMPLE_MODEL);
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 4).toString(), "%PDF");
  assert.ok(buffer.length > 500, "a real rendered PDF should be more than a few hundred bytes");
});

test("renderAsDocx produces a real .docx (a zip archive, starting with the PK magic bytes)", async () => {
  const buffer = await renderAsDocx(SAMPLE_MODEL);
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 2).toString(), "PK");
  assert.ok(buffer.length > 500, "a real rendered docx should be more than a few hundred bytes");
});

test("renderAsDocx renders a multi-line block's \\n breaks without throwing", async () => {
  const model = { title: "Multi-line", meta: [], blocks: [{ text: "Line one\nLine two\nLine three" }] };
  const buffer = await renderAsDocx(model);
  assert.ok(buffer.length > 500);
});

test("EXPORT_FORMATS lists exactly the four supported formats", () => {
  assert.deepEqual([...EXPORT_FORMATS].sort(), ["docx", "md", "pdf", "txt"]);
});

test("exportModel returns a slugified filename derived from the title, with the right extension and content type per format", async () => {
  const model = { title: "Sermon on the Mount, part 1!", meta: [], blocks: [{ text: "Body." }] };

  const pdf = await exportModel(model, "pdf");
  assert.equal(pdf.filename, "sermon-on-the-mount-part-1.pdf");
  assert.equal(pdf.contentType, "application/pdf");

  const docx = await exportModel(model, "docx");
  assert.equal(docx.filename, "sermon-on-the-mount-part-1.docx");
  assert.equal(docx.contentType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

  const md = await exportModel(model, "md");
  assert.equal(md.filename, "sermon-on-the-mount-part-1.md");
  assert.equal(md.contentType, "text/markdown; charset=utf-8");

  const txt = await exportModel(model, "txt");
  assert.equal(txt.filename, "sermon-on-the-mount-part-1.txt");
  assert.equal(txt.contentType, "text/plain; charset=utf-8");
});

test("exportModel falls back to \"export\" for a title with nothing slug-worthy in it", async () => {
  const { filename } = await exportModel({ title: "!!!", meta: [], blocks: [] }, "txt");
  assert.equal(filename, "export.txt");
});

test("exportModel throws for an unrecognized format", async () => {
  await assert.rejects(() => exportModel(SAMPLE_MODEL, "epub"), /Unknown export format/);
});
