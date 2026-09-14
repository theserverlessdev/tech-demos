import type { InboundMail } from "../shared/types";
import { addMessage, createTicket, getTicketByNumber, getTicketRow, nextTicketNumber } from "./db";

const SUBJECT_TOKEN = /\[#(\d+)\]/;

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function inferPriority(subject: string, body: string): "low" | "normal" | "high" | "urgent" {
  const text = `${subject} ${body}`.toLowerCase();
  if (/\b(down|outage|urgent|asap|cannot log in|can't log in)\b/.test(text)) return "urgent";
  if (/\b(double.?charg|invoice|billing|payment|webhook)\b/.test(text)) return "high";
  if (/\b(how do i|docs|question|typo)\b/.test(text)) return "low";
  return "normal";
}

export async function ingestInbound(env: Env, mail: InboundMail): Promise<{ ticketId: string; created: boolean; number: number }> {
  const now = Date.now();
  const fromName = mail.fromName.trim() || mail.fromEmail.split("@")[0] || "Customer";
  const fromEmail = mail.fromEmail.trim().toLowerCase();
  const subject = mail.subject.trim() || "(no subject)";
  const body = mail.body.trim();
  if (!fromEmail || !body) throw new Error("inbound mail needs fromEmail and body");

  let existing = mail.ticketId ? await getTicketRow(env, mail.ticketId) : null;
  if (!existing) {
    const token = subject.match(SUBJECT_TOKEN);
    if (token) existing = await getTicketByNumber(env, Number(token[1]));
  }

  if (existing) {
    await addMessage(env, {
      id: newId("msg"),
      ticketId: existing.id,
      authorKind: "customer",
      authorName: fromName,
      authorEmail: fromEmail,
      body,
      via: "queue",
      now,
      reopen: existing.status === "resolved" || existing.status === "pending",
    });
    return { ticketId: existing.id, created: false, number: existing.number };
  }

  const id = newId("tkt");
  const number = await nextTicketNumber(env);
  await createTicket(env, {
    id,
    number,
    subject,
    customerName: fromName,
    customerEmail: fromEmail,
    status: "open",
    priority: inferPriority(subject, body),
    now,
  });
  await addMessage(env, {
    id: newId("msg"),
    ticketId: id,
    authorKind: "customer",
    authorName: fromName,
    authorEmail: fromEmail,
    body,
    via: "queue",
    now,
  });
  return { ticketId: id, created: true, number };
}
