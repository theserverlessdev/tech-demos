import { KEEP_NEWEST_PER_ROOM, RETENTION_DAYS } from "../shared/types";
import { invalidateHealthCache, SEED_ATTACHMENT_ID } from "./db";

const SEED_MESSAGE_PREFIX = "msg_lobby_";

export type PruneResult = {
  deletedMessages: number;
  deletedAttachments: number;
  deletedRooms: number;
  deletedObjects: number;
};

export async function pruneOldData(env: Env, now = Date.now()): Promise<PruneResult> {
  const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deletedMessages = 0;
  let deletedAttachments = 0;
  let deletedRooms = 0;
  let deletedObjects = 0;

  const stale = await env.DB.prepare(`SELECT id FROM messages WHERE created_at < ? AND id NOT LIKE ?`)
    .bind(cutoff, `${SEED_MESSAGE_PREFIX}%`)
    .all<{ id: string }>();

  const overflow = await env.DB.prepare(
    `SELECT id FROM (
       SELECT id, ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY created_at DESC) AS rn
       FROM messages
       WHERE id NOT LIKE ?
     ) WHERE rn > ?`,
  )
    .bind(`${SEED_MESSAGE_PREFIX}%`, KEEP_NEWEST_PER_ROOM)
    .all<{ id: string }>();

  const dropIds = [...new Set([...(stale.results ?? []).map((r) => r.id), ...(overflow.results ?? []).map((r) => r.id)])];

  const attFromMessages = dropIds.length
    ? await env.DB.prepare(
        `SELECT a.id, a.r2_key FROM attachments a
         JOIN messages m ON m.attachment_id = a.id
         WHERE m.id IN (${dropIds.map(() => "?").join(",")}) AND a.id != ?`,
      )
        .bind(...dropIds, SEED_ATTACHMENT_ID)
        .all<{ id: string; r2_key: string }>()
    : { results: [] as { id: string; r2_key: string }[] };

  const attOld = await env.DB.prepare(
    `SELECT id, r2_key FROM attachments WHERE id != ? AND created_at < ? AND r2_key LIKE 'uploads/%'`,
  )
    .bind(SEED_ATTACHMENT_ID, cutoff)
    .all<{ id: string; r2_key: string }>();

  const attOrphan = await env.DB.prepare(
    `SELECT id, r2_key FROM attachments WHERE id != ? AND id NOT IN (SELECT attachment_id FROM messages WHERE attachment_id IS NOT NULL)`,
  )
    .bind(SEED_ATTACHMENT_ID)
    .all<{ id: string; r2_key: string }>();

  const attMap = new Map<string, string>();
  for (const row of [...(attFromMessages.results ?? []), ...(attOld.results ?? []), ...(attOrphan.results ?? [])]) {
    attMap.set(row.id, row.r2_key);
  }

  for (const [id, key] of attMap) {
    try {
      await env.FILES.delete(key);
      deletedObjects++;
    } catch (err) {
      console.error(JSON.stringify({ event: "r2_delete_failed", key, error: String(err) }));
    }
    await env.DB.prepare("UPDATE messages SET attachment_id = NULL WHERE attachment_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM attachments WHERE id = ?").bind(id).run();
    deletedAttachments++;
  }

  for (const id of dropIds) {
    await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(id).run();
    deletedMessages++;
  }

  await env.DB.prepare(
    `UPDATE rooms SET
      message_count = (SELECT COUNT(*) FROM messages WHERE room_id = rooms.id),
      last_preview = COALESCE((SELECT body FROM messages WHERE room_id = rooms.id ORDER BY created_at DESC LIMIT 1), ''),
      last_message_at = COALESCE((SELECT created_at FROM messages WHERE room_id = rooms.id ORDER BY created_at DESC LIMIT 1), 0)`,
  ).run();

  const empty = await env.DB.prepare(`SELECT id FROM rooms WHERE id != 'lobby' AND message_count = 0`).all<{ id: string }>();
  for (const row of empty.results ?? []) {
    await env.DB.prepare("DELETE FROM rooms WHERE id = ?").bind(row.id).run();
    deletedRooms++;
  }

  invalidateHealthCache();
  return { deletedMessages, deletedAttachments, deletedRooms, deletedObjects };
}
