import type { MemoryPath } from "../shared/types";
import { isMemoryPath, MAX_FILE_CHARS, MAX_FILES, MEMORY_PATHS } from "./memory-files";
import { extractJson, oneLine, stripThinking } from "./model-text";

export type DreamOk = {
  ok: true;
  files: Record<MemoryPath, string>;
  message: string;
  why: string;
};

export type DreamNo = { ok: false; reason: string };

function normalized(body: string): string {
  const text = body.replace(/\r\n/g, "\n").trim();
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** Accept a full-file consolidation, or a reason to commit nothing. */
export function parseDream(raw: string, current: Record<string, string>): DreamOk | DreamNo {
  let value: unknown;
  try {
    value = extractJson(stripThinking(raw));
  } catch {
    return { ok: false, reason: "The model did not return JSON, so nothing was committed." };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "The model output was not an object, so nothing was committed." };
  }
  const record = value as Record<string, unknown>;
  const why = typeof record.why === "string" ? oneLine(record.why, 240) : "";
  const messageRaw = typeof record.message === "string" ? oneLine(record.message, 72) : "";
  if (!messageRaw) return { ok: false, reason: "The model omitted a commit message, so nothing was committed." };

  const filesRaw = record.files;
  if (!filesRaw || typeof filesRaw !== "object" || Array.isArray(filesRaw)) {
    return { ok: false, reason: "The model omitted the files object, so nothing was committed." };
  }
  const entries = Object.entries(filesRaw as Record<string, unknown>);
  if (entries.length !== MAX_FILES) {
    return {
      ok: false,
      reason: `The model returned ${entries.length} files, and this demo keeps exactly ${MAX_FILES}, so nothing was committed.`,
    };
  }

  const files = {} as Record<MemoryPath, string>;
  for (const [path, body] of entries) {
    if (!isMemoryPath(path)) {
      return { ok: false, reason: `The model used ${path}, which is outside the memory tree, so nothing was committed.` };
    }
    if (typeof body !== "string" || body.includes("\0")) {
      return { ok: false, reason: "A memory file was empty or binary, so nothing was committed." };
    }
    const text = normalized(body);
    if (text.trim().length === 0) return { ok: false, reason: "A memory file was empty, so nothing was committed." };
    if (text.length > MAX_FILE_CHARS) return { ok: false, reason: "A memory file was too large, so nothing was committed." };
    files[path] = text;
  }
  for (const path of MEMORY_PATHS) {
    if (!files[path]) return { ok: false, reason: `The model omitted ${path}, so nothing was committed.` };
  }
  const index = files["MEMORY.md"];
  if (!index.includes("people.md") || !index.includes("preferences.md") || !index.includes("projects.md")) {
    return { ok: false, reason: "MEMORY.md dropped the topic links, so nothing was committed." };
  }

  const same = MEMORY_PATHS.every((path) => (current[path] ?? "").replace(/\s+$/g, "") === files[path].replace(/\s+$/g, ""));
  if (same) return { ok: false, reason: "The consolidated files match the current tree, so nothing was committed." };

  let message = messageRaw;
  if (!message.toLowerCase().startsWith("dream")) message = `dream: ${message}`.slice(0, 72);
  return { ok: true, files, message, why: why || "Consolidated the memory files." };
}
