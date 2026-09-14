import type { Attachment, Message, MessageVia, TicketDetail, TicketPriority, TicketStatus, TicketSummary } from "../shared/types";

const SEED_R2_KEY = "seed/inv-8841-duplicate.txt";
const SEED_ATTACHMENT_ID = "att_billing_seed";
const SEED_BODY = `INV-8841 duplicate charge
Customer: Priya Raman <priya@northwind.example>
Posted 2026-03-01  USD 240.00  card •••• 4242
Posted 2026-03-03  USD 240.00  card •••• 4242
Requested action: reverse the 3 March charge.
`;

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
};

type AttachmentRow = {
  id: string;
  ticket_id: string;
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
    subject: row.subject,
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

const LIST_SELECT = `
SELECT t.id, t.number, t.subject, t.customer_name, t.customer_email, t.status, t.priority,
       t.assignee, t.created_at, t.updated_at,
       (SELECT m.body FROM messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_preview,
       (SELECT m.via FROM messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_via,
       (SELECT COUNT(*) FROM messages m WHERE m.ticket_id = t.id) AS message_count
FROM tickets t
`;
const LIST_SQL = `${LIST_SELECT}ORDER BY t.updated_at DESC`;
const GET_ONE_SQL = `${LIST_SELECT}WHERE t.id = ?`;

export async function ensureSeed(env: Env): Promise<void> {
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

export async function listTickets(env: Env): Promise<TicketSummary[]> {
  const { results } = await env.DB.prepare(LIST_SQL).all<TicketRow>();
  return (results ?? []).map((row) => {
    const summary = toSummary(row);
    summary.lastPreview = previewOf(summary.lastPreview);
    return summary;
  });
}

export async function countTickets(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets").first<{ n: number }>();
  return row?.n ?? 0;
}

export async function getTicketRow(env: Env, id: string): Promise<TicketSummary | null> {
  const row = await env.DB.prepare(GET_ONE_SQL).bind(id).first<TicketRow>();
  if (!row) return null;
  const summary = toSummary(row);
  summary.lastPreview = previewOf(summary.lastPreview);
  return summary;
}

export async function getTicketByNumber(env: Env, number: number): Promise<TicketSummary | null> {
  const row = await env.DB.prepare("SELECT id FROM tickets WHERE number = ?").bind(number).first<{ id: string }>();
  if (!row) return null;
  return getTicketRow(env, row.id);
}

export async function getTicketDetail(env: Env, id: string): Promise<TicketDetail | null> {
  const ticket = await getTicketRow(env, id);
  if (!ticket) return null;
  const messages = await env.DB.prepare("SELECT * FROM messages WHERE ticket_id = ? ORDER BY created_at ASC").bind(id).all<MessageRow>();
  const attachments = await env.DB.prepare("SELECT * FROM attachments WHERE ticket_id = ? ORDER BY created_at ASC").bind(id).all<AttachmentRow>();
  return {
    ...ticket,
    messages: (messages.results ?? []).map(toMessage),
    attachments: (attachments.results ?? []).map(toAttachment),
  };
}

export async function nextTicketNumber(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COALESCE(MAX(number), 1041) AS n FROM tickets").first<{ n: number }>();
  return (row?.n ?? 1041) + 1;
}

export async function createTicket(
  env: Env,
  input: {
    id: string;
    number: number;
    subject: string;
    customerName: string;
    customerEmail: string;
    status: TicketStatus;
    priority: TicketPriority;
    now: number;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tickets (id, number, subject, customer_name, customer_email, status, priority, assignee, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  )
    .bind(input.id, input.number, input.subject, input.customerName, input.customerEmail, input.status, input.priority, input.now, input.now)
    .run();
}

export async function addMessage(
  env: Env,
  input: {
    id: string;
    ticketId: string;
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
      `INSERT INTO messages (id, ticket_id, author_kind, author_name, author_email, body, via, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(input.id, input.ticketId, input.authorKind, input.authorName, input.authorEmail, input.body, input.via, input.now),
  ];
  if (input.reopen) {
    statements.push(
      env.DB.prepare("UPDATE tickets SET status = 'open', updated_at = ? WHERE id = ?").bind(input.now, input.ticketId),
    );
  } else {
    statements.push(env.DB.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").bind(input.now, input.ticketId));
  }
  await env.DB.batch(statements);
}

export async function patchTicket(
  env: Env,
  id: string,
  patch: { status?: TicketStatus; priority?: TicketPriority; assignee?: string | null },
  now: number,
): Promise<TicketSummary | null> {
  const current = await getTicketRow(env, id);
  if (!current) return null;
  const status = patch.status ?? current.status;
  const priority = patch.priority ?? current.priority;
  const assignee = patch.assignee === undefined ? current.assignee : patch.assignee;
  await env.DB.prepare("UPDATE tickets SET status = ?, priority = ?, assignee = ?, updated_at = ? WHERE id = ?")
    .bind(status, priority, assignee, now, id)
    .run();
  return getTicketRow(env, id);
}

export async function insertAttachment(
  env: Env,
  input: {
    id: string;
    ticketId: string;
    r2Key: string;
    filename: string;
    contentType: string;
    size: number;
    now: number;
  },
): Promise<Attachment> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO attachments (id, ticket_id, r2_key, filename, content_type, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(input.id, input.ticketId, input.r2Key, input.filename, input.contentType, input.size, input.now),
    env.DB.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").bind(input.now, input.ticketId),
  ]);
  return {
    id: input.id,
    ticketId: input.ticketId,
    filename: input.filename,
    contentType: input.contentType,
    size: input.size,
    createdAt: input.now,
  };
}

export async function getAttachment(env: Env, ticketId: string, attachmentId: string): Promise<AttachmentRow | null> {
  return env.DB.prepare("SELECT * FROM attachments WHERE id = ? AND ticket_id = ?").bind(attachmentId, ticketId).first<AttachmentRow>();
}
