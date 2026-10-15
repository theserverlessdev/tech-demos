import { LIMITS } from "../shared/limits";
import type { Attachment, Message, MessageVia, TicketDetail, TicketPriority, TicketStatus, TicketSummary } from "../shared/types";

const SEED_R2_KEY = "seed/inv-8841-duplicate.txt";
const SEED_ATTACHMENT_ID = "att_billing_seed";
const SEED_BODY = `INV-8841 duplicate charge
Customer: Priya Raman <priya@northwind.example>
Posted 2026-03-01  USD 240.00  card •••• 4242
Posted 2026-03-03  USD 240.00  card •••• 4242
Requested action: reverse the 3 March charge.
`;

export const SEED_TICKETS: Array<{
  id: string;
  status: TicketStatus;
  priority: TicketPriority;
  assignee: string | null;
  updatedAt: number;
}> = [
  { id: "tkt_billing", status: "open", priority: "high", assignee: "Maya Chen", updatedAt: 1789027200000 },
  { id: "tkt_sso", status: "pending", priority: "urgent", assignee: "Jordan Park", updatedAt: 1789106400000 },
  { id: "tkt_cron", status: "open", priority: "normal", assignee: null, updatedAt: 1789178400000 },
  { id: "tkt_webhooks", status: "open", priority: "high", assignee: "Maya Chen", updatedAt: 1789286400000 },
  { id: "tkt_docs", status: "resolved", priority: "low", assignee: "Jordan Park", updatedAt: 1788912000000 },
];

export const SEED_MESSAGE_IDS = [
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
] as const;

const SEED_IDS = SEED_TICKETS.map((t) => t.id);

type TicketRow = {
  id: string;
  number: number;
  subject: string;
  customer_name: string;
  customer_email: string;
  status: TicketStatus;
  priority: TicketPriority;
  assignee: string | null;
  created_at: number;
  updated_at: number;
  visitor_id: string | null;
  last_preview: string | null;
  last_via: MessageVia | null;
  message_count: number;
};

type MessageRow = {
  id: string;
  ticket_id: string;
  author_kind: "customer" | "agent";
  author_name: string;
  author_email: string | null;
  body: string;
  via: MessageVia;
  created_at: number;
  visitor_id: string | null;
};

type AttachmentRow = {
  id: string;
  ticket_id: string;
  visitor_id: string | null;
  r2_key: string;
  filename: string;
  content_type: string;
  size: number;
  created_at: number;
};

function previewOf(body: string): string {
  const line = body.replace(/\s+/g, " ").trim();
  return line.length > 140 ? `${line.slice(0, 137)}…` : line;
}

function toSummary(row: TicketRow): TicketSummary {
  return {
    id: row.id,
    number: row.number,
    subject: row.subject.slice(0, LIMITS.subjectChars),
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    status: row.status,
    priority: row.priority,
    assignee: row.assignee,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastPreview: row.last_preview ?? "",
    lastVia: row.last_via,
    messageCount: row.message_count,
    sandbox: Boolean(row.visitor_id),
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    authorKind: row.author_kind,
    authorName: row.author_name,
    authorEmail: row.author_email,
    body: row.body,
    via: row.via,
    createdAt: row.created_at,
  };
}

function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
}

function listSelect(visitorId: string | null): { sql: string; binds: string[] } {
  const msgVis = visitorId ? "(m.visitor_id IS NULL OR m.visitor_id = ?)" : "m.visitor_id IS NULL";
  const ticketVis = visitorId ? "(t.visitor_id IS NULL OR t.visitor_id = ?)" : "t.visitor_id IS NULL";
  const sql = `
SELECT t.id, t.number, substr(t.subject, 1, ${LIMITS.subjectChars}) AS subject, t.customer_name, t.customer_email, t.status, t.priority,
       t.assignee, t.created_at, t.updated_at, t.visitor_id,
       (SELECT m.body FROM messages m WHERE m.ticket_id = t.id AND ${msgVis} ORDER BY m.created_at DESC LIMIT 1) AS last_preview,
       (SELECT m.via FROM messages m WHERE m.ticket_id = t.id AND ${msgVis} ORDER BY m.created_at DESC LIMIT 1) AS last_via,
       (SELECT COUNT(*) FROM messages m WHERE m.ticket_id = t.id AND ${msgVis}) AS message_count
FROM tickets t
WHERE ${ticketVis}
`;
  return { sql, binds: visitorId ? [visitorId, visitorId, visitorId, visitorId] : [] };
}

let seeded: Promise<void> | undefined;

async function seedOnce(env: Env): Promise<void> {
  const flag = await env.DB.prepare("SELECT value FROM meta WHERE key = 'seeded_r2'").first<{ value: string }>();
  if (flag?.value === "1") {
    const existing = await env.ATTACHMENTS.head(SEED_R2_KEY);
    if (existing) return;
  }
  const put = await env.ATTACHMENTS.put(SEED_R2_KEY, SEED_BODY, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
  const size = put.size ?? new TextEncoder().encode(SEED_BODY).byteLength;
  await env.DB.batch([
    env.DB.prepare("UPDATE attachments SET size = ? WHERE id = ?").bind(size, SEED_ATTACHMENT_ID),
    env.DB.prepare("INSERT INTO meta (key, value) VALUES ('seeded_r2', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"),
  ]);
}

export function ensureSeed(env: Env): Promise<void> {
  seeded ??= seedOnce(env).catch((err) => {
    seeded = undefined;
    throw err;
  });
  return seeded;
}

export async function listTickets(env: Env, visitorId: string | null): Promise<TicketSummary[]> {
  const { sql, binds } = listSelect(visitorId);
  const { results } = await env.DB.prepare(`${sql} ORDER BY t.updated_at DESC LIMIT ${LIMITS.listLimit}`)
    .bind(...binds)
    .all<TicketRow>();
  return (results ?? []).map((row) => {
    const summary = toSummary(row);
    summary.lastPreview = previewOf(summary.lastPreview);
    return summary;
  });
}

export async function countTickets(env: Env, visitorId?: string | null): Promise<number> {
  if (!visitorId) {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE visitor_id IS NULL").first<{ n: number }>();
    return row?.n ?? 0;
  }
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE visitor_id IS NULL OR visitor_id = ?")
    .bind(visitorId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function getTicketRow(env: Env, id: string, visitorId: string | null): Promise<TicketSummary | null> {
  const { sql, binds } = listSelect(visitorId);
  const row = await env.DB.prepare(`${sql} AND t.id = ?`).bind(...binds, id).first<TicketRow>();
  if (!row) return null;
  const summary = toSummary(row);
  summary.lastPreview = previewOf(summary.lastPreview);
  return summary;
}

export async function getTicketByNumber(env: Env, number: number, visitorId: string | null): Promise<TicketSummary | null> {
  const row = visitorId
    ? await env.DB.prepare("SELECT id FROM tickets WHERE number = ? AND (visitor_id IS NULL OR visitor_id = ?)")
        .bind(number, visitorId)
        .first<{ id: string }>()
    : await env.DB.prepare("SELECT id FROM tickets WHERE number = ? AND visitor_id IS NULL").bind(number).first<{ id: string }>();
  if (!row) return null;
  return getTicketRow(env, row.id, visitorId);
}

export async function getTicketDetail(env: Env, id: string, visitorId: string | null): Promise<TicketDetail | null> {
  const ticket = await getTicketRow(env, id, visitorId);
  if (!ticket) return null;
  const messages = visitorId
    ? await env.DB.prepare("SELECT * FROM messages WHERE ticket_id = ? AND (visitor_id IS NULL OR visitor_id = ?) ORDER BY created_at ASC")
        .bind(id, visitorId)
        .all<MessageRow>()
    : await env.DB.prepare("SELECT * FROM messages WHERE ticket_id = ? AND visitor_id IS NULL ORDER BY created_at ASC").bind(id).all<MessageRow>();
  const attachments = visitorId
    ? await env.DB.prepare(
        "SELECT * FROM attachments WHERE ticket_id = ? AND (visitor_id IS NULL OR visitor_id = ?) ORDER BY created_at ASC",
      )
        .bind(id, visitorId)
        .all<AttachmentRow>()
    : await env.DB.prepare("SELECT * FROM attachments WHERE ticket_id = ? AND visitor_id IS NULL ORDER BY created_at ASC")
        .bind(id)
        .all<AttachmentRow>();
  return {
    ...ticket,
    messages: (messages.results ?? []).map(toMessage),
    attachments: (attachments.results ?? []).map(toAttachment),
  };
}

export async function addMessage(
  env: Env,
  input: {
    id: string;
    ticketId: string;
    visitorId: string | null;
    authorKind: "customer" | "agent";
    authorName: string;
    authorEmail: string | null;
    body: string;
    via: MessageVia;
    now: number;
    reopen?: boolean;
  },
): Promise<void> {
  const statements = [
    env.DB.prepare(
      `INSERT INTO messages (id, ticket_id, author_kind, author_name, author_email, body, via, created_at, visitor_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.id,
      input.ticketId,
      input.authorKind,
      input.authorName,
      input.authorEmail,
      input.body,
      input.via,
      input.now,
      input.visitorId,
    ),
  ];
  if (!isSeedTicket(input.ticketId)) {
    if (input.reopen) {
      statements.push(env.DB.prepare("UPDATE tickets SET status = 'open', updated_at = ? WHERE id = ?").bind(input.now, input.ticketId));
    } else {
      statements.push(env.DB.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").bind(input.now, input.ticketId));
    }
  }
  await env.DB.batch(statements);
}

export async function patchTicket(
  env: Env,
  id: string,
  visitorId: string,
  patch: { status?: TicketStatus; priority?: TicketPriority; assignee?: string | null },
  now: number,
): Promise<TicketSummary | null> {
  const current = await getTicketRow(env, id, visitorId);
  if (!current) return null;
  if (isSeedTicket(id)) return current;
  const status = patch.status ?? current.status;
  const priority = patch.priority ?? current.priority;
  const assignee = patch.assignee === undefined ? current.assignee : patch.assignee;
  await env.DB.prepare("UPDATE tickets SET status = ?, priority = ?, assignee = ?, updated_at = ? WHERE id = ? AND visitor_id = ?")
    .bind(status, priority, assignee, now, id, visitorId)
    .run();
  return getTicketRow(env, id, visitorId);
}

export async function insertAttachment(
  env: Env,
  input: {
    id: string;
    ticketId: string;
    visitorId: string;
    r2Key: string;
    filename: string;
    contentType: string;
    size: number;
    now: number;
  },
): Promise<Attachment> {
  const statements = [
    env.DB.prepare(
      `INSERT INTO attachments (id, ticket_id, visitor_id, r2_key, filename, content_type, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(input.id, input.ticketId, input.visitorId, input.r2Key, input.filename, input.contentType, input.size, input.now),
  ];
  if (!isSeedTicket(input.ticketId)) {
    statements.push(env.DB.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").bind(input.now, input.ticketId));
  }
  await env.DB.batch(statements);
  return {
    id: input.id,
    ticketId: input.ticketId,
    filename: input.filename,
    contentType: input.contentType,
    size: input.size,
    createdAt: input.now,
  };
}

export async function getAttachment(env: Env, ticketId: string, attachmentId: string, visitorId: string | null): Promise<AttachmentRow | null> {
  if (!visitorId) {
    return env.DB.prepare("SELECT * FROM attachments WHERE id = ? AND ticket_id = ? AND visitor_id IS NULL")
      .bind(attachmentId, ticketId)
      .first<AttachmentRow>();
  }
  return env.DB.prepare("SELECT * FROM attachments WHERE id = ? AND ticket_id = ? AND (visitor_id IS NULL OR visitor_id = ?)")
    .bind(attachmentId, ticketId, visitorId)
    .first<AttachmentRow>();
}

export async function ensureVisitor(env: Env, visitorId: string, now = Date.now()): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO visitors (id, created_at, last_seen_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  )
    .bind(visitorId, now, now)
    .run();
}

export function isSeedTicket(id: string): boolean {
  return SEED_IDS.includes(id);
}

export { SEED_R2_KEY, SEED_ATTACHMENT_ID };
