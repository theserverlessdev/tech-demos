import { LIMITS } from "../shared/limits";
import { SEED_MESSAGE_IDS, SEED_R2_KEY, SEED_TICKETS, ensureSeed } from "./db";

export const R2_DELETE_LIMIT = 1000;

export function chunkKeys(keys: string[], size = R2_DELETE_LIMIT): string[][] {
  const unique = [...new Set(keys.filter((key) => key && key !== SEED_R2_KEY))];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += size) chunks.push(unique.slice(i, i + size));
  return chunks;
}

async function deleteKeys(env: Env, keys: string[]): Promise<number> {
  let removed = 0;
  for (const chunk of chunkKeys(keys)) {
    if (!chunk.length) continue;
    await env.ATTACHMENTS.delete(chunk);
    removed += chunk.length;
  }
  return removed;
}

async function deletePrefixOlderThan(env: Env, prefix: string, cutoff: number): Promise<number> {
  let removed = 0;
  let cursor: string | undefined;
  do {
    const page = await env.ATTACHMENTS.list({ prefix, cursor });
    const stale = page.objects.filter((obj) => (obj.uploaded?.getTime() ?? 0) < cutoff && obj.key !== SEED_R2_KEY).map((obj) => obj.key);
    removed += await deleteKeys(env, stale);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return removed;
}

export async function sweep(env: Env, now = Date.now()): Promise<{
  tickets: number;
  attachments: number;
  objects: number;
  visitors: number;
  leakedPublic: number;
  seedsRestored: number;
}> {
  await ensureSeed(env);
  const cutoff = now - LIMITS.retainMs;
  const seedIds = SEED_TICKETS.map((t) => t.id);
  const placeholders = seedIds.map(() => "?").join(",");
  const seedMsgMarks = SEED_MESSAGE_IDS.map(() => "?").join(",");
  const dropTickets = `(visitor_id IS NOT NULL AND created_at < ?) OR (visitor_id IS NULL AND id NOT IN (${placeholders}))`;

  const staleTickets = await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE visitor_id IS NOT NULL AND created_at < ?")
    .bind(cutoff)
    .first<{ n: number }>();
  const leakedPublic = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE visitor_id IS NULL AND id NOT IN (${placeholders})`)
    .bind(...seedIds)
    .first<{ n: number }>();

  const staleAtt = await env.DB.prepare(
    `SELECT r2_key FROM attachments
     WHERE created_at < ? AND id != 'att_billing_seed' AND (visitor_id IS NOT NULL OR ticket_id IN (${placeholders}))`,
  )
    .bind(cutoff, ...seedIds)
    .all<{ r2_key: string }>();

  const leakedAtt = await env.DB.prepare("SELECT r2_key FROM attachments WHERE visitor_id IS NULL AND id != 'att_billing_seed'").all<{
    r2_key: string;
  }>();

  await deleteKeys(env, [...(staleAtt.results ?? []).map((row) => row.r2_key), ...(leakedAtt.results ?? []).map((row) => row.r2_key)]);

  const statements = [
    env.DB.prepare(`DELETE FROM attachments WHERE ticket_id IN (SELECT id FROM tickets WHERE ${dropTickets})`).bind(cutoff, ...seedIds),
    env.DB.prepare(`DELETE FROM messages WHERE ticket_id IN (SELECT id FROM tickets WHERE ${dropTickets})`).bind(cutoff, ...seedIds),
    env.DB.prepare(
      `DELETE FROM attachments WHERE created_at < ? AND id != 'att_billing_seed' AND (visitor_id IS NOT NULL OR ticket_id IN (${placeholders}))`,
    ).bind(cutoff, ...seedIds),
    env.DB.prepare("DELETE FROM attachments WHERE visitor_id IS NULL AND id != 'att_billing_seed'"),
    env.DB.prepare(`DELETE FROM messages WHERE ticket_id IN (${placeholders}) AND id NOT IN (${seedMsgMarks})`).bind(
      ...seedIds,
      ...SEED_MESSAGE_IDS,
    ),
    env.DB.prepare(`DELETE FROM messages WHERE visitor_id IS NULL AND id NOT IN (${seedMsgMarks})`).bind(...SEED_MESSAGE_IDS),
    env.DB.prepare("DELETE FROM tickets WHERE visitor_id IS NOT NULL AND created_at < ?").bind(cutoff),
    env.DB.prepare(`DELETE FROM tickets WHERE visitor_id IS NULL AND id NOT IN (${placeholders})`).bind(...seedIds),
  ];
  for (const seed of SEED_TICKETS) {
    statements.push(
      env.DB.prepare("UPDATE tickets SET status = ?, priority = ?, assignee = ?, updated_at = ? WHERE id = ?").bind(
        seed.status,
        seed.priority,
        seed.assignee,
        seed.updatedAt,
        seed.id,
      ),
    );
  }
  statements.push(env.DB.prepare("DELETE FROM drafts WHERE created_at < ?").bind(cutoff));
  const staleVisitors = await env.DB.prepare("SELECT COUNT(*) AS n FROM visitors WHERE last_seen_at < ?")
    .bind(cutoff)
    .first<{ n: number }>();
  statements.push(env.DB.prepare("DELETE FROM visitors WHERE last_seen_at < ?").bind(cutoff));
  await env.DB.batch(statements);

  const objects = await deletePrefixOlderThan(env, "tickets/", cutoff);
  return {
    tickets: staleTickets?.n ?? 0,
    attachments: staleAtt.results?.length ?? 0,
    objects,
    visitors: staleVisitors?.n ?? 0,
    leakedPublic: leakedPublic?.n ?? 0,
    seedsRestored: SEED_TICKETS.length,
  };
}
