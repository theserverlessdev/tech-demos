import type { RecallHit } from "../shared/types";

export type FtsDb = {
  exec(sql: string, ...params: (string | number)[]): void;
  all(sql: string, ...params: (string | number)[]): Record<string, unknown>[];
};

/** Quoted tokens only, so user text cannot change the MATCH syntax. */
export function ftsMatch(raw: string): string | null {
  const words = raw.toLowerCase().match(/[a-z0-9]{2,24}/g);
  if (!words || words.length === 0) return null;
  return [...new Set(words)].slice(0, 8).map((word) => `"${word}"`).join(" OR ");
}

export function ensureFts(db: FtsDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(path, body, tokenize = 'porter unicode61')");
}

export function replaceIndexedFiles(db: FtsDb, files: Record<string, string>, now: number): void {
  db.exec("DELETE FROM memory_fts");
  db.exec("DELETE FROM files");
  for (const [path, body] of Object.entries(files)) {
    db.exec("INSERT INTO files (path, body, updated_at) VALUES (?, ?, ?)", path, body, now);
    db.exec("INSERT INTO memory_fts (path, body) VALUES (?, ?)", path, body);
  }
}

export function recall(db: FtsDb, query: string, limit = 5): RecallHit[] {
  const match = ftsMatch(query);
  if (!match) return [];
  const safeLimit = Math.max(1, Math.min(8, Math.floor(limit)));
  const rows = db.all(
    `SELECT path, snippet(memory_fts, 1, '', '', '…', 12) AS snippet, bm25(memory_fts) AS score
     FROM memory_fts WHERE memory_fts MATCH ? ORDER BY score LIMIT ?`,
    match,
    safeLimit,
  );
  return rows
    .filter((row) => typeof row.path === "string")
    .map((row) => ({
      path: String(row.path),
      snippet: typeof row.snippet === "string" ? row.snippet : "",
      score: typeof row.score === "number" ? row.score : 0,
    }));
}
