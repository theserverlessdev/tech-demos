import { LIMITS } from "../shared/limits";
import { SEED_R2_KEY, SEED_TICKETS, ensureSeed } from "./db";

const SEED_MESSAGE_IDS = [
  "msg_billing_1",
  "msg_billing_2",
  "msg_sso_1",
  "msg_sso_2",
  "msg_cron_1",
  "msg_cron_2",
  "msg_webhooks_1",
  "msg_webhooks_2",
  "msg_docs_1",
  "msg_docs_2",
];

async function deletePrefixOlderThan(env: Env, prefix: string, cutoff: number): Promise<number> {
  let removed = 0;
  let cursor: string | undefined;
  do {
    const page = await env.ATTACHMENTS.list({ prefix, cursor });
    const stale = page.objects.filter((obj) => (obj.uploaded?.getTime() ?? 0) < cutoff && obj.key !== SEED_R2_KEY);
    await Promise.all(stale.map((obj) => env.ATTACHMENTS.delete(obj.key)));
    removed += stale.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return removed;
}

export async function sweep(env: Env, now = Date.now()): Promise<{
  tickets: number;
  attachments: number;
  objects: number;
  seedsRestored: number;
}> {
  await ensureSeed(env);
  const cutoff = now - LIMITS.retainMs;
  const seedIds = SEED_TICKETS.map((t) => t.id);
  const placeholders = seedIds.map(() => "?").join(",");

  const staleTickets = await env.DB.prepare("SELECT id FROM tickets WHERE visitor_id IS NOT NULL AND created_at < ?")
    .bind(cutoff)
    .all<{ id: string }>();
  const staleIds = (staleTickets.results ?? []).map((row) => row.id);

  const staleAtt = await env.DB.prepare(
    `SELECT id, r2_key FROM attachments
     WHERE created_at < ? AND id != 'att_billing_seed' AND (visitor_id IS NOT NULL OR ticket_id IN (${placeholders}))`,
  )
    .bind(cutoff, ...seedIds)
    .all<{ id: string; r2_key: string }>();

  for (const row of staleAtt.results ?? []) {
    if (row.r2_key !== SEED_R2_KEY) await env.ATTACHMENTS.delete(row.r2_key);
  }

  const statements = [];
  if (staleIds.length) {
    const marks = staleIds.map(() => "?").join(",");
    statements.push(env.DB.prepare(`DELETE FROM attachments WHERE ticket_id IN (${marks})`).bind(...staleIds));
    statements.push(env.DB.prepare(`DELETE FROM messages WHERE ticket_id IN (${marks})`).bind(...staleIds));
    statements.push(env.DB.prepare(`DELETE FROM tickets WHERE id IN (${marks})`).bind(...staleIds));
  }
  statements.push(
    env.DB.prepare(
      `DELETE FROM attachments WHERE created_at < ? AND id != 'att_billing_seed' AND (visitor_id IS NOT NULL OR ticket_id IN (${placeholders}))`,
    ).bind(cutoff, ...seedIds),
  );
  const seedMsgMarks = SEED_MESSAGE_IDS.map(() => "?").join(",");
  statements.push(
    env.DB.prepare(`DELETE FROM messages WHERE ticket_id IN (${placeholders}) AND id NOT IN (${seedMsgMarks})`).bind(
      ...seedIds,
      ...SEED_MESSAGE_IDS,
    ),
  );
  for (const seed of SEED_TICKETS) {
    statements.push(
      env.DB.prepare("UPDATE tickets SET status = ?, priority = ?, assignee = ? WHERE id = ?").bind(
        seed.status,
        seed.priority,
        seed.assignee,
        seed.id,
      ),
    );
  }
  statements.push(env.DB.prepare("DELETE FROM drafts WHERE created_at < ?").bind(cutoff));
  if (statements.length) await env.DB.batch(statements);

  const objects = await deletePrefixOlderThan(env, "tickets/", cutoff);
  return {
    tickets: staleIds.length,
    attachments: staleAtt.results?.length ?? 0,
    objects,
    seedsRestored: SEED_TICKETS.length,
  };
}
