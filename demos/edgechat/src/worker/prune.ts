import { KEEP_NEWEST_PER_ROOM, RETENTION_DAYS } from "../shared/types";
import { invalidateHealthCache, SEED_ATTACHMENT_ID } from "./db";

const SEED_MESSAGE_PREFIX = "msg_lobby_";
/** D1 allows 100 bound parameters. Stay under that on every statement. */
const BATCH = 90;
/** A cron tick between upload and the message insert must not delete the file. */
const ORPHAN_GRACE_MS = 10 * 60 * 1000;

export type PruneResult = {
  deletedMessages: number;
  deletedAttachments: number;
  deletedRooms: number;
  deletedObjects: number;
};

type IdRow = { id: string };
type AttachmentRow = { id: string; r2_key: string };

export async function pruneOldData(env: Env, now = Date.now()): Promise<PruneResult> {
  const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deletedMessages = 0;
  let deletedAttachments = 0;
  let deletedObjects = 0;

  const staleSql = `SELECT id FROM messages WHERE created_at < ? AND id NOT LIKE ? ORDER BY created_at LIMIT ?`;
  for (;;) {
    const ids = await idsOf(env, staleSql, [cutoff, `${SEED_MESSAGE_PREFIX}%`, BATCH]);
    if (!ids.length) break;
    const dropped = await dropMessages(env, ids);
    deletedMessages += ids.length;
    deletedAttachments += dropped.attachments;
    deletedObjects += dropped.objects;
    if (ids.length < BATCH) break;
  }

  const overflowSql = `SELECT id FROM (
       SELECT id, ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY created_at DESC) AS rn
       FROM messages
       WHERE id NOT LIKE ?
     ) WHERE rn > ? LIMIT ?`;
  for (;;) {
    const ids = await idsOf(env, overflowSql, [`${SEED_MESSAGE_PREFIX}%`, KEEP_NEWEST_PER_ROOM, BATCH]);
    if (!ids.length) break;
    const dropped = await dropMessages(env, ids);
    deletedMessages += ids.length;
    deletedAttachments += dropped.attachments;
    deletedObjects += dropped.objects;
    if (ids.length < BATCH) break;
  }

  const oldSql = `SELECT id, r2_key FROM attachments WHERE id != ? AND created_at < ? AND r2_key LIKE 'uploads/%' ORDER BY created_at LIMIT ?`;
  for (;;) {
    const rows = await rowsOf(env, oldSql, [SEED_ATTACHMENT_ID, cutoff, BATCH]);
    if (!rows.length) break;
    const dropped = await dropAttachments(env, rows);
    deletedAttachments += dropped.attachments;
    deletedObjects += dropped.objects;
    if (rows.length < BATCH) break;
  }

  const orphanBefore = now - ORPHAN_GRACE_MS;
  const orphanSql = `SELECT id, r2_key FROM attachments
     WHERE id != ? AND created_at < ?
       AND id NOT IN (SELECT attachment_id FROM messages WHERE attachment_id IS NOT NULL)
     ORDER BY created_at LIMIT ?`;
  for (;;) {
    const rows = await rowsOf(env, orphanSql, [SEED_ATTACHMENT_ID, orphanBefore, BATCH]);
    if (!rows.length) break;
    const dropped = await dropAttachments(env, rows);
    deletedAttachments += dropped.attachments;
    deletedObjects += dropped.objects;
    if (rows.length < BATCH) break;
  }

  await env.DB.prepare(
    `UPDATE rooms SET
      message_count = (SELECT COUNT(*) FROM messages WHERE room_id = rooms.id),
      last_preview = COALESCE((SELECT body FROM messages WHERE room_id = rooms.id ORDER BY created_at DESC LIMIT 1), ''),
      last_message_at = COALESCE((SELECT created_at FROM messages WHERE room_id = rooms.id ORDER BY created_at DESC LIMIT 1), 0)`,
  ).run();

  const removed = await env.DB.prepare(
    `DELETE FROM rooms WHERE id != 'lobby' AND created_at < ? AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.room_id = rooms.id)`,
  )
    .bind(cutoff)
    .run();

  invalidateHealthCache();
  return { deletedMessages, deletedAttachments, deletedRooms: removed.meta.changes ?? 0, deletedObjects };
}

async function idsOf(env: Env, sql: string, params: unknown[]): Promise<string[]> {
  const rows = await env.DB.prepare(sql).bind(...params).all<IdRow>();
  return (rows.results ?? []).map((row) => row.id);
}

async function rowsOf(env: Env, sql: string, params: unknown[]): Promise<AttachmentRow[]> {
  const rows = await env.DB.prepare(sql).bind(...params).all<AttachmentRow>();
  return rows.results ?? [];
}

async function dropMessages(env: Env, ids: string[]): Promise<{ attachments: number; objects: number }> {
  const marks = ids.map(() => "?").join(", ");
  const linked = await env.DB.prepare(
    `SELECT a.id, a.r2_key FROM attachments a
     JOIN messages m ON m.attachment_id = a.id
     WHERE m.id IN (${marks}) AND a.id != ?`,
  )
    .bind(...ids, SEED_ATTACHMENT_ID)
    .all<AttachmentRow>();
  const dropped = await dropAttachments(env, linked.results ?? []);
  await env.DB.batch([env.DB.prepare(`DELETE FROM messages WHERE id IN (${marks})`).bind(...ids)]);
  return dropped;
}

async function dropAttachments(env: Env, rows: AttachmentRow[]): Promise<{ attachments: number; objects: number }> {
  if (!rows.length) return { attachments: 0, objects: 0 };
  let objects = 0;
  for (const row of rows) {
    try {
      await env.FILES.delete(row.r2_key);
      objects++;
    } catch (err) {
      console.error(JSON.stringify({ event: "r2_delete_failed", key: row.r2_key, error: String(err) }));
    }
  }
  const ids = rows.map((row) => row.id);
  const marks = ids.map(() => "?").join(", ");
  await env.DB.batch([
    env.DB.prepare(`UPDATE messages SET attachment_id = NULL WHERE attachment_id IN (${marks})`).bind(...ids),
    env.DB.prepare(`DELETE FROM attachments WHERE id IN (${marks})`).bind(...ids),
  ]);
  return { attachments: rows.length, objects };
}
