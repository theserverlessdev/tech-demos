import type { InboundMail, TicketPriority, TicketStatus } from "../shared/types";
import { draftReply } from "./ai";
import {
  addMessage,
  countTickets,
  ensureSeed,
  getAttachment,
  getTicketDetail,
  insertAttachment,
  listTickets,
  patchTicket,
} from "./db";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const STATUSES = new Set<TicketStatus>(["open", "pending", "resolved"]);
const PRIORITIES = new Set<TicketPriority>(["low", "normal", "high", "urgent"]);
const MAX_UPLOAD = 1_000_000;
const MAX_BODY = 8_000;
const ASSIGNEES = new Set(["Maya Chen", "Jordan Park"]);

const SAMPLES: InboundMail[] = [
  {
    fromName: "Noah Patel",
    fromEmail: "noah@brightline.example",
    subject: "Cannot export last month's usage CSV",
    body: "The Usage page spinner never finishes for March. We need the CSV for finance today. Account is brightline-prod.",
  },
  {
    fromName: "Amina Diallo",
    fromEmail: "amina@fieldkit.example",
    subject: "Urgent: dashboard 502 after deploy",
    body: "Our status page is returning 502 from eu-west since 14:05 UTC. Rolling back the last Worker deploy did not help. Can you check the route?",
  },
  {
    fromName: "Chris Lang",
    fromEmail: "chris@paperkite.example",
    subject: "How do I add a second notification email?",
    body: "We want paging to go to oncall@paperkite.example as well as me. Is that a workspace setting or a per-monitor field?",
  },
];

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

async function limitWrite(env: Env, request: Request): Promise<void> {
  const { success } = await env.WRITE_LIMIT.limit({ key: clientIp(request) });
  if (!success) throw new HttpError(429, "rate_limited", "Too many writes from this address. Wait a minute.");
}

function ticketPath(pathname: string): { id: string; rest: string } | null {
  const match = pathname.match(/^\/api\/tickets\/([^/]+)(?:\/(.*))?$/);
  if (!match) return null;
  return { id: decodeURIComponent(match[1]!), rest: match[2] ?? "" };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 32_000) throw new HttpError(413, "too_large", "The request body is too large.");
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_json", "The request body must be JSON.");
  }
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export async function handleApi(request: Request, env: Env, pathname: string): Promise<Response> {
  await ensureSeed(env);
  const method = request.method;

  if (pathname === "/api/health" && method === "GET") {
    return json({
      ok: true,
      model: env.AI_MODEL,
      tickets: await countTickets(env),
      mailMode: env.DEV_MAIL_MODE,
    });
  }

  if (pathname === "/api/tickets" && method === "GET") {
    return json({ tickets: await listTickets(env) });
  }

  if (pathname === "/api/inbound" && method === "POST") {
    await limitWrite(env, request);
    const body = await readJson(request);
    const sample = SAMPLES[Math.floor(Math.random() * SAMPLES.length)]!;
    const mail: InboundMail = {
      fromName: str(body.fromName, sample.fromName),
      fromEmail: str(body.fromEmail, sample.fromEmail),
      subject: str(body.subject, sample.subject),
      body: str(body.body, sample.body),
      ticketId: str(body.ticketId) || undefined,
    };
    if (mail.body.length > MAX_BODY) throw new HttpError(413, "too_large", "The message is too long.");
    await env.INBOUND.send(mail);
    return json({ queued: true }, 202);
  }

  const ticketMatch = ticketPath(pathname);
  if (!ticketMatch) throw new HttpError(404, "not_found", "Unknown API route.");

  const detail = await getTicketDetail(env, ticketMatch.id);
  if (!detail) throw new HttpError(404, "not_found", "That ticket is gone.");

  if (ticketMatch.rest === "" && method === "GET") return json(detail);

  if (ticketMatch.rest === "" && method === "PATCH") {
    await limitWrite(env, request);
    const body = await readJson(request);
    const status = str(body.status);
    const priority = str(body.priority);
    if (status && !STATUSES.has(status as TicketStatus)) throw new HttpError(400, "invalid", "Unknown status.");
    if (priority && !PRIORITIES.has(priority as TicketPriority)) throw new HttpError(400, "invalid", "Unknown priority.");
    let assignee: string | null | undefined;
    if ("assignee" in body) {
      if (body.assignee === null || body.assignee === "") assignee = null;
      else if (typeof body.assignee === "string" && ASSIGNEES.has(body.assignee)) assignee = body.assignee;
      else throw new HttpError(400, "invalid", "Assignee must be Maya Chen, Jordan Park, or empty.");
    }
    const updated = await patchTicket(
      env,
      detail.id,
      {
        status: status ? (status as TicketStatus) : undefined,
        priority: priority ? (priority as TicketPriority) : undefined,
        assignee,
      },
      Date.now(),
    );
    return json(updated);
  }

  if (ticketMatch.rest === "replies" && method === "POST") {
    await limitWrite(env, request);
    const body = await readJson(request);
    const text = str(body.body).trim();
    if (!text) throw new HttpError(400, "invalid", "Write a reply first.");
    if (text.length > MAX_BODY) throw new HttpError(413, "too_large", "The reply is too long.");
    const now = Date.now();
    await addMessage(env, {
      id: newId("msg"),
      ticketId: detail.id,
      authorKind: "agent",
      authorName: detail.assignee ?? "Unassigned agent",
      authorEmail: null,
      body: text,
      via: "agent",
      now,
    });
    if (typeof body.status === "string" && STATUSES.has(body.status as TicketStatus)) {
      await patchTicket(env, detail.id, { status: body.status as TicketStatus }, now);
    }
    return json(await getTicketDetail(env, detail.id), 201);
  }

  if (ticketMatch.rest === "draft" && method === "POST") {
    await limitWrite(env, request);
    return json(await draftReply(env, detail));
  }

  if (ticketMatch.rest === "attachments" && method === "POST") {
    await limitWrite(env, request);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "invalid", "Attach a file field named file.");
    if (file.size <= 0) throw new HttpError(400, "invalid", "The file is empty.");
    if (file.size > MAX_UPLOAD) throw new HttpError(413, "too_large", "Attachments must be 1 MB or smaller.");
    const filename = (file.name || "attachment").replace(/[^\w.\- ()]/g, "_").slice(0, 80);
    const id = newId("att");
    const r2Key = `tickets/${detail.id}/${id}/${filename}`;
    const bytes = await file.arrayBuffer();
    const contentType = file.type || "application/octet-stream";
    await env.ATTACHMENTS.put(r2Key, bytes, { httpMetadata: { contentType } });
    const attachment = await insertAttachment(env, {
      id,
      ticketId: detail.id,
      r2Key,
      filename,
      contentType,
      size: bytes.byteLength,
      now: Date.now(),
    });
    return json(attachment, 201);
  }

  const download = ticketMatch.rest.match(/^attachments\/([^/]+)$/);
  if (download && method === "GET") {
    const row = await getAttachment(env, detail.id, decodeURIComponent(download[1]!));
    if (!row) throw new HttpError(404, "not_found", "That attachment is gone.");
    const object = await env.ATTACHMENTS.get(row.r2_key);
    if (!object) throw new HttpError(404, "not_found", "The file bytes are missing from R2.");
    const headers = new Headers();
    headers.set("content-type", row.content_type);
    headers.set("content-disposition", `attachment; filename="${row.filename.replaceAll('"', "")}"`);
    headers.set("cache-control", "private, max-age=60");
    return new Response(object.body, { headers });
  }

  throw new HttpError(404, "not_found", "Unknown API route.");
}
