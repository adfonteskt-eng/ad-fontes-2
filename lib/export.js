// Study export -- a Pro feature (see README -> Subscription / paid tier)
// that turns an outline, a note, or a full saved conversation into a
// downloadable file: PDF, Word (.docx), Markdown, or plain text. Every
// format is generated from one small shared shape (see toExportModel()
// below) rather than each format having its own bespoke "what does an
// outline look like" logic -- that shape is the only thing that needs to
// know about outlines/notes/conversations at all; the four render*()
// functions only ever see the shape, never the original row.
//
// This is the one deliberate exception to this project's "zero npm
// dependencies" convention (see lib/supabase.js's header comment for that
// convention and why it exists elsewhere). Hand-rolling a correct PDF writer
// (font metrics, page-break bookkeeping, xref tables) or a correct OOXML
// .docx writer (a zip of several interlocking XML parts) from scratch would
// be a lot of fragile, security-adjacent code for a problem two small, pure
// JS, widely-used libraries already solve well -- pdfkit and docx, neither
// of which need native compilation, so they deploy on Render exactly like
// everything else here (render.yaml's buildCommand already runs
// `npm install`). web-push (see lib/push.js) is the same call for the same
// reason, one module over.

import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";

// --- Shared model -----------------------------------------------------------

/**
 * Builds the one shape every render*() function below works from:
 *   { title, meta: string[], blocks: [{ label?, text }] }
 * `meta` is a handful of short subtitle-ish lines (a reference, a saved
 * date) shown under the title. `blocks` is the body -- one block per
 * paragraph-ish unit; `label` (e.g. "You" / "Ad Fontes") is only present for
 * a conversation transcript's turns, letting the same block shape serve a
 * single-body outline/note and a multi-turn conversation without a separate
 * code path per format for each.
 */
function formatDate(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  } catch {
    return null;
  }
}

export function outlineExportModel(outline) {
  const meta = [];
  if (outline.reference) meta.push(`Reference: ${outline.reference}`);
  const saved = formatDate(outline.createdAt ?? outline.created_at);
  if (saved) meta.push(`Saved ${saved}`);
  return {
    title: outline.title || "Untitled outline",
    meta,
    blocks: [{ text: outline.body || "" }],
  };
}

export function noteExportModel(note) {
  const meta = [];
  const saved = formatDate(note.createdAt ?? note.created_at);
  if (saved) meta.push(`Saved ${saved}`);
  return {
    title: note.reference ? `Note on ${note.reference}` : "Note",
    meta,
    blocks: [{ text: note.body || "" }],
  };
}

// A conversation's render_log is exactly the { role, text, gathered? } shape
// public/app.js's chatLogData mirrors (see lib/supabase.js's
// appendToConversation) -- role becomes a plain human label rather than
// "user"/"assistant" showing up verbatim in a document meant to read like a
// transcript, and `gathered` (the passages a reply drew on) becomes a short
// "Passages referenced" line rather than being expanded in full -- a study
// export is meant to capture the conversation itself, not re-embed the
// entire translations/original-language/commentary payload each gathered
// passage carries, which the user can always look up again in-app.
export function conversationExportModel(conversation) {
  const meta = [];
  const updated = formatDate(conversation.updatedAt ?? conversation.updated_at);
  if (updated) meta.push(`Last updated ${updated}`);

  const blocks = (conversation.renderLog ?? conversation.render_log ?? []).map((entry) => {
    const label = entry.role === "user" ? "You" : "Ad Fontes";
    const refs = (entry.gathered ?? []).map((g) => g.reference?.usfm).filter(Boolean);
    const text = refs.length > 0 ? `${entry.text}\n\n(Passages referenced: ${refs.join(", ")})` : entry.text;
    return { label, text: text || "" };
  });

  return {
    title: conversation.title || "Conversation",
    meta,
    blocks,
  };
}

// --- Plain text / Markdown ---------------------------------------------------

export function renderAsText(model) {
  const lines = [model.title];
  if (model.meta.length > 0) lines.push(model.meta.join(" · "));
  lines.push("");
  for (const block of model.blocks) {
    if (block.label) lines.push(`${block.label}:`);
    lines.push(block.text);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export function renderAsMarkdown(model) {
  const lines = [`# ${model.title}`];
  if (model.meta.length > 0) lines.push(`*${model.meta.join(" · ")}*`);
  lines.push("");
  for (const block of model.blocks) {
    if (block.label) lines.push(`**${block.label}:**`);
    lines.push(block.text);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

// --- PDF (pdfkit) ------------------------------------------------------------

// pdfkit streams its output rather than returning a buffer directly --
// collecting the emitted chunks and resolving once the stream ends is the
// documented way to get a Buffer back for something that isn't being piped
// straight to an HTTP response (see server.js's handleExport, which does
// write the whole file at once rather than streaming, to keep every export
// format's route handler the same shape).
export function renderAsPdf(model) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 54 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(20).text(model.title);
    if (model.meta.length > 0) {
      doc.moveDown(0.3);
      doc.font("Helvetica").fontSize(10).fillColor("#666666").text(model.meta.join("  ·  "));
      doc.fillColor("#000000");
    }
    doc.moveDown(1);

    for (const block of model.blocks) {
      if (block.label) {
        doc.font("Helvetica-Bold").fontSize(12).text(`${block.label}:`);
        doc.moveDown(0.2);
      }
      doc.font("Helvetica").fontSize(11).text(block.text, { align: "left" });
      doc.moveDown(1);
    }

    doc.end();
  });
}

// --- Word (.docx, via the `docx` package) ------------------------------------

export async function renderAsDocx(model) {
  const children = [
    new Paragraph({ text: model.title, heading: HeadingLevel.TITLE }),
  ];
  if (model.meta.length > 0) {
    children.push(
      new Paragraph({ children: [new TextRun({ text: model.meta.join("  ·  "), italics: true, color: "666666" })] }),
    );
  }
  for (const block of model.blocks) {
    if (block.label) {
      children.push(new Paragraph({ children: [new TextRun({ text: `${block.label}:`, bold: true })] }));
    }
    // A block's text can contain \n line breaks (e.g. an outline's own
    // paragraph structure) that a single docx Paragraph won't render as
    // separate lines on its own -- each line becomes its own TextRun with an
    // explicit line break between, rather than its own Paragraph, so they
    // stay visually grouped under one label instead of getting the larger
    // spacing Word puts between paragraphs.
    const lines = String(block.text).split("\n");
    const runs = [];
    lines.forEach((line, index) => {
      if (index > 0) runs.push(new TextRun({ text: "", break: 1 }));
      runs.push(new TextRun({ text: line }));
    });
    children.push(new Paragraph({ children: runs }));
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// --- Entry point --------------------------------------------------------------

const FORMATS = {
  pdf: { contentType: "application/pdf", extension: "pdf", render: renderAsPdf },
  docx: {
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: "docx",
    render: renderAsDocx,
  },
  md: { contentType: "text/markdown; charset=utf-8", extension: "md", render: async (model) => renderAsMarkdown(model) },
  txt: { contentType: "text/plain; charset=utf-8", extension: "txt", render: async (model) => renderAsText(model) },
};

export const EXPORT_FORMATS = Object.keys(FORMATS);

// Turns a title into a safe-ish filename stem: ascii-ish, no path
// separators/quotes that would break a Content-Disposition header or a
// filesystem, capped so an unusually long outline title can't produce an
// unwieldy download name.
function slugify(title) {
  const cleaned = String(title || "export")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
  return (cleaned || "export").slice(0, 60);
}

/**
 * Renders `model` (from one of the *ExportModel functions above) in the
 * requested format and returns { buffer, filename, contentType } ready to
 * hand straight to server.js's response. Throws on an unrecognized format --
 * server.js validates against EXPORT_FORMATS before ever calling this, so
 * that should only happen from a genuine programming error, not a bad
 * request.
 */
export async function exportModel(model, format) {
  const spec = FORMATS[format];
  if (!spec) throw new Error(`Unknown export format "${format}".`);
  const buffer = await spec.render(model);
  return { buffer, filename: `${slugify(model.title)}.${spec.extension}`, contentType: spec.contentType };
}
