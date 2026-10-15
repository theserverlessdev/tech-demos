import type { MemoryPath, MemoryWrite, TopicPath } from "../shared/types";

export const TOPIC_PATHS = ["people.md", "preferences.md", "projects.md"] as const;
export const MEMORY_PATHS = ["MEMORY.md", "people.md", "preferences.md", "projects.md"] as const;

export const MAX_FILE_CHARS = 12_000;
export const MAX_FILES = MEMORY_PATHS.length;
export const MAX_BULLETS_PER_FILE = 40;
export const MAX_WRITES_PER_TURN = 6;

const TITLES: Record<TopicPath, string> = {
  "people.md": "People",
  "preferences.md": "Preferences",
  "projects.md": "Projects",
};

export const MEMORY_AUTHOR = {
  name: "Memory Agent",
  email: "memory@memory-repo.invalid",
};

export function isTopicPath(path: string): path is TopicPath {
  return (TOPIC_PATHS as readonly string[]).includes(path);
}

export function isMemoryPath(path: string): path is MemoryPath {
  return (MEMORY_PATHS as readonly string[]).includes(path);
}

export function seedFiles(): Record<MemoryPath, string> {
  return {
    "MEMORY.md": renderIndex([]),
    "people.md": topicFile("people.md", []),
    "preferences.md": topicFile("preferences.md", []),
    "projects.md": topicFile("projects.md", []),
  };
}

export function renderIndex(recent: string[]): string {
  const lines = recent.slice(0, 12);
  const recentBlock = lines.length ? lines.map((line) => `- ${line}`).join("\n") : "- Nothing remembered yet.";
  return [
    "# Memory",
    "",
    "This index points at the topic files. Each memory write and each dream is a git commit.",
    "",
    "- [people](people.md) — names and roles",
    "- [preferences](preferences.md) — durable likes and dislikes",
    "- [projects](projects.md) — work in progress",
    "",
    "## Recent",
    "",
    recentBlock,
    "",
  ].join("\n");
}

function topicFile(path: TopicPath, bullets: string[]): string {
  const body = bullets.length ? bullets.map((bullet) => `- ${bullet}`).join("\n") : "- Nothing here yet.";
  return `# ${TITLES[path]}\n\n${body}\n`;
}

/** Keep dream prose and headings; only the ## Recent list is replaced. */
export function replaceRecentSection(memoryMd: string, recent: string[]): string {
  const lines = recent.slice(0, 12);
  const recentBlock = lines.length ? lines.map((line) => `- ${line}`).join("\n") : "- Nothing remembered yet.";
  const section = `## Recent\n\n${recentBlock}\n`;
  if (/## Recent\b/.test(memoryMd)) return memoryMd.replace(/## Recent\b[\s\S]*$/, section);
  const base = memoryMd.endsWith("\n") ? memoryMd : `${memoryMd}\n`;
  return `${base}\n${section}`;
}

/** Keep headings and other non-bullet lines; replace only `- ` facts. */
export function replaceTopicBullets(body: string, path: TopicPath, bullets: string[]): string {
  const bulletBlock = bullets.length ? bullets.map((bullet) => `- ${bullet}`).join("\n") : "- Nothing here yet.";
  const prefix: string[] = [];
  const suffix: string[] = [];
  let inBullets = false;
  for (const line of body.split("\n")) {
    if (/^- /.test(line)) {
      inBullets = true;
      continue;
    }
    if (!inBullets) prefix.push(line);
    else suffix.push(line);
  }
  let head = prefix.join("\n").replace(/\n+$/g, "");
  if (!head.trim()) head = `# ${TITLES[path]}`;
  const tail = suffix.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  return `${head}\n\n${bulletBlock}${tail ? `\n${tail}` : ""}\n`;
}

export function stripProvenance(text: string): string {
  return text.replace(/\s*\[source:[^\]]*\]\s*$/i, "").trim();
}

function normalizeBullet(text: string): string {
  return text
    .replace(/[\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.]+$/g, "")
    .trim();
}

export function bulletKey(text: string): string {
  return normalizeBullet(stripProvenance(text)).toLowerCase();
}

export function parseBullets(body: string): string[] {
  const bullets: string[] = [];
  for (const line of body.split("\n")) {
    const match = /^- (.+)$/.exec(line);
    if (!match) continue;
    const text = (match[1] ?? "").trim();
    if (!text || text === "Nothing here yet." || text === "Nothing remembered yet.") continue;
    bullets.push(text);
  }
  return bullets;
}

export function parseRecent(memoryMd: string): string[] {
  const section = memoryMd.split("## Recent")[1] ?? "";
  return parseBullets(section);
}

export type WriteResult = {
  files: Record<MemoryPath, string>;
  changed: boolean;
  message: string;
  added: MemoryWrite[];
};

export function commitMessage(writes: MemoryWrite[], evicted = 0): string {
  const bullets = writes.flatMap((write) => write.add.map(stripProvenance));
  let message: string;
  if (bullets.length === 1) {
    const text = bullets[0] ?? "a fact";
    const subject = text.length > 54 ? `${text.slice(0, 51)}…` : text;
    message = `Remember: ${subject}`;
  } else {
    message = `Remember ${bullets.length} facts`;
  }
  if (evicted > 0) message = `${message} (evicted ${evicted})`;
  return message;
}

function overlay(current: Record<string, string>): Record<MemoryPath, string> {
  const files = seedFiles();
  for (const path of MEMORY_PATHS) {
    const existing = current[path];
    if (typeof existing === "string" && existing.trim()) {
      files[path] = existing.endsWith("\n") ? existing : `${existing}\n`;
    }
  }
  return files;
}

/** Merge new bullets into the topic files and refresh ## Recent. Unchanged facts do not count as a commit. */
export function applyMemoryWrites(current: Record<string, string>, writes: MemoryWrite[], date: string): WriteResult {
  const files = overlay(current);
  const grouped = new Map<TopicPath, string[]>();
  for (const write of writes) {
    if (!isTopicPath(write.path)) continue;
    const list = grouped.get(write.path) ?? [];
    for (const raw of write.add) list.push(normalizeBullet(stripProvenance(raw)));
    grouped.set(write.path, list);
  }

  const added: MemoryWrite[] = [];
  let count = 0;
  let evicted = 0;
  for (const path of TOPIC_PATHS) {
    const incoming = grouped.get(path) ?? [];
    if (incoming.length === 0) continue;
    const existing = parseBullets(files[path]);
    const keys = new Set(existing.map(bulletKey));
    const fresh: string[] = [];
    for (const bullet of incoming) {
      if (count >= MAX_WRITES_PER_TURN) break;
      if (bullet.length < 3 || bullet.length > 180) continue;
      const key = bulletKey(bullet);
      if (!key || keys.has(key)) continue;
      const stamped = `${bullet} [source: chat; added: ${date}]`;
      keys.add(key);
      fresh.push(stamped);
      existing.push(stamped);
      count += 1;
    }
    if (fresh.length === 0) continue;
    if (existing.length > MAX_BULLETS_PER_FILE) evicted += existing.length - MAX_BULLETS_PER_FILE;
    files[path] = replaceTopicBullets(files[path], path, existing.slice(-MAX_BULLETS_PER_FILE));
    added.push({ path, add: fresh });
  }

  if (added.length === 0) return { files, changed: false, message: "", added: [] };

  const recent = [
    ...added.flatMap((write) => write.add.map((bullet) => `${date} ${stripProvenance(bullet)} (${write.path})`)),
    ...parseRecent(files["MEMORY.md"]),
  ].slice(0, 12);
  files["MEMORY.md"] = replaceRecentSection(files["MEMORY.md"], recent);

  for (const path of MEMORY_PATHS) {
    if (files[path].length > MAX_FILE_CHARS) return { files: overlay(current), changed: false, message: "", added: [] };
  }
  return { files, changed: true, message: commitMessage(added, evicted), added };
}

/** FTS indexes facts, not the MEMORY.md template boilerplate. */
export function indexableBody(path: string, body: string): string {
  if (path === "MEMORY.md") return parseRecent(body).join("\n");
  return parseBullets(body).join("\n");
}
