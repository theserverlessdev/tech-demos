import type { AttachmentMeta, DeliveryVia, InboxInfo, InboxSource, MessageFull, MessageSummary } from "../shared/types";

export type InboxRow = {
  id: string;
  local_part: string;
  token_hash: string;
  source: InboxSource;
  created_at: number;
  expires_at: number;
  api_key_id: string | null;
};

type MessageRow = {
  seq: number;
  id: string;
  inbox_id: string;
  via: DeliveryVia;
  received_at: number;
  envelope_from: string;
  from_name: string | null;
  from_address: string | null;
  to_header: string | null;
  subject: string;
  snippet: string;
  text_body: string | null;
  html_body: string | null;
  truncated: number;
  raw_size: number;
  message_id: string | null;
  date_header: string | null;
  codes: string;
  links: string;
  attachments: string;
};

export type NewMessage = Omit<MessageRow, "seq" | "truncated"> & { truncated: boolean };

const SUMMARY_COLUMNS = `seq, id, inbox_id, via, received_at, envelope_from, from_name, from_address, to_header, subject, snippet,
  text_body IS NOT NULL AS has_text, html_body IS NOT NULL AS has_html, codes, attachments`;

type SummaryRow = Omit<MessageRow, "text_body" | "html_body" | "truncated" | "raw_size" | "message_id" | "date_header" | "links"> & {
  has_text: number;
  has_html: number;
};

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toInboxInfo(row: InboxRow, domain: string, messageCount: number): InboxInfo {
  return {
    address: `${row.local_part}@${domain}`,
    localPart: row.local_part,
    domain,
    source: row.source,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    messageCount,
  };
}

function toSummary(row: SummaryRow): MessageSummary {
  return {
    id: row.id,
    seq: row.seq,
    via: row.via,
    receivedAt: row.received_at,
    envelopeFrom: row.envelope_from,
    from: { name: row.from_name, address: row.from_address },
    subject: row.subject,
    snippet: row.snippet,
    hasHtml: row.has_html === 1,
    hasText: row.has_text === 1,
    attachmentCount: parseJson<AttachmentMeta[]>(row.attachments, []).length,
    codes: parseJson<string[]>(row.codes, []),
  };
}

function toFull(row: MessageRow): MessageFull {
  return {
    ...toSummary({ ...row, has_text: row.text_body === null ? 0 : 1, has_html: row.html_body === null ? 0 : 1 }),
    to: row.to_header,
    text: row.text_body,
    html: row.html_body,
    truncated: row.truncated === 1,
    rawSize: row.raw_size,
    messageId: row.message_id,
    date: row.date_header,
    links: parseJson<string[]>(row.links, []),
    attachments: parseJson<AttachmentMeta[]>(row.attachments, []),
  };
}

export async function findActiveInbox(db: D1Database, localPart: string, now = Date.now()): Promise<InboxRow | null> {
  return db
    .prepare("SELECT * FROM inboxes WHERE local_part = ? AND expires_at > ?")
    .bind(localPart, now)
    .first<InboxRow>();
}

/** Returns null when an active inbox already uses the name. */
export async function insertInbox(db: D1Database, row: InboxRow): Promise<InboxRow | null> {
  // An expired inbox that the cron job has not removed yet must not block the name.
  await deleteExpiredInbox(db, row.local_part, row.created_at);
  try {
    await db
      .prepare(
        "INSERT INTO inboxes (id, local_part, token_hash, source, created_at, expires_at, api_key_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(row.id, row.local_part, row.token_hash, row.source, row.created_at, row.expires_at, row.api_key_id)
      .run();
    return row;
  } catch (err) {
    if (String(err).includes("UNIQUE")) return null;
    throw err;
  }
}

async function deleteExpiredInbox(db: D1Database, localPart: string, now: number): Promise<void> {
  const expired = await db
    .prepare("SELECT id FROM inboxes WHERE local_part = ? AND expires_at <= ?")
    .bind(localPart, now)
    .first<{ id: string }>();
  if (expired) await deleteInbox(db, expired.id);
}

export async function deleteInbox(db: D1Database, inboxId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM messages WHERE inbox_id = ?").bind(inboxId),
    db.prepare("DELETE FROM inboxes WHERE id = ?").bind(inboxId),
  ]);
}

export async function setExpiry(db: D1Database, inboxId: string, expiresAt: number): Promise<void> {
  await db.prepare("UPDATE inboxes SET expires_at = ? WHERE id = ?").bind(expiresAt, inboxId).run();
}

export async function countMessages(db: D1Database, inboxId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE inbox_id = ?").bind(inboxId).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listSummaries(db: D1Database, inboxId: string, after: number, limit: number): Promise<MessageSummary[]> {
  const { results } = await db
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM messages WHERE inbox_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?`)
    .bind(inboxId, after, limit)
    .all<SummaryRow>();
  return results.map(toSummary);
}

/** Oldest first, so an agent reads new mail in arrival order. */
export async function listFullAfter(db: D1Database, inboxId: string, after: number, limit: number): Promise<MessageFull[]> {
  const { results } = await db
    .prepare("SELECT * FROM messages WHERE inbox_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
    .bind(inboxId, after, limit)
    .all<MessageRow>();
  return results.map(toFull);
}

export async function getMessage(db: D1Database, inboxId: string, id: string): Promise<MessageFull | null> {
  const row = await db.prepare("SELECT * FROM messages WHERE inbox_id = ? AND id = ?").bind(inboxId, id).first<MessageRow>();
  return row ? toFull(row) : null;
}

export async function deleteMessage(db: D1Database, inboxId: string, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM messages WHERE inbox_id = ? AND id = ?").bind(inboxId, id).run();
  return result.meta.changes > 0;
}

export async function insertMessage(db: D1Database, m: NewMessage): Promise<MessageFull> {
  const row = await db
    .prepare(
      `INSERT INTO messages (id, inbox_id, via, received_at, envelope_from, from_name, from_address, to_header, subject, snippet,
        text_body, html_body, truncated, raw_size, message_id, date_header, codes, links, attachments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .bind(
      m.id, m.inbox_id, m.via, m.received_at, m.envelope_from, m.from_name, m.from_address, m.to_header, m.subject, m.snippet,
      m.text_body, m.html_body, m.truncated ? 1 : 0, m.raw_size, m.message_id, m.date_header, m.codes, m.links, m.attachments,
    )
    .first<MessageRow>();
  if (!row) throw new Error("Message insert returned no row");
  return toFull(row);
}

/** Deletes expired inboxes and their messages. Returns the count of each. */
export async function cleanupExpired(db: D1Database, now = Date.now()): Promise<{ inboxes: number; messages: number }> {
  const [messages, inboxes] = await db.batch([
    db.prepare("DELETE FROM messages WHERE inbox_id IN (SELECT id FROM inboxes WHERE expires_at <= ?)").bind(now),
    db.prepare("DELETE FROM inboxes WHERE expires_at <= ?").bind(now),
  ]);
  return { inboxes: inboxes.meta.changes, messages: messages.meta.changes };
}
