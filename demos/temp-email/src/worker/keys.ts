import type { KeyInfo } from "../shared/types";
import { KEY_CREATE_LIMIT, KEY_INBOX_LIMIT, KEY_WINDOW_MS } from "./limits";

export type ApiKeyRow = {
  id: string;
  name: string;
  key_hash: string;
  created_at: number;
  last_used_at: number | null;
  revoked: number;
  inbox_limit: number;
  create_limit: number;
  window_start: number;
  window_creates: number;
};

export async function insertApiKey(
  db: D1Database,
  row: { id: string; name: string; key_hash: string; created_at: number },
): Promise<ApiKeyRow> {
  await db
    .prepare(
      `INSERT INTO api_keys (id, name, key_hash, created_at, inbox_limit, create_limit, window_start, window_creates)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .bind(row.id, row.name, row.key_hash, row.created_at, KEY_INBOX_LIMIT, KEY_CREATE_LIMIT, row.created_at)
    .run();
  const stored = await findKeyById(db, row.id);
  if (!stored) throw new Error("API key insert returned no row");
  return stored;
}

export async function findKeyByHash(db: D1Database, keyHash: string): Promise<ApiKeyRow | null> {
  return db.prepare("SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0").bind(keyHash).first<ApiKeyRow>();
}

export async function findKeyById(db: D1Database, id: string): Promise<ApiKeyRow | null> {
  return db.prepare("SELECT * FROM api_keys WHERE id = ?").bind(id).first<ApiKeyRow>();
}

export async function touchKey(db: D1Database, id: string, now: number): Promise<void> {
  await db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now, id).run();
}

export async function revokeKey(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare("UPDATE api_keys SET revoked = 1 WHERE id = ? AND revoked = 0").bind(id).run();
  return result.meta.changes > 0;
}

export async function countActiveInboxes(db: D1Database, keyId: string, now = Date.now()): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM inboxes WHERE api_key_id = ? AND expires_at > ?")
    .bind(keyId, now)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Returns false when the rolling 24h create window is full. */
export async function consumeCreateQuota(db: D1Database, key: ApiKeyRow, now = Date.now()): Promise<boolean> {
  let windowStart = key.window_start;
  let windowCreates = key.window_creates;
  if (now - windowStart >= KEY_WINDOW_MS) {
    windowStart = now;
    windowCreates = 0;
  }
  if (windowCreates >= key.create_limit) return false;
  await db
    .prepare("UPDATE api_keys SET window_start = ?, window_creates = ? WHERE id = ?")
    .bind(windowStart, windowCreates + 1, key.id)
    .run();
  return true;
}

export async function toKeyInfo(db: D1Database, key: ApiKeyRow): Promise<KeyInfo> {
  const now = Date.now();
  const windowCreates = now - key.window_start >= KEY_WINDOW_MS ? 0 : key.window_creates;
  return {
    id: key.id,
    name: key.name,
    createdAt: key.created_at,
    lastUsedAt: key.last_used_at,
    revoked: key.revoked === 1,
    inboxLimit: key.inbox_limit,
    activeInboxes: await countActiveInboxes(db, key.id, now),
    createLimit: key.create_limit,
    createsInWindow: windowCreates,
  };
}
