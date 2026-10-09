import type { MemoryWrite, TopicPath } from "../shared/types";
import { bulletKey, isTopicPath } from "./memory-files";
import { extractJson, oneLine, stripThinking } from "./model-text";

export type ParsedChat = {
  reply: string;
  remember: MemoryWrite[];
  summary: string;
};

function cleanFact(raw: string): string {
  return raw
    .replace(/[\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.]+$/g, "")
    .trim()
    .slice(0, 180);
}

function pushFact(into: MemoryWrite[], path: TopicPath, fact: string): void {
  const text = cleanFact(fact);
  if (text.length < 3) return;
  const bucket = into.find((write) => write.path === path);
  if (bucket) bucket.add.push(text);
  else into.push({ path, add: [text] });
}

function splitPreference(fact: string): string[] {
  const parts = fact.split(/\s+and\s+/i).map(cleanFact).filter((part) => part.length >= 3);
  return parts.length >= 2 && parts.every((part) => part.length <= 80) ? parts : [cleanFact(fact)];
}

/** Pull obvious durable facts out of a message so a chip still becomes a commit if the model omits them. */
export function extractFacts(message: string): MemoryWrite[] {
  const writes: MemoryWrite[] = [];
  const name = /\bmy name is\s+([A-Za-z][A-Za-z'-]{1,40})\b/i.exec(message);
  if (name?.[1]) pushFact(writes, "people.md", `Name is ${cleanFact(name[1])}`);

  const prefer = /\bi (prefer|like|love|hate|don't like|do not like)\s+([^.!\n]{3,120})/i.exec(message);
  if (prefer?.[1] && prefer[2]) {
    const verb = prefer[1].toLowerCase();
    const label = verb === "hate" || verb.includes("don't") || verb.includes("do not") ? "Dislikes" : verb === "prefer" ? "Prefers" : "Likes";
    for (const part of splitPreference(prefer[2])) pushFact(writes, "preferences.md", `${label} ${part}`);
  }

  const work = /\bi work on\s+([^.!\n]{3,120})/i.exec(message);
  if (work?.[1]) pushFact(writes, "projects.md", `Works on ${cleanFact(work[1])}`);

  const building = /\bi(?:'m| am) (?:building|working on)\s+([^.!\n]{3,120})/i.exec(message);
  if (building?.[1]) pushFact(writes, "projects.md", `Working on ${cleanFact(building[1])}`);

  const should = /\b([A-Za-z0-9][\w .-]{2,48}?) should\s+([^.!\n]{3,100})/i.exec(message);
  if (should?.[1] && should[2]) pushFact(writes, "projects.md", `${cleanFact(should[1])} should ${cleanFact(should[2])}`);

  return writes;
}

export function parseChatModel(raw: string): ParsedChat | null {
  let value: unknown;
  try {
    value = extractJson(stripThinking(raw));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.reply !== "string" || !record.reply.trim()) return null;
  const remember: MemoryWrite[] = [];
  if (Array.isArray(record.remember)) {
    for (const item of record.remember) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      if (typeof row.path !== "string" || !isTopicPath(row.path) || !Array.isArray(row.add)) continue;
      for (const fact of row.add) {
        if (typeof fact === "string") pushFact(remember, row.path, fact);
      }
    }
  }
  const summary = typeof record.summary === "string" ? oneLine(record.summary, 200) : "";
  return { reply: oneLine(record.reply, 1200), remember, summary };
}

export function mergeWrites(...groups: MemoryWrite[][]): MemoryWrite[] {
  const merged: MemoryWrite[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const write of group) {
      for (const fact of write.add) {
        const key = `${write.path}:${bulletKey(fact)}`;
        if (!key.endsWith(":") && seen.has(key)) continue;
        seen.add(key);
        pushFact(merged, write.path, fact);
      }
    }
  }
  return merged;
}
