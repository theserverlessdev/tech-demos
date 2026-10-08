import { Hono } from "hono";
import { openApiSpec } from "./openapi";
import { getAgent, getDraft, getInbox, getKeyByHash, getMessage, getThread, listDraftsForAgent, listInboxes, listMessagesByThread, listMessagesSince, listThreads, touchKey } from "./db";
import { requestSend, resolveReplyTarget } from "./outbound";
import type { AgentRow, ApiKeyRow, AttachmentMeta, DraftRow, InboxRow, MessageRow } from "./types";
import {
  HttpError,
  MAX_WAIT_SECONDS,
  WAIT_POLL_MS,
  bearerToken,
  contentDisposition,
  extractCodes,
  extractLinks,
  htmlToText,
  normalizeRecipients,
  originOf,
  parseAttachments,
  parseJson,
  replySubject,
  sha256Hex,
} from "./util";

export type AppEnv = { Bindings: Env; Variables: { user?: import("./types").UserRow; agent?: AgentRow; keyId?: string } };

export const api = new Hono<AppEnv>();

api.get("/v1/openapi.json", (c) => c.json(openApiSpec(c.env)));

api.use("/v1/*", async (c, next) => {
  if (c.req.path === "/v1/openapi.json") return next();
  const auth = await resolveAgent(c.req.raw, c.env);
  c.set("agent", auth.agent);
  c.set("keyId", auth.key.id);
  await next();
});

api.get("/v1/me", async (c) => {
  const agent = requireAgent(c);
  const inboxes = await listInboxes(c.env.DB, agent.id);
  return c.json({
    agent: {
      id: agent.id,
      name: agent.name,
      policy: agent.policy,
      dailySendCap: agent.daily_send_cap,
      killSwitch: agent.kill_switch === 1,
    },
    inboxes: inboxes.map((inbox) => inboxJson(inbox, c.env)),
  });
});

api.get("/v1/inboxes", async (c) => {
  const agent = requireAgent(c);
  const inboxes = await listInboxes(c.env.DB, agent.id);
  return c.json({ inboxes: inboxes.map((inbox) => inboxJson(inbox, c.env)) });
});

api.get("/v1/inboxes/:id", async (c) => {
  const inbox = await ownedInbox(c);
  return c.json(inboxJson(inbox, c.env));
});

api.get("/v1/inboxes/:id/threads", async (c) => {
  const inbox = await ownedInbox(c);
  const threads = await listThreads(c.env.DB, inbox.id, intQuery(c.req.url, "limit", 50, 1, 100));
  return c.json({
    threads: threads.map((thread) => ({
      id: thread.id,
      subject: thread.subject,
      startedBy: thread.started_by,
      lastMessageAt: thread.last_message_at,
      createdAt: thread.created_at,
    })),
  });
});

api.get("/v1/inboxes/:id/threads/:threadId", async (c) => {
  const inbox = await ownedInbox(c);
  const thread = await getThread(c.env.DB, c.req.param("threadId"));
  if (!thread || thread.inbox_id !== inbox.id) throw new HttpError(404, "not_found", "No thread has this id.");
  const messages = await listMessagesByThread(c.env.DB, thread.id);
  return c.json({
    id: thread.id,
    subject: thread.subject,
    startedBy: thread.started_by,
    messages: messages.map(messageJson),
  });
});

api.get("/v1/inboxes/:id/messages", async (c) => {
  const inbox = await ownedInbox(c);
  const since = intQuery(c.req.url, "since", 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = intQuery(c.req.url, "limit", 50, 1, 100);
  const messages = await listMessagesSince(c.env.DB, inbox.id, since, limit);
  return c.json({
    messages: messages.map(messageJson),
    cursor: messages.length ? messages[messages.length - 1].seq : since,
  });
});

api.get("/v1/inboxes/:id/messages/:messageId", async (c) => {
  const inbox = await ownedInbox(c);
  const message = await getMessage(c.env.DB, inbox.id, c.req.param("messageId"));
  if (!message) throw new HttpError(404, "not_found", "No message has this id.");
  return c.json(messageJson(message));
});

api.get("/v1/inboxes/:id/messages/:messageId/raw", async (c) => {
  const inbox = await ownedInbox(c);
  const message = await getMessage(c.env.DB, inbox.id, c.req.param("messageId"));
  if (!message?.raw_r2_key) throw new HttpError(404, "not_found", "No raw file is stored for this message.");
  return objectResponse(c.env, message.raw_r2_key, "message.eml", "message/rfc822");
});

api.get("/v1/inboxes/:id/messages/:messageId/attachments/:index", async (c) => {
  const inbox = await ownedInbox(c);
  const message = await getMessage(c.env.DB, inbox.id, c.req.param("messageId"));
  if (!message) throw new HttpError(404, "not_found", "No message has this id.");
  return attachmentResponse(c.env, message, c.req.param("index"));
});

api.get("/v1/inboxes/:id/wait", async (c) => {
  const inbox = await ownedInbox(c);
  const since = intQuery(c.req.url, "since", 0, 0, Number.MAX_SAFE_INTEGER);
  const timeout = intQuery(c.req.url, "timeout", 20, 0, MAX_WAIT_SECONDS);
  const deadline = Date.now() + timeout * 1000;
  for (;;) {
    const messages = await listMessagesSince(c.env.DB, inbox.id, since, 10);
    if (messages.length > 0 || Date.now() + WAIT_POLL_MS > deadline) {
      return c.json({
        messages: messages.map(messageJson),
        cursor: messages.length ? messages[messages.length - 1].seq : since,
        timedOut: messages.length === 0,
      });
    }
    await scheduler.wait(WAIT_POLL_MS);
  }
});

api.post("/v1/inboxes/:id/send", async (c) => {
  const agent = requireAgent(c);
  const inbox = await ownedInbox(c);
  const body = await readJson(c.req.raw);
  const to = normalizeRecipients(stringList(body.to));
  const cc = normalizeRecipients(stringList(body.cc));
  const text = optionalString(body.text);
  const html = optionalString(body.html);
  const threadId = optionalString(body.threadId);
  const inReplyTo = optionalString(body.inReplyTo);
  const target = await resolveReplyTarget(c.env, inbox, threadId, inReplyTo);
  const subjectInput = optionalString(body.subject);
  const subject = subjectInput ?? (target.thread ? replySubject(target.thread.subject) : "");
  if (!subject.trim()) throw new HttpError(400, "bad_request", "Add a subject.");
  const result = await requestSend(c.env, {
    inbox,
    agent,
    actor: { type: "agent", id: agent.id },
    createdBy: "agent",
    via: "api",
    body: { to, cc, subject, text, html, thread: target.thread, replyTo: target.replyTo },
  });
  return c.json(result, result.outcome === "sent" ? 201 : 202);
});

api.post("/v1/inboxes/:id/threads/:threadId/reply", async (c) => {
  const agent = requireAgent(c);
  const inbox = await ownedInbox(c);
  const body = await readJson(c.req.raw);
  const target = await resolveReplyTarget(c.env, inbox, c.req.param("threadId"), null);
  if (!target.thread) throw new HttpError(404, "not_found", "No thread has this id.");
  const to = body.to == null ? defaultReplyTo(target.replyTo, inbox, c.env) : normalizeRecipients(stringList(body.to));
  const cc = normalizeRecipients(stringList(body.cc));
  const result = await requestSend(c.env, {
    inbox,
    agent,
    actor: { type: "agent", id: agent.id },
    createdBy: "agent",
    via: "api",
    body: {
      to,
      cc,
      subject: optionalString(body.subject) ?? replySubject(target.thread.subject),
      text: optionalString(body.text),
      html: optionalString(body.html),
      thread: target.thread,
      replyTo: target.replyTo,
    },
  });
  return c.json(result, result.outcome === "sent" ? 201 : 202);
});

api.get("/v1/drafts", async (c) => {
  const agent = requireAgent(c);
  const drafts = await listDraftsForAgent(c.env.DB, agent.id);
  return c.json({ drafts: drafts.map((draft) => draftJson(c.env, draft)) });
});

api.get("/v1/drafts/:id", async (c) => {
  const agent = requireAgent(c);
  const draft = await getDraft(c.env.DB, c.req.param("id"));
  if (!draft || draft.agent_id !== agent.id) throw new HttpError(404, "not_found", "No draft has this id.");
  return c.json(draftJson(c.env, draft));
});

export async function resolveAgent(request: Request, env: Env): Promise<{ agent: AgentRow; key: ApiKeyRow }> {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, "unauthorized", "Send a bearer API key.");
  const key = await getKeyByHash(env.DB, await sha256Hex(token));
  if (!key) throw new HttpError(401, "unauthorized", "The API key is not valid.");
  const agent = await getAgent(env.DB, key.agent_id);
  if (!agent) throw new HttpError(401, "unauthorized", "The API key is not valid.");
  await touchKey(env.DB, key.id, Date.now());
  return { agent, key };
}

function requireAgent(c: { get: (key: "agent") => AgentRow | undefined }): AgentRow {
  const agent = c.get("agent");
  if (!agent) throw new HttpError(401, "unauthorized", "Send a bearer API key.");
  return agent;
}

async function ownedInbox(c: { env: Env; req: { param: (name: string) => string }; get: (key: "agent") => AgentRow | undefined }): Promise<InboxRow> {
  const agent = requireAgent(c);
  const inbox = await getInbox(c.env.DB, c.req.param("id"));
  if (!inbox || inbox.agent_id !== agent.id) throw new HttpError(404, "not_found", "No inbox has this id.");
  return inbox;
}

function inboxJson(inbox: InboxRow, env: Env) {
  return {
    id: inbox.id,
    address: `${inbox.local_part}@${env.MAIL_DOMAIN}`,
    localPart: inbox.local_part,
    displayName: inbox.display_name,
    policy: inbox.policy_override,
    dailySendCap: inbox.daily_send_cap,
    listMode: inbox.list_mode,
    status: inbox.status,
    createdAt: inbox.created_at,
  };
}

export function messageJson(message: MessageRow) {
  const text = message.text_body ?? "";
  const html = message.html_body ?? "";
  const attachments = parseAttachments(message.attachments).map((part, index) => ({
    index,
    filename: part.filename,
    mimeType: part.mimeType,
    disposition: part.disposition,
    size: part.size,
  }));
  return {
    id: message.id,
    seq: message.seq,
    threadId: message.thread_id,
    inboxId: message.inbox_id,
    direction: message.direction,
    via: message.via,
    receivedAt: message.received_at,
    from: { name: message.from_name, address: message.from_address },
    to: parseJson<string[]>(message.to_addrs, []),
    cc: parseJson<string[]>(message.cc_addrs, []),
    subject: message.subject,
    snippet: message.snippet,
    text: message.text_body,
    html: message.html_body,
    truncated: message.truncated === 1,
    rawSize: message.raw_size,
    messageId: message.message_id,
    inReplyTo: message.in_reply_to,
    references: message.references_header,
    date: message.date_header,
    spam: message.spam === 1,
    attachments,
    codes: extractCodes(message.subject, text || htmlToText(html)),
    links: extractLinks(text, html),
  };
}

export function draftJson(env: Env, draft: DraftRow) {
  return {
    id: draft.id,
    inboxId: draft.inbox_id,
    threadId: draft.thread_id,
    status: draft.status,
    reason: draft.reason,
    to: parseJson<string[]>(draft.to_addrs, []),
    cc: parseJson<string[]>(draft.cc_addrs, []),
    subject: draft.subject,
    text: draft.text_body,
    html: draft.html_body,
    createdAt: draft.created_at,
    decidedAt: draft.decided_at,
    sentMessageId: draft.sent_message_id,
    statusUrl: `${originOf(env)}/v1/drafts/${draft.id}`,
  };
}

function defaultReplyTo(replyTo: MessageRow | null, inbox: InboxRow, env: Env): string[] {
  const own = `${inbox.local_part}@${env.MAIL_DOMAIN}`;
  const candidate = replyTo?.from_address && replyTo.from_address !== own ? replyTo.from_address : null;
  if (!candidate) throw new HttpError(400, "bad_request", "Add a recipient. The thread has no external sender.");
  return [candidate];
}

export async function attachmentResponse(env: Env, message: MessageRow, indexRaw: string): Promise<Response> {
  const index = Number(indexRaw);
  if (!Number.isInteger(index) || index < 0) throw new HttpError(400, "bad_request", "Attachment index must be a non-negative integer.");
  const meta: AttachmentMeta | undefined = parseAttachments(message.attachments)[index];
  if (!meta?.r2Key) throw new HttpError(404, "not_found", "No file is stored for this attachment.");
  return objectResponse(env, meta.r2Key, meta.filename, meta.mimeType);
}

async function objectResponse(env: Env, key: string, filename: string | null, mimeType: string): Promise<Response> {
  const object = await env.MAIL_BUCKET.get(key);
  if (!object) throw new HttpError(404, "not_found", "The file is gone.");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "no-store");
  if (!headers.has("content-type")) headers.set("content-type", mimeType || "application/octet-stream");
  headers.set("content-disposition", contentDisposition(filename));
  return new Response(object.body, { headers });
}

export function intQuery(url: string, name: string, fallback: number, min: number, max: number): number {
  const raw = new URL(url).searchParams.get(name);
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new HttpError(400, "bad_request", `"${name}" must be an integer.`);
  return Math.min(max, Math.max(min, value));
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    const body = JSON.parse(text) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // Fall through.
  }
  throw new HttpError(400, "bad_request", "The body must be a JSON object.");
}

function stringList(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (!Array.isArray(value)) throw new HttpError(400, "bad_request", "Recipients must be a list of email addresses.");
  return value.map((item) => {
    if (typeof item !== "string") throw new HttpError(400, "bad_request", "Recipients must be a list of email addresses.");
    return item;
  });
}

function optionalString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new HttpError(400, "bad_request", "Expected a string.");
  const trimmed = value.trim();
  return trimmed || null;
}
