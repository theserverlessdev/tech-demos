import { FROM_EMAIL_RE, TICKET_ID_RE } from "../shared/limits";
import type { InboundMail } from "../shared/types";
import { getTicketByNumber, getTicketRow } from "./db";
import { PermanentInboundError } from "./errors";

const SUBJECT_TOKEN = /\[#(\d+)\]/;

function inferPriority(subject: string, body: string): "low" | "normal" | "high" | "urgent" {
  const text = `${subject} ${body}`.toLowerCase();
  if (/\b(down|outage|urgent|asap|cannot log in|can't log in)\b/.test(text)) return "urgent";
  if (/\b(double.?charg|invoice|billing|payment|webhook)\b/.test(text)) return "high";
  if (/\b(how do i|docs|question|typo)\b/.test(text)) return "low";
  return "normal";
}

export function validateInboundFields(input: { fromEmail: string; body: string; ticketId?: string }): void {
  if (!input.body.trim()) throw new PermanentInboundError("inbound mail needs a body");
  if (!FROM_EMAIL_RE.test(input.fromEmail.trim())) throw new PermanentInboundError("inbound mail needs a valid fromEmail");
  if (input.ticketId && !TICKET_ID_RE.test(input.ticketId)) throw new PermanentInboundError("inbound mail has a bad ticketId");
}

export async function ingestInbound(env: Env, mail: InboundMail): Promise<{ ticketId: string; created: boolean; number: number }> {
  const now = Date.now();
  const fromName = mail.fromName.trim() || mail.fromEmail.split("@")[0] || "Customer";
  const fromEmail = mail.fromEmail.trim().toLowerCase();
  const subject = mail.subject.trim() || "(no subject)";
  const body = mail.body.trim();
  const ticketId = mail.ticketId.trim();
  const messageId = mail.messageId.trim();
  const visitorId = mail.visitorId.trim();
  try {
    validateInboundFields({ fromEmail, body, ticketId });
  } catch (err) {
    throw err instanceof PermanentInboundError ? err : new PermanentInboundError(String(err));
  }
  if (!visitorId || !messageId) throw new PermanentInboundError("inbound mail needs visitor and message ids");

  let existing = ticketId ? await getTicketRow(env, ticketId, visitorId) : null;
  if (!existing) {
    const token = subject.match(SUBJECT_TOKEN);
    if (token) existing = await getTicketByNumber(env, Number(token[1]), visitorId);
  }

  if (existing) {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO messages (id, ticket_id, author_kind, author_name, author_email, body, via, created_at)
         VALUES (?, ?, 'customer', ?, ?, ?, 'queue', ?)`,
      ).bind(messageId, existing.id, fromName, fromEmail, body, now),
      env.DB.prepare(
        `UPDATE tickets SET updated_at = ?, status = CASE WHEN status IN ('resolved', 'pending') THEN 'open' ELSE status END
         WHERE id = ? AND (visitor_id IS NULL OR visitor_id = ?)`,
      ).bind(now, existing.id, visitorId),
    ]);
    return { ticketId: existing.id, created: false, number: existing.number };
  }

  const priority = inferPriority(subject, body);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO tickets (id, number, subject, customer_name, customer_email, status, priority, assignee, created_at, updated_at, visitor_id)
       SELECT ?, COALESCE((SELECT MAX(number) FROM tickets), 1041) + 1, ?, ?, ?, 'open', ?, NULL, ?, ?, ?`,
    ).bind(ticketId, subject, fromName, fromEmail, priority, now, now, visitorId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO messages (id, ticket_id, author_kind, author_name, author_email, body, via, created_at)
       VALUES (?, ?, 'customer', ?, ?, ?, 'queue', ?)`,
    ).bind(messageId, ticketId, fromName, fromEmail, body, now),
  ]);
  const created = await getTicketRow(env, ticketId, visitorId);
  return { ticketId, created: true, number: created?.number ?? 0 };
}
