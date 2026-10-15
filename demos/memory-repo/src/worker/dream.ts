import type { MemoryPath } from "../shared/types";
import { bulletKey, isMemoryPath, MAX_FILE_CHARS, MAX_FILES, MEMORY_PATHS, parseBullets, TOPIC_PATHS } from "./memory-files";
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

function overlayCurrent(current: Record<string, string>): Record<MemoryPath, string> {
  const files = {} as Record<MemoryPath, string>;
  for (const path of MEMORY_PATHS) {
    const existing = current[path] ?? "";
    files[path] = existing ? normalized(existing) : "";
  }
  return files;
}

function hasForbiddenListMarkers(body: string): boolean {
  return body.split("\n").some((line) => /^\s*[*] /.test(line) || /^\s*\d+\.\s/.test(line));
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
  if (entries.length === 0 || entries.length > MAX_FILES) {
    return {
      ok: false,
      reason: `The model returned ${entries.length} files, and this demo keeps 1–${MAX_FILES}, so nothing was committed.`,
    };
  }

  const files = overlayCurrent(current);
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
    if (hasForbiddenListMarkers(text)) {
      return { ok: false, reason: "A memory file used * or numbered lists instead of - bullets, so nothing was committed." };
    }
    files[path] = text;
  }
  for (const path of MEMORY_PATHS) {
    if (!files[path]) return { ok: false, reason: `The model omitted ${path}, so nothing was committed.` };
  }
  const index = files["MEMORY.md"];
  if (!index.includes("people.md") || !index.includes("preferences.md") || !index.includes("projects.md")) {
    return { ok: false, reason: "MEMORY.md dropped the topic links, so nothing was committed." };
  }
  if (!index.includes("## Recent")) {
    return { ok: false, reason: "MEMORY.md dropped the Recent section, so nothing was committed." };
  }
  for (const path of TOPIC_PATHS) {
    const before = new Set(parseBullets(current[path] ?? "").map(bulletKey));
    const after = new Set(parseBullets(files[path]).map(bulletKey));
    for (const key of before) {
      if (!after.has(key)) {
        return { ok: false, reason: `A dream dropped a ${path} fact, so nothing was committed.` };
      }
    }
  }

  const same = MEMORY_PATHS.every((path) => (current[path] ?? "").replace(/\s+$/g, "") === files[path].replace(/\s+$/g, ""));
  if (same) return { ok: false, reason: "The consolidated files match the current tree, so nothing was committed." };

  let message = messageRaw;
  if (!message.toLowerCase().startsWith("dream")) message = `dream: ${message}`.slice(0, 72);
  return { ok: true, files, message, why: why || "Consolidated the memory files." };
}
