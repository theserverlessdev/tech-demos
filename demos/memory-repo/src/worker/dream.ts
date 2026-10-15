import type { MemoryPath } from "../shared/types";
import { bulletKey, isMemoryPath, MAX_FILE_CHARS, MAX_FILES, MEMORY_PATHS, parseBullets, stripProvenance, TOPIC_PATHS } from "./memory-files";
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

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "at", "is", "are"]);

/** Words a merge must keep. "Likes tea" ⊂ "Likes jasmine tea". */
export function contentWords(text: string): string[] {
  const words = stripProvenance(text).toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
  return words.filter((word) => !STOP.has(word));
}

/** A dropped bullet is a consolidation, not a loss, when its words remain in a kept bullet. */
export function factAbsorbed(dropped: string, kept: string[]): boolean {
  const words = contentWords(dropped);
  if (words.length === 0) return false;
  const needle = stripProvenance(dropped).toLowerCase();
  return kept.some((bullet) => {
    const hay = stripProvenance(bullet).toLowerCase();
    if (hay.includes(needle)) return true;
    const set = new Set(contentWords(bullet));
    return words.every((word) => set.has(word));
  });
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
  const merged: string[] = [];
  for (const path of TOPIC_PATHS) {
    const beforeBullets = parseBullets(current[path] ?? "");
    const afterBullets = parseBullets(files[path]);
    const afterKeys = new Set(afterBullets.map(bulletKey));
    for (const bullet of beforeBullets) {
      const key = bulletKey(bullet);
      if (afterKeys.has(key)) continue;
      if (!factAbsorbed(bullet, afterBullets)) {
        return { ok: false, reason: `A dream dropped a ${path} fact, so nothing was committed.` };
      }
      merged.push(stripProvenance(bullet));
    }
  }

  const same = MEMORY_PATHS.every((path) => (current[path] ?? "").replace(/\s+$/g, "") === files[path].replace(/\s+$/g, ""));
  if (same) return { ok: false, reason: "The consolidated files match the current tree, so nothing was committed." };

  let message = messageRaw;
  if (!message.toLowerCase().startsWith("dream")) message = `dream: ${message}`.slice(0, 72);
  let reason = why || "Consolidated the memory files.";
  if (merged.length > 0 && !/merg/i.test(reason)) {
    reason = `${reason} Merged ${merged.slice(0, 3).join("; ")}.`.slice(0, 240);
  }
  return { ok: true, files, message, why: reason };
}
