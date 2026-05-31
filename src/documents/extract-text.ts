import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { inflateRawSync } from "node:zlib";

export const REFERENCE_DOCUMENT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const REFERENCE_DOCUMENT_MAX_TEXT_CHARS = 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DIRECT_TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".json"]);

export interface ExtractReferenceDocumentTextInput {
  rootDir: string;
  relativePath: string;
  maxFileBytes?: number;
  maxTextChars?: number;
  timeoutMs?: number;
}

export interface ExtractedReferenceDocumentText {
  text: string;
  truncated: boolean;
  extractor: "direct" | "pandoc" | "docx-zip" | "pdftotext" | "libreoffice";
}

export async function extractReferenceDocumentText(input: ExtractReferenceDocumentTextInput): Promise<ExtractedReferenceDocumentText> {
  const maxFileBytes = input.maxFileBytes ?? REFERENCE_DOCUMENT_MAX_FILE_BYTES;
  const maxTextChars = input.maxTextChars ?? REFERENCE_DOCUMENT_MAX_TEXT_CHARS;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { filePath } = await resolveContainedReferencePath(input.rootDir, input.relativePath);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("Reference document is not a file");
  if (stat.size > maxFileBytes) throw new Error(`Reference document exceeds ${Math.round(maxFileBytes / 1024 / 1024)}MB extraction limit`);

  const ext = path.extname(filePath).toLowerCase();
  if (DIRECT_TEXT_EXTENSIONS.has(ext)) {
    const raw = await fs.readFile(filePath, "utf8");
    return boundExtractedText(raw, maxTextChars, "direct");
  }
  if (ext === ".docx") {
    const pandoc = await runOptionalCommand("pandoc", [filePath, "-t", "plain"], { timeoutMs, maxOutputBytes: maxTextChars * 4 });
    if (pandoc.ok && pandoc.stdout.trim()) return boundExtractedText(pandoc.stdout, maxTextChars, "pandoc");
    try {
      const fallback = await extractDocxWithZipFallback(filePath, maxTextChars * 4);
      return boundExtractedText(fallback, maxTextChars, "docx-zip");
    } catch {
      throw new Error("DOCX text could not be extracted. Re-save the document as .docx/.pdf with selectable text or upload .txt/.md.");
    }
  }
  if (ext === ".pdf") {
    const result = await runOptionalCommand("pdftotext", ["-layout", "-enc", "UTF-8", filePath, "-"], { timeoutMs, maxOutputBytes: maxTextChars * 4 });
    if (!result.ok) throw new Error("PDF text extraction is unavailable or failed. Install pdftotext/poppler or upload .txt/.md.");
    if (!result.stdout.trim()) throw new Error("PDF appears to contain no selectable text. OCR or upload a text-based PDF/TXT version.");
    return boundExtractedText(result.stdout, maxTextChars, "pdftotext");
  }
  if (ext === ".doc") {
    const pandoc = await runOptionalCommand("pandoc", [filePath, "-t", "plain"], { timeoutMs, maxOutputBytes: maxTextChars * 4 });
    if (pandoc.ok && pandoc.stdout.trim()) return boundExtractedText(pandoc.stdout, maxTextChars, "pandoc");
    const libre = await extractDocWithLibreOffice(filePath, timeoutMs, maxTextChars);
    if (libre) return libre;
    throw new Error("Legacy .doc extraction is not available. Convert the file to .docx, .pdf with selectable text, .txt, or .md and retry.");
  }
  throw new Error(`Unsupported reference document type '${ext || "unknown"}'. Upload .txt, .md, .csv, .json, .docx, .pdf, or convertible .doc.`);
}

async function resolveContainedReferencePath(rootDir: string, relativePath: string): Promise<{ root: string; filePath: string }> {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error("Invalid reference document path");
  const normalized = path.normalize(relativePath);
  if (normalized === "." || normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error("Invalid reference document path");
  }
  const root = path.resolve(rootDir);
  const candidate = path.resolve(root, normalized);
  if (!isInside(candidate, root)) throw new Error("Reference document path escapes reference document directory");
  const realRoot = await fs.realpath(root);
  const realPath = await fs.realpath(candidate);
  if (!isInside(realPath, realRoot)) throw new Error("Reference document path escapes reference document directory");
  return { root: realRoot, filePath: realPath };
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function boundExtractedText(raw: string, maxTextChars: number, extractor: ExtractedReferenceDocumentText["extractor"]): ExtractedReferenceDocumentText {
  const cleaned = raw.replace(/\u0000/g, " ").replace(/\r\n/g, "\n").trim();
  if (!cleaned) throw new Error("Reference document contains no extractable text");
  return { text: cleaned.slice(0, maxTextChars), truncated: cleaned.length > maxTextChars, extractor };
}

async function commandExists(command: string): Promise<boolean> {
  if (path.isAbsolute(command)) return existsSync(command);
  return new Promise((resolve) => {
    execFile("which", [command], { windowsHide: true, env: minimalCommandEnv() }, (error) => resolve(!error));
  });
}

async function runOptionalCommand(command: string, args: string[], options: { timeoutMs: number; maxOutputBytes: number }): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  if (!(await commandExists(command))) return { ok: false, stdout: "", stderr: `${command} not found` };
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
      windowsHide: true,
      env: minimalCommandEnv(),
    }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function minimalCommandEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME,
    NODE_ENV: process.env.NODE_ENV,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TMPDIR: process.env.TMPDIR,
  };
}

async function extractDocxWithZipFallback(filePath: string, maxXmlBytes: number): Promise<string> {
  const zip = await fs.readFile(filePath);
  const entry = readZipEntry(zip, "word/document.xml", maxXmlBytes);
  if (!entry) throw new Error("missing word/document.xml");
  return xmlTextToPlain(entry);
}

function readZipEntry(zip: Buffer, wantedName: string, maxBytes: number): string | null {
  let offset = 0;
  while (offset + 30 <= zip.length) {
    const signature = zip.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;
    const flags = zip.readUInt16LE(offset + 6);
    const method = zip.readUInt16LE(offset + 8);
    const compressedSize = zip.readUInt32LE(offset + 18);
    const uncompressedSize = zip.readUInt32LE(offset + 22);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = zip.subarray(nameStart, nameStart + nameLength).toString("utf8");
    if (flags & 0x08) throw new Error("unsupported zip data descriptor");
    if (dataStart + compressedSize > zip.length) throw new Error("corrupt zip entry");
    if (name === wantedName) {
      if (uncompressedSize > maxBytes) throw new Error("docx XML too large");
      const data = zip.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return data.toString("utf8");
      if (method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes }).toString("utf8");
      throw new Error("unsupported zip compression");
    }
    offset = dataStart + compressedSize;
  }
  return null;
}

function xmlTextToPlain(xml: string): string {
  return xml
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

async function extractDocWithLibreOffice(filePath: string, timeoutMs: number, maxTextChars: number): Promise<ExtractedReferenceDocumentText | null> {
  const command = (await commandExists("libreoffice")) ? "libreoffice" : (await commandExists("soffice")) ? "soffice" : null;
  if (!command) return null;
  const tempDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "hw-doc-extract-"));
  try {
    const result = await runOptionalCommand(command, ["--headless", "--convert-to", "txt:Text", "--outdir", tempDir, filePath], { timeoutMs, maxOutputBytes: 128 * 1024 });
    if (!result.ok) return null;
    const outputPath = path.join(tempDir, `${path.parse(filePath).name}.txt`);
    const raw = await fs.readFile(outputPath, "utf8");
    return boundExtractedText(raw, maxTextChars, "libreoffice");
  } catch {
    return null;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
