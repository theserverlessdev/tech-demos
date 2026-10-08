import type {
  AgentRow,
  ApiKeyRow,
  AuditRow,
  DraftRow,
  InboxRow,
  MessageRow,
  PolicyName,
  QuarantineRow,
  SettingsRow,
  ThreadRow,
  UserRow,
} from "./types";
import { newId } from "./util";

export async function getSettings(db: D1Database): Promise<SettingsRow> {
  const row = await db.prepare("SELECT * FROM settings WHERE id = 1").first<SettingsRow>();
  if (!row) throw new Error("settings row is missing");
  return row;
}

export async function updateSettings(
  db: D1Database,
  fields: { global_kill: number; unknown_policy: SettingsRow["unknown_policy"]; spam_ttl_days: number },
): Promise<void> {
  await db
    .prepare("UPDATE settings SET global_kill = ?, unknown_policy = ?, spam_ttl_days = ? WHERE id = 1")
    .bind(fields.global_kill, fields.unknown_policy, fields.spam_ttl_days)
    .run();
}

export async function getUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>();
}

export async function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export async function insertUser(
  db: D1Database,
  row: { id: string; email: string; role: UserRow["role"]; display_name: string | null; invited_by: string | null; created_at: number },
): Promise<UserRow> {
  const stored = await db
    .prepare(
      `INSERT INTO users (id, email, role, display_name, invited_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(row.id, row.email, row.role, row.display_name, row.invited_by, row.created_at)
    .first<UserRow>();
  if (!stored) throw new Error("user insert returned no row");
  return stored;
}

export async function listUsers(db: D1Database): Promise<UserRow[]> {
  const { results } = await db.prepare("SELECT * FROM users ORDER BY created_at ASC").all<UserRow>();
  return results;
}

export async function setUserDisabled(db: D1Database, id: string, disabled: number): Promise<void> {
  await db.prepare("UPDATE users SET disabled = ? WHERE id = ?").bind(disabled, id).run();
}

export async function countAdmins(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").first<{ n: number }>();
  return row?.n ?? 0;
}

export async function insertAgent(
  db: D1Database,
  row: { id: string; owner_user_id: string; name: string; policy: PolicyName; daily_send_cap: number; created_at: number },
): Promise<AgentRow> {
  const stored = await db
    .prepare(
      `INSERT INTO agents (id, owner_user_id, name, policy, daily_send_cap, created_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(row.id, row.owner_user_id, row.name, row.policy, row.daily_send_cap, row.created_at)
    .first<AgentRow>();
  if (!stored) throw new Error("agent insert returned no row");
  return stored;
}

export async function getAgent(db: D1Database, id: string): Promise<AgentRow | null> {
  return db.prepare("SELECT * FROM agents WHERE id = ?").bind(id).first<AgentRow>();
}

export async function listAgents(db: D1Database, user: UserRow): Promise<AgentRow[]> {
  if (user.role === "admin") {
    const { results } = await db.prepare("SELECT * FROM agents ORDER BY created_at DESC").all<AgentRow>();
    return results;
  }
  const { results } = await db
    .prepare("SELECT * FROM agents WHERE owner_user_id = ? ORDER BY created_at DESC")
    .bind(user.id)
    .all<AgentRow>();
  return results;
}

export async function updateAgent(
  db: D1Database,
  id: string,
  fields: { name: string; policy: PolicyName; daily_send_cap: number; kill_switch: number; webhook_url: string | null },
): Promise<void> {
  await db
    .prepare("UPDATE agents SET name = ?, policy = ?, daily_send_cap = ?, kill_switch = ?, webhook_url = ? WHERE id = ?")
    .bind(fields.name, fields.policy, fields.daily_send_cap, fields.kill_switch, fields.webhook_url, id)
    .run();
}

export async function setWebhookSecret(db: D1Database, id: string, secretEnc: string | null, url: string | null): Promise<void> {
  await db.prepare("UPDATE agents SET webhook_secret_enc = ?, webhook_url = ? WHERE id = ?").bind(secretEnc, url, id).run();
}

export async function insertInbox(
  db: D1Database,
  row: {
    id: string;
    agent_id: string;
    local_part: string;
    display_name: string | null;
    policy_override: PolicyName | null;
    daily_send_cap: number | null;
    created_at: number;
  },
): Promise<InboxRow> {
  const stored = await db
    .prepare(
      `INSERT INTO inboxes (id, agent_id, local_part, display_name, policy_override, daily_send_cap, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(row.id, row.agent_id, row.local_part, row.display_name, row.policy_override, row.daily_send_cap, row.created_at)
    .first<InboxRow>();
  if (!stored) throw new Error("inbox insert returned no row");
  return stored;
}

export async function getInbox(db: D1Database, id: string): Promise<InboxRow | null> {
  return db.prepare("SELECT * FROM inboxes WHERE id = ?").bind(id).first<InboxRow>();
}

export async function getInboxByLocalPart(db: D1Database, localPart: string): Promise<InboxRow | null> {
  return db.prepare("SELECT * FROM inboxes WHERE local_part = ?").bind(localPart).first<InboxRow>();
}

export async function listInboxes(db: D1Database, agentId: string): Promise<InboxRow[]> {
  const { results } = await db.prepare("SELECT * FROM inboxes WHERE agent_id = ? ORDER BY created_at ASC").bind(agentId).all<InboxRow>();
  return results;
}

export async function updateInbox(
  db: D1Database,
  id: string,
  fields: {
    display_name: string | null;
    policy_override: PolicyName | null;
    daily_send_cap: number | null;
    list_mode: InboxRow["list_mode"];
    allowlist: string;
    blocklist: string;
    status: InboxRow["status"];
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE inboxes SET display_name = ?, policy_override = ?, daily_send_cap = ?, list_mode = ?, allowlist = ?, blocklist = ?, status = ?
       WHERE id = ?`,
    )
    .bind(
      fields.display_name,
      fields.policy_override,
      fields.daily_send_cap,
      fields.list_mode,
      fields.allowlist,
      fields.blocklist,
      fields.status,
      id,
    )
    .run();
}

export async function insertApiKey(
  db: D1Database,
  row: { id: string; agent_id: string; name: string; key_hash: string; key_hint: string; created_at: number },
): Promise<ApiKeyRow> {
  const stored = await db
    .prepare(
      `INSERT INTO api_keys (id, agent_id, name, key_hash, key_hint, created_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(row.id, row.agent_id, row.name, row.key_hash, row.key_hint, row.created_at)
    .first<ApiKeyRow>();
  if (!stored) throw new Error("key insert returned no row");
  return stored;
}

export async function getKeyByHash(db: D1Database, keyHash: string): Promise<ApiKeyRow | null> {
  return db.prepare("SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL").bind(keyHash).first<ApiKeyRow>();
}

export async function getKey(db: D1Database, id: string): Promise<ApiKeyRow | null> {
  return db.prepare("SELECT * FROM api_keys WHERE id = ?").bind(id).first<ApiKeyRow>();
}

export async function listKeys(db: D1Database, agentId: string): Promise<ApiKeyRow[]> {
  const { results } = await db.prepare("SELECT * FROM api_keys WHERE agent_id = ? ORDER BY created_at DESC").bind(agentId).all<ApiKeyRow>();
  return results;
}

export async function touchKey(db: D1Database, id: string, now: number): Promise<void> {
  await db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now, id).run();
}

export async function revokeKey(db: D1Database, id: string, now: number): Promise<void> {
  await db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, id).run();
}

export async function insertThread(
  db: D1Database,
  row: { id: string; inbox_id: string; subject: string; started_by: ThreadRow["started_by"]; now: number },
): Promise<ThreadRow> {
  const stored = await db
    .prepare(
      `INSERT INTO threads (id, inbox_id, subject, started_by, last_message_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(row.id, row.inbox_id, row.subject, row.started_by, row.now, row.now)
    .first<ThreadRow>();
  if (!stored) throw new Error("thread insert returned no row");
  return stored;
}

export async function getThread(db: D1Database, id: string): Promise<ThreadRow | null> {
  return db.prepare("SELECT * FROM threads WHERE id = ?").bind(id).first<ThreadRow>();
}

export async function listThreads(db: D1Database, inboxId: string, limit: number): Promise<ThreadRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM threads WHERE inbox_id = ? ORDER BY last_message_at DESC LIMIT ?")
    .bind(inboxId, limit)
    .all<ThreadRow>();
  return results;
}

export async function touchThread(db: D1Database, id: string, subject: string, now: number): Promise<void> {
  await db.prepare("UPDATE threads SET last_message_at = ?, subject = ? WHERE id = ?").bind(now, subject, id).run();
}

export async function findThreadByMessageIds(db: D1Database, inboxId: string, ids: string[]): Promise<string | null> {
  if (!ids.length) return null;
  const marks = ids.map(() => "?").join(", ");
  const row = await db
    .prepare(`SELECT thread_id FROM messages WHERE inbox_id = ? AND message_id IN (${marks}) ORDER BY seq ASC LIMIT 1`)
    .bind(inboxId, ...ids)
    .first<{ thread_id: string }>();
  return row?.thread_id ?? null;
}

export async function listThreadMessageIds(db: D1Database, threadId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT message_id FROM messages WHERE thread_id = ? AND message_id IS NOT NULL ORDER BY seq ASC")
    .bind(threadId)
    .all<{ message_id: string }>();
  return results.map((row) => row.message_id);
}

export async function latestMessage(db: D1Database, threadId: string): Promise<MessageRow | null> {
  return db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT 1").bind(threadId).first<MessageRow>();
}

export async function listMessagesByThread(db: D1Database, threadId: string): Promise<MessageRow[]> {
  const { results } = await db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY seq ASC").bind(threadId).all<MessageRow>();
  return results;
}

type NewMessage = Omit<MessageRow, "seq">;

export async function insertMessage(db: D1Database, row: NewMessage): Promise<MessageRow> {
  const stored = await db
    .prepare(
      `INSERT INTO messages (
        id, thread_id, inbox_id, direction, via, received_at, envelope_from, from_name, from_address,
        to_addrs, cc_addrs, subject, snippet, text_body, html_body, truncated, raw_size, raw_r2_key,
        message_id, in_reply_to, references_header, date_header, spam, attachments, provider_message_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *`,
    )
    .bind(
      row.id,
      row.thread_id,
      row.inbox_id,
      row.direction,
      row.via,
      row.received_at,
      row.envelope_from,
      row.from_name,
      row.from_address,
      row.to_addrs,
      row.cc_addrs,
      row.subject,
      row.snippet,
      row.text_body,
      row.html_body,
      row.truncated,
      row.raw_size,
      row.raw_r2_key,
      row.message_id,
      row.in_reply_to,
      row.references_header,
      row.date_header,
      row.spam,
      row.attachments,
      row.provider_message_id,
    )
    .first<MessageRow>();
  if (!stored) throw new Error("message insert returned no row");
  return stored;
}

export async function getMessage(db: D1Database, inboxId: string, id: string): Promise<MessageRow | null> {
  return db.prepare("SELECT * FROM messages WHERE inbox_id = ? AND id = ?").bind(inboxId, id).first<MessageRow>();
}

export async function getMessageById(db: D1Database, id: string): Promise<MessageRow | null> {
  return db.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first<MessageRow>();
}

export async function listMessagesSince(db: D1Database, inboxId: string, since: number, limit: number): Promise<MessageRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM messages WHERE inbox_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
    .bind(inboxId, since, limit)
    .all<MessageRow>();
  return results;
}

export async function listRecentMessages(db: D1Database, user: UserRow, limit: number): Promise<MessageRow[]> {
  if (user.role === "admin") {
    const { results } = await db.prepare("SELECT * FROM messages ORDER BY seq DESC LIMIT ?").bind(limit).all<MessageRow>();
    return results;
  }
  const { results } = await db
    .prepare(
      `SELECT m.* FROM messages m
       JOIN inboxes i ON i.id = m.inbox_id
       JOIN agents a ON a.id = i.agent_id
       WHERE a.owner_user_id = ?
       ORDER BY m.seq DESC LIMIT ?`,
    )
    .bind(user.id, limit)
    .all<MessageRow>();
  return results;
}

export async function insertDraft(
  db: D1Database,
  row: Omit<DraftRow, "decided_at" | "decided_by" | "decision_note" | "sent_message_id" | "status"> & { status?: DraftRow["status"] },
): Promise<DraftRow> {
  const stored = await db
    .prepare(
      `INSERT INTO drafts (
        id, agent_id, inbox_id, thread_id, reply_to_message_id, to_addrs, cc_addrs, subject, text_body, html_body,
        original_subject, original_text, original_html, status, reason, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      RETURNING *`,
    )
    .bind(
      row.id,
      row.agent_id,
      row.inbox_id,
      row.thread_id,
      row.reply_to_message_id,
      row.to_addrs,
      row.cc_addrs,
      row.subject,
      row.text_body,
      row.html_body,
      row.original_subject,
      row.original_text,
      row.original_html,
      row.reason,
      row.created_by,
      row.created_at,
    )
    .first<DraftRow>();
  if (!stored) throw new Error("draft insert returned no row");
  return stored;
}

export async function getDraft(db: D1Database, id: string): Promise<DraftRow | null> {
  return db.prepare("SELECT * FROM drafts WHERE id = ?").bind(id).first<DraftRow>();
}

export async function listDrafts(db: D1Database, user: UserRow, status: string | null): Promise<DraftRow[]> {
  const statusSql = status ? "AND d.status = ?" : "";
  if (user.role === "admin") {
    const stmt = db.prepare(`SELECT d.* FROM drafts d WHERE 1 = 1 ${statusSql} ORDER BY d.created_at DESC LIMIT 100`);
    const { results } = status ? await stmt.bind(status).all<DraftRow>() : await stmt.all<DraftRow>();
    return results;
  }
  const stmt = db.prepare(
    `SELECT d.* FROM drafts d
     JOIN agents a ON a.id = d.agent_id
     WHERE a.owner_user_id = ? ${statusSql}
     ORDER BY d.created_at DESC LIMIT 100`,
  );
  const { results } = status ? await stmt.bind(user.id, status).all<DraftRow>() : await stmt.bind(user.id).all<DraftRow>();
  return results;
}

export async function listDraftsForAgent(db: D1Database, agentId: string): Promise<DraftRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM drafts WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50")
    .bind(agentId)
    .all<DraftRow>();
  return results;
}

export async function updateDraftContent(
  db: D1Database,
  id: string,
  fields: { to_addrs: string; cc_addrs: string; subject: string; text_body: string | null; html_body: string | null },
): Promise<void> {
  await db
    .prepare("UPDATE drafts SET to_addrs = ?, cc_addrs = ?, subject = ?, text_body = ?, html_body = ? WHERE id = ? AND status = 'pending'")
    .bind(fields.to_addrs, fields.cc_addrs, fields.subject, fields.text_body, fields.html_body, id)
    .run();
}

export async function markDraft(
  db: D1Database,
  id: string,
  fields: { status: DraftRow["status"]; decided_at: number; decided_by: string; decision_note: string | null; sent_message_id: string | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE drafts SET status = ?, decided_at = ?, decided_by = ?, decision_note = ?, sent_message_id = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(fields.status, fields.decided_at, fields.decided_by, fields.decision_note, fields.sent_message_id, id)
    .run();
}

export async function getCount(db: D1Database, scope: string, day: string): Promise<number> {
  const row = await db.prepare("SELECT count AS n FROM send_counters WHERE scope = ? AND day = ?").bind(scope, day).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Returns false when the daily cap is already full. The insert is atomic. */
export async function tryConsume(db: D1Database, scope: string, day: string, cap: number): Promise<boolean> {
  if (cap <= 0) return false;
  const row = await db
    .prepare(
      `INSERT INTO send_counters (scope, day, count) VALUES (?, ?, 1)
       ON CONFLICT (scope, day) DO UPDATE SET count = count + 1
       WHERE send_counters.count < ?
       RETURNING count`,
    )
    .bind(scope, day, cap)
    .first<{ count: number }>();
  return row != null;
}

export async function releaseCount(db: D1Database, scope: string, day: string): Promise<void> {
  await db.prepare("UPDATE send_counters SET count = MAX(count - 1, 0) WHERE scope = ? AND day = ?").bind(scope, day).run();
}

export async function insertQuarantine(db: D1Database, row: Omit<QuarantineRow, "id"> & { id: string }): Promise<void> {
  await db
    .prepare(
      `INSERT INTO quarantine (id, local_part, envelope_from, subject, raw_r2_key, spam, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.id, row.local_part, row.envelope_from, row.subject, row.raw_r2_key, row.spam, row.received_at)
    .run();
}

export async function listQuarantine(db: D1Database, limit: number): Promise<QuarantineRow[]> {
  const { results } = await db.prepare("SELECT * FROM quarantine ORDER BY received_at DESC LIMIT ?").bind(limit).all<QuarantineRow>();
  return results;
}

export async function audit(
  db: D1Database,
  entry: { actor_type: string; actor_id: string | null; action: string; target_type?: string | null; target_id?: string | null; detail?: unknown },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (id, at, actor_type, actor_id, action, target_type, target_id, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId(),
      Date.now(),
      entry.actor_type,
      entry.actor_id,
      entry.action,
      entry.target_type ?? null,
      entry.target_id ?? null,
      JSON.stringify(entry.detail ?? {}),
    )
    .run();
}

export async function listAudit(db: D1Database, limit: number): Promise<AuditRow[]> {
  const { results } = await db.prepare("SELECT * FROM audit_log ORDER BY at DESC LIMIT ?").bind(limit).all<AuditRow>();
  return results;
}

export async function spamForCleanup(db: D1Database, cutoff: number): Promise<MessageRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM messages WHERE spam = 1 AND received_at < ?")
    .bind(cutoff)
    .all<MessageRow>();
  return results;
}

export async function deleteSpamMessages(db: D1Database, cutoff: number): Promise<void> {
  await db.prepare("DELETE FROM messages WHERE spam = 1 AND received_at < ?").bind(cutoff).run();
  await db
    .prepare(
      `DELETE FROM threads
       WHERE id NOT IN (SELECT thread_id FROM messages)
         AND id NOT IN (SELECT thread_id FROM drafts WHERE thread_id IS NOT NULL)`,
    )
    .run();
}

export async function spamQuarantineForCleanup(db: D1Database, cutoff: number): Promise<QuarantineRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM quarantine WHERE spam = 1 AND received_at < ?")
    .bind(cutoff)
    .all<QuarantineRow>();
  return results;
}

export async function deleteSpamQuarantine(db: D1Database, cutoff: number): Promise<void> {
  await db.prepare("DELETE FROM quarantine WHERE spam = 1 AND received_at < ?").bind(cutoff).run();
}

export function canAccessAgent(user: UserRow, agent: AgentRow): boolean {
  return user.role === "admin" || agent.owner_user_id === user.id;
}
