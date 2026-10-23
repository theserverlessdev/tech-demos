import { LIMITS } from "../shared/limits";
import { dayKey } from "../shared/budget";

export type InboxRow = {
  id: string;
  visitor_id: string;
  ip_key: string;
  sample_id: string;
  title: string;
  state: string;
  fields_json: string;
  status: string;
  answers_json: string | null;
  corrections_json: string | null;
  source: string | null;
  error: string | null;
  state_text: string | null;
  truncated: number;
  created_at: number;
  updated_at: number;
};

const GLOBAL_KEY = "*";

const SPEND_SQL = `INSERT INTO spend (ip_key, day, calls)
SELECT ip_key, day, adding FROM (
  SELECT ?1 AS ip_key, ?2 AS day, ?3 AS adding
  UNION ALL
  SELECT '${GLOBAL_KEY}', ?2, ?3
)
WHERE COALESCE((SELECT calls FROM spend WHERE ip_key = ?1 AND day = ?2), 0) + ?3 <= ?4
  AND COALESCE((SELECT calls FROM spend WHERE ip_key = '${GLOBAL_KEY}' AND day = ?2), 0) + ?3 <= ?5
ON CONFLICT(ip_key, day) DO UPDATE SET calls = calls + excluded.calls
WHERE spend.calls + excluded.calls <= CASE WHEN spend.ip_key = '${GLOBAL_KEY}' THEN ?5 ELSE ?4 END`;

export type ReserveResult = "ok" | "ip" | "global";

/** One statement reserves the per-network row and the shared '*' row, or neither. */
export async function reserveCalls(
  db: D1Database,
  ipKey: string,
  now: number,
  adding: number,
  cap = LIMITS.dailyCalls,
  globalCap = LIMITS.dailyGlobalCalls,
): Promise<ReserveResult> {
  const day = dayKey(now);
  const result = await db.prepare(SPEND_SQL).bind(ipKey, day, adding, cap, globalCap).run();
  if ((result.meta.changes ?? 0) > 0) return "ok";
  const globalUsed = await spendUsed(db, GLOBAL_KEY, now);
  if (globalUsed + adding > globalCap) return "global";
  return "ip";
}

export async function spendUsed(db: D1Database, ipKey: string, now: number): Promise<number> {
  const row = await db.prepare("SELECT calls FROM spend WHERE ip_key = ? AND day = ?").bind(ipKey, dayKey(now)).first<{ calls: number }>();
  return row?.calls ?? 0;
}

export async function insertUpload(env: Env, row: { id: string; visitorId: string; key: string; contentType: string; bytes: number; now: number }): Promise<void> {
  await env.DB.prepare("INSERT INTO uploads (id, visitor_id, r2_key, content_type, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(row.id, row.visitorId, row.key, row.contentType, row.bytes, row.now).run();
}

const INBOX_INSERT = `INSERT INTO inbox (id, visitor_id, ip_key, sample_id, title, state, fields_json, status, answers_json, corrections_json, source, error, state_text, truncated, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, NULL, NULL, 0, ?, ?)`;

export function inboxInsert(
  env: Env,
  row: {
    id: string;
    visitorId: string;
    ipKey: string;
    sampleId: string;
    title: string;
    state: string;
    fieldsJson: string;
    now: number;
  },
): D1PreparedStatement {
  return env.DB.prepare(INBOX_INSERT).bind(row.id, row.visitorId, row.ipKey, row.sampleId, row.title, row.state, row.fieldsJson, row.now, row.now);
}

export async function refundCalls(db: D1Database, ipKey: string, now: number, calls: number): Promise<void> {
  await db.prepare("UPDATE spend SET calls = MAX(0, calls - ?) WHERE ip_key IN (?, ?) AND day = ?").bind(calls, ipKey, GLOBAL_KEY, dayKey(now)).run();
}

export async function getInbox(env: Env, id: string): Promise<InboxRow | null> {
  return env.DB.prepare("SELECT * FROM inbox WHERE id = ?").bind(id).first<InboxRow>();
}

export async function listInbox(env: Env, visitorId: string): Promise<InboxRow[]> {
  const result = await env.DB.prepare("SELECT * FROM inbox WHERE visitor_id = ? ORDER BY created_at DESC LIMIT 40").bind(visitorId).all<InboxRow>();
  return result.results ?? [];
}

export async function claimInbox(env: Env, id: string, now: number): Promise<boolean> {
  const stale = now - LIMITS.leaseMs;
  const result = await env.DB.prepare(
    "UPDATE inbox SET status = 'running', updated_at = ? WHERE id = ? AND (status = 'queued' OR (status = 'running' AND updated_at < ?))",
  )
    .bind(now, id, stale)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function saveInboxResult(
  env: Env,
  id: string,
  answersJson: string,
  source: string,
  stateText: string,
  truncated: boolean,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE inbox SET status = 'review', answers_json = ?, source = ?, state_text = ?, truncated = ?, error = NULL, updated_at = ? WHERE id = ? AND status = 'running'",
  )
    .bind(answersJson, source, stateText, truncated ? 1 : 0, now, id)
    .run();
}

export async function releaseInbox(env: Env, id: string, error: string, now: number): Promise<void> {
  await env.DB.prepare("UPDATE inbox SET status = 'queued', error = ?, updated_at = ? WHERE id = ? AND status = 'running'").bind(error.slice(0, 200), now, id).run();
}

export async function failInbox(env: Env, id: string, error: string, now: number): Promise<void> {
  await failInboxIds(env, [id], error, now);
}

export async function failInboxIds(env: Env, ids: string[], error: string, now: number): Promise<void> {
  if (!ids.length) return;
  const marks = ids.map(() => "?").join(", ");
  await env.DB.prepare(
    `UPDATE inbox SET status = 'failed', error = ?, updated_at = ? WHERE id IN (${marks}) AND status IN ('running', 'queued')`,
  )
    .bind(error.slice(0, 80), now, ...ids)
    .run();
}

export async function reviewInbox(env: Env, id: string, visitorId: string, correctionsJson: string | null, now: number): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE inbox SET status = 'accepted', corrections_json = COALESCE(?, corrections_json), updated_at = ? WHERE id = ? AND visitor_id = ? AND status IN ('review', 'accepted')",
  )
    .bind(correctionsJson, now, id, visitorId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function cleanupExpired(env: Env, now: number): Promise<{ uploads: number; inbox: number; objects: number }> {
  const cutoff = now - LIMITS.retentionMs;
  const oldDay = new Date(now - 2 * LIMITS.retentionMs).toISOString().slice(0, 10);
  const uploads = await env.DB.prepare("DELETE FROM uploads WHERE created_at < ?").bind(cutoff).run();
  const inbox = await env.DB.prepare("DELETE FROM inbox WHERE created_at < ?").bind(cutoff).run();
  await env.DB.prepare("DELETE FROM spend WHERE day < ?").bind(oldDay).run();
  let objects = 0;
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const listed = await env.BUCKET.list({ prefix: "intake/", cursor, limit: 200 });
    for (const object of listed.objects) {
      if (now - object.uploaded.getTime() < LIMITS.retentionMs) continue;
      await env.BUCKET.delete(object.key);
      objects += 1;
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  return { uploads: uploads.meta.changes ?? 0, inbox: inbox.meta.changes ?? 0, objects };
}
