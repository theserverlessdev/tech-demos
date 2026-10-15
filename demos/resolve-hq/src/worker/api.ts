import { FROM_EMAIL_RE, LIMITS, TICKET_ID_RE } from "../shared/limits";
import type { Health, InboundMail, TicketPriority, TicketStatus } from "../shared/types";
import { draftReply } from "./ai";
import { claimDraft, parseCap, usedToday } from "./budget";
import {
  addMessage,
  countTickets,
  ensureSeed,
  ensureVisitor,
  getAttachment,
  getTicketDetail,
  insertAttachment,
  isSeedTicket,
  listTickets,
  patchTicket,
} from "./db";
import { isLocalEnv, publicSiteKey } from "./env";
import { HttpError } from "./errors";
import { fileResponseHeaders, safeFilename, sniffUpload } from "./files";
import { validateInboundFields } from "./inbound";
import { assertSameOrigin, contentLength, decodePathPart, limit } from "./origin";
import { finish, mintSignedSession, readVisitor, requireSession } from "./session";
import { aiStatus, isTestSiteKey, requireTurnstile, sessionGate } from "./turnstile";

export { HttpError };

const STATUSES = new Set<TicketStatus>(["open", "pending", "resolved"]);
const PRIORITIES = new Set<TicketPriority>(["low", "normal", "high", "urgent"]);
const ASSIGNEES = new Set(["Maya Chen", "Jordan Park"]);

const SAMPLES: Array<Pick<InboundMail, "fromName" | "fromEmail" | "subject" | "body">> = [
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

function ticketPath(pathname: string): { id: string; rest: string } | null {
  const match = pathname.match(/^\/api\/tickets\/([^/]+)(?:\/(.*))?$/);
  if (!match) return null;
  const id = decodePathPart(match[1]!);
  if (!id) return null;
  return { id, rest: match[2] ?? "" };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const declared = contentLength(request);
  if (declared !== null && declared > LIMITS.jsonBytes) throw new HttpError(413, "too_large", "The request body is too large.");
  const text = await request.text();
  if (text.length > LIMITS.jsonBytes) throw new HttpError(413, "too_large", "The request body is too large.");
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

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function isUpload(value: unknown): value is { name: string; size: number; type: string; arrayBuffer(): Promise<ArrayBuffer> } {
  return typeof File !== "undefined"
    ? value instanceof File
    : typeof value === "object" && value !== null && "arrayBuffer" in value && "size" in value && "name" in value;
}

async function writeSession(env: Env, request: Request): Promise<string> {
  assertSameOrigin(request);
  return requireSession(request, env);
}

export async function handleApi(request: Request, env: Env, pathname: string): Promise<Response> {
  const method = request.method;

  if (pathname === "/api/health" && method === "GET") {
    await limit(env.HEALTH_LIMIT, request, "health checks");
    await ensureSeed(env);
    const siteKey = publicSiteKey(env);
    const dailyCap = parseCap(env.DAILY_DRAFT_CAP, LIMITS.dailyDraftCap);
    const used = await usedToday(env);
    const body: Health = {
      ok: true,
      model: env.AI_MODEL,
      tickets: await countTickets(env),
      mailMode: env.DEV_MAIL_MODE,
      session: sessionGate(env),
      siteKey,
      testSiteKey: isTestSiteKey(siteKey),
      ai: aiStatus(env),
      budget: { dailyCap, used, remaining: Math.max(0, dailyCap - used) },
    };
    return json(body);
  }

  if (pathname === "/api/session" && method === "POST") {
    assertSameOrigin(request);
    await limit(env.SESSION_LIMIT, request, "session mints");
    const gate = sessionGate(env);
    if (gate === "off") throw new HttpError(503, "turnstile_unconfigured", "Writes are off until Turnstile is configured.");
    const body = await readJson(request);
    if (gate === "turnstile" || (publicSiteKey(env) && !isTestSiteKey(publicSiteKey(env)))) {
      await requireTurnstile(env, request, body.turnstileToken, "session");
    } else if (isLocalEnv(env)) {
      // Local test widget / dummy token. Still verify if a token was sent.
      if (body.turnstileToken) await requireTurnstile(env, request, body.turnstileToken, "session");
    }
    const minted = await mintSignedSession(env, request);
    await ensureVisitor(env, minted.id);
    return finish(json({ ok: true, visitorId: minted.id }), minted.cookie);
  }

  if (method !== "GET" && method !== "HEAD") assertSameOrigin(request);

  if (pathname === "/api/tickets" && method === "GET") {
    assertSameOrigin(request);
    await ensureSeed(env);
    const visitorId = await readVisitor(request, env);
    return json({ tickets: await listTickets(env, visitorId) });
  }

  if (pathname === "/api/inbound" && method === "POST") {
    const visitorId = await writeSession(env, request);
    await limit(env.WRITE_LIMIT, request, "inbound messages");
    const body = await readJson(request);
    await requireTurnstile(env, request, body.turnstileToken, "write");
    const sample = SAMPLES[Math.floor(Math.random() * SAMPLES.length)]!;
    const ticketId = str(body.ticketId) || newId("tkt");
    const fromEmail = clip(str(body.fromEmail, sample.fromEmail).trim(), LIMITS.fromEmailChars);
    const mail: InboundMail = {
      ticketId,
      messageId: newId("msg"),
      visitorId,
      fromName: clip(str(body.fromName, sample.fromName).trim(), LIMITS.fromNameChars),
      fromEmail,
      subject: clip(str(body.subject, sample.subject).trim(), LIMITS.subjectChars),
      body: clip(str(body.body, sample.body), LIMITS.messageBody),
    };
    try {
      validateInboundFields({ fromEmail: mail.fromEmail, body: mail.body, ticketId: str(body.ticketId) || undefined });
    } catch {
      throw new HttpError(400, "invalid", "Inbound mail needs a non-empty body and a valid fromEmail.");
    }
    if (str(body.ticketId) && !TICKET_ID_RE.test(mail.ticketId)) {
      throw new HttpError(400, "invalid", "That ticket id is not valid.");
    }
    if (!FROM_EMAIL_RE.test(mail.fromEmail)) throw new HttpError(400, "invalid", "fromEmail must look like an email address.");
    if (str(body.ticketId)) {
      const existing = await getTicketDetail(env, mail.ticketId, visitorId);
      if (!existing) throw new HttpError(404, "not_found", "That ticket is gone.");
    }
    await env.INBOUND.send(mail);
    return json({ queued: true, ticketId: mail.ticketId, messageId: mail.messageId }, 202);
  }

  const ticketMatch = ticketPath(pathname);
  if (!ticketMatch) throw new HttpError(404, "not_found", "Unknown API route.");
  if (!ticketMatch.id) throw new HttpError(404, "not_found", "That ticket is gone.");

  assertSameOrigin(request);
  await ensureSeed(env);
  const visitorId = method === "GET" || method === "HEAD" ? await readVisitor(request, env) : await requireSession(request, env);
  const detail = await getTicketDetail(env, ticketMatch.id, visitorId);
  if (!detail) throw new HttpError(404, "not_found", "That ticket is gone.");

  if (ticketMatch.rest === "" && method === "GET") return json(detail);

  if (ticketMatch.rest === "" && method === "PATCH") {
    if (!visitorId) throw new HttpError(401, "session", "Complete the Turnstile check once so this browser can use the inbox.");
    if (isSeedTicket(detail.id)) throw new HttpError(403, "seed_readonly", "Seed ticket status, priority, and assignee are locked.");
    await writeSession(env, request);
    await limit(env.WRITE_LIMIT, request, "writes");
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
      visitorId,
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
    if (!visitorId) throw new HttpError(401, "session", "Complete the Turnstile check once so this browser can use the inbox.");
    await writeSession(env, request);
    await limit(env.WRITE_LIMIT, request, "writes");
    const body = await readJson(request);
    const text = str(body.body).trim();
    if (!text) throw new HttpError(400, "invalid", "Write a reply first.");
    if (text.length > LIMITS.messageBody) throw new HttpError(413, "too_large", "The reply is too long.");
    const now = Date.now();
    await addMessage(env, {
      id: newId("msg"),
      ticketId: detail.id,
      visitorId,
      authorKind: "agent",
      authorName: detail.assignee ?? "Unassigned agent",
      authorEmail: null,
      body: text,
      via: "agent",
      now,
    });
    if (!isSeedTicket(detail.id) && typeof body.status === "string" && STATUSES.has(body.status as TicketStatus)) {
      await patchTicket(env, detail.id, visitorId, { status: body.status as TicketStatus }, now);
    }
    return json(await getTicketDetail(env, detail.id, visitorId), 201);
  }

  if (ticketMatch.rest === "draft" && method === "POST") {
    if (!visitorId) throw new HttpError(401, "session", "Complete the Turnstile check once so this browser can use the inbox.");
    await writeSession(env, request);
    await limit(env.AI_LIMIT, request, "AI drafts");
    const body = await readJson(request);
    await requireTurnstile(env, request, body.turnstileToken, "draft");
    await claimDraft(env, request);
    return json(await draftReply(env, detail));
  }

  if (ticketMatch.rest === "attachments" && method === "POST") {
    if (!visitorId) throw new HttpError(401, "session", "Complete the Turnstile check once so this browser can use the inbox.");
    await writeSession(env, request);
    await limit(env.UPLOAD_LIMIT, request, "uploads");
    const declared = contentLength(request);
    if (declared !== null && declared > LIMITS.uploadContentLength) {
      throw new HttpError(413, "too_large", "Attachments must be 1 MB or smaller.");
    }
    const form = await request.formData();
    await requireTurnstile(env, request, form.get("turnstileToken"), "write");
    const file = form.get("file");
    if (!isUpload(file)) throw new HttpError(400, "invalid", "Attach a file field named file.");
    if (file.size <= 0) throw new HttpError(400, "invalid", "The file is empty.");
    if (file.size > LIMITS.uploadBytes) throw new HttpError(413, "too_large", "Attachments must be 1 MB or smaller.");
    const filename = safeFilename(file.name);
    const id = newId("att");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > LIMITS.uploadBytes) throw new HttpError(413, "too_large", "Attachments must be 1 MB or smaller.");
    const contentType = sniffUpload(file.type || (filename.toLowerCase().endsWith(".txt") ? "text/plain" : ""), bytes);
    const r2Key = `tickets/${visitorId}/${detail.id}/${id}/${filename}`;
    await env.ATTACHMENTS.put(r2Key, bytes, { httpMetadata: { contentType } });
    const attachment = await insertAttachment(env, {
      id,
      ticketId: detail.id,
      visitorId,
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
    const attId = decodePathPart(download[1]!);
    if (!attId) throw new HttpError(404, "not_found", "That attachment is gone.");
    const row = await getAttachment(env, detail.id, attId, visitorId);
    if (!row) throw new HttpError(404, "not_found", "That attachment is gone.");
    const object = await env.ATTACHMENTS.get(row.r2_key);
    if (!object) throw new HttpError(404, "not_found", "The file bytes are missing from R2.");
    return new Response(object.body, { headers: fileResponseHeaders(row) });
  }

  throw new HttpError(404, "not_found", "Unknown API route.");
}
