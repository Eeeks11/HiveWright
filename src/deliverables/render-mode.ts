import * as path from "node:path";
import type { DeliverableRenderMode } from "./types";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const JSON_EXTENSIONS = new Set([".json", ".jsonl"]);

export function inferRenderMode(
  mimeType?: string | null,
  filenameOrPath?: string | null,
  artifactKind?: string | null,
): DeliverableRenderMode {
  const normalizedMime = (mimeType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
  const ext = path.extname(filenameOrPath ?? "").toLowerCase();
  const normalizedKind = (artifactKind ?? "").toLowerCase();

  if (normalizedKind === "external_url" || normalizedKind === "external-url" || normalizedKind === "url") {
    return "external_url";
  }
  if (normalizedMime === "text/html" || normalizedMime === "application/xhtml+xml" || HTML_EXTENSIONS.has(ext)) {
    return "html";
  }
  if (normalizedMime === "text/markdown" || normalizedMime === "text/x-markdown" || MARKDOWN_EXTENSIONS.has(ext)) {
    return "markdown";
  }
  if (normalizedMime.startsWith("image/")) {
    return "image";
  }
  if (normalizedMime === "application/json" || normalizedMime.endsWith("+json") || JSON_EXTENSIONS.has(ext)) {
    return "json";
  }
  if (normalizedMime.startsWith("text/")) {
    return "text";
  }
  return "file";
}
