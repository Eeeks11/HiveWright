import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractReferenceDocumentText } from "./extract-text";

let root = "";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "hw-extract-"));
});

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function localZip(entries: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name);
    const raw = Buffer.from(content);
    const compressed = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, compressed);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(compressed.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

function simpleTextPdf(text: string): Buffer {
  const escaped = text.replace(/([\\()])/g, "\\$1");
  const stream = Buffer.from(`BT /F1 24 Tf 72 720 Td (${escaped}) Tj ET`);
  const objects = [
    Buffer.from("1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"),
    Buffer.from("2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n"),
    Buffer.from("3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n"),
    Buffer.from("4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n"),
    Buffer.from(`5 0 obj << /Length ${stream.length} >> stream\n${stream.toString("latin1")}\nendstream endobj\n`),
  ];
  const offsets = [0];
  const parts = [Buffer.from("%PDF-1.4\n")];
  let cursor = parts[0].length;
  for (const object of objects) {
    offsets.push(cursor);
    parts.push(object);
    cursor += object.length;
  }
  const xrefOffset = cursor;
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`];
  for (let i = 1; i <= objects.length; i += 1) xref.push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  xref.push(`trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.concat([...parts, Buffer.from(xref.join(""))]);
}

describe("extractReferenceDocumentText", () => {
  it("extracts bounded text files inside the reference document root", async () => {
    await fs.writeFile(path.join(root, "rules.txt"), "Line one\nLine two");

    await expect(extractReferenceDocumentText({ rootDir: root, relativePath: "rules.txt" }))
      .resolves.toMatchObject({ text: "Line one\nLine two", truncated: false });
  });

  it("extracts DOCX text via ZIP/XML fallback without executing document instructions", async () => {
    const docx = localZip({
      "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Park rules</w:t></w:r></w:p><w:p><w:r><w:t>Do not feed wildlife.</w:t></w:r></w:p></w:body></w:document>`,
    });
    await fs.writeFile(path.join(root, "Park Rules.docx"), docx);

    const extracted = await extractReferenceDocumentText({ rootDir: root, relativePath: "Park Rules.docx" });

    expect(extracted.text).toContain("Park rules");
    expect(extracted.text).toContain("Do not feed wildlife.");
  });

  it("extracts PDF text with pdftotext when selectable text is available", async () => {
    await fs.writeFile(path.join(root, "rules.pdf"), simpleTextPdf("Quiet hours start at 10pm"));

    const extracted = await extractReferenceDocumentText({ rootDir: root, relativePath: "rules.pdf" });

    expect(extracted.extractor).toBe("pdftotext");
    expect(extracted.text).toContain("Quiet hours start at 10pm");
  });

  it("rejects symlink traversal out of the reference document root", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hw-outside-"));
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));

    await expect(extractReferenceDocumentText({ rootDir: root, relativePath: "link.txt" }))
      .rejects.toThrow("escapes reference document directory");

    await fs.rm(outside, { recursive: true, force: true });
  });

  it("returns owner-visible failures for corrupt DOCX files", async () => {
    await fs.writeFile(path.join(root, "broken.docx"), "not a zip");

    await expect(extractReferenceDocumentText({ rootDir: root, relativePath: "broken.docx" }))
      .rejects.toThrow("DOCX text could not be extracted");
  });
});
