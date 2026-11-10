import PostalMime from "postal-mime";
import {
  audit,
  deleteSpamMessages,
  getAgent,
  deleteSpamQuarantine,
  findThreadByMessageIds,
  getInboxByLocalPart,
  getSettings,
  insertMessage,
  insertQuarantine,
  insertThread,
  spamForCleanup,
  spamQuarantineForCleanup,
  touchThread,
} from "./db";
import type { AttachmentMeta, InboxRow, MessageRow } from "./types";
import {
  DAY_MS,
  MAX_HTML_CHARS,
  MAX_RAW_BYTES,
  MAX_TEXT_CHARS,
  capText,
  formatMessageId,
  htmlToText,
  isSpamHeaders,
  logEvent,
  messageIdTokens,
  newId,
  parseAttachments,
  safeFilename,
  snippetOf,
} from "./util";
import { deliverWebhook } from "./webhook";

type MailPart = {
  filename?: string | null;
  mimeType?: string;
  disposition?: string | null;
  content?: unknown;
};

function asBytes(content: unknown): Uint8Array | null {
  if (content == null) return null;
  if (typeof content === "string") return content ? new TextEncoder().encode(content) : null;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (ArrayBuffer.isView(content)) return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  return null;
}

function headerValue(headers: { key: string; value: string }[] | undefined, name: string): string | null {
  const found = headers?.find((header) => header.key.toLowerCase() === name.toLowerCase());
  return found?.value ?? null;
}

function firstAddress(address: { name?: string; address?: string; group?: { name?: string; address?: string }[] } | undefined): {
  name: string | null;
  address: string | null;
} {
  if (!address) return { name: null, address: null };
  const box = address.group ? address.group[0] : address;
  if (!box) return { name: address.name || null, address: null };
  return { name: box.name || null, address: box.address ? box.address.toLowerCase() : null };
}

function addressList(list: { name?: string; address?: string; group?: { address?: string }[] }[] | undefined): string[] {
  if (!list?.length) return [];
  const out: string[] = [];
  for (const item of list) {
    const boxes = item.group ?? [item];
    for (const box of boxes) {
      if (box.address) out.push(box.address.toLowerCase());
    }
  }
  return out;
}

async function readRaw(raw: ReadableStream<Uint8Array> | ArrayBuffer | string): Promise<Uint8Array> {
  if (typeof raw === "string") return new TextEncoder().encode(raw);
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  const buf = await new Response(raw).arrayBuffer();
  return new Uint8Array(buf);
}

async function storeParts(bucket: R2Bucket, inboxId: string, messageId: string, parts: MailPart[]): Promise<AttachmentMeta[]> {
  const stored: AttachmentMeta[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const filename = part.filename ?? null;
    const mimeType = part.mimeType || "application/octet-stream";
    const body = asBytes(part.content);
    if (!body?.byteLength) {
      stored.push({ filename, mimeType, disposition: part.disposition ?? null, size: 0, r2Key: null });
      continue;
    }
    const r2Key = `att/${inboxId}/${messageId}/${i}-${safeFilename(filename)}`;
    await bucket.put(r2Key, body, { httpMetadata: { contentType: mimeType } });
    stored.push({ filename, mimeType, disposition: part.disposition ?? null, size: body.byteLength, r2Key });
  }
  return stored;
}

export async function handleInbound(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
  const to = message.to.toLowerCase();
  const at = to.lastIndexOf("@");
  const domain = at >= 0 ? to.slice(at + 1) : "";
  const localPart = (at >= 0 ? to.slice(0, at) : to).split("+")[0];

  if (domain !== env.MAIL_DOMAIN) {
    logEvent("email", { outcome: "rejected_domain" });
    message.setReject(`This server accepts mail for @${env.MAIL_DOMAIN} only.`);
    return;
  }
  if (message.rawSize > MAX_RAW_BYTES) {
    logEvent("email", { outcome: "rejected_size" });
    message.setReject("The message is larger than 10 MB.");
    return;
  }

  const inbox = await getInboxByLocalPart(env.DB, localPart);
  if (!inbox || inbox.status !== "active") {
    await unknownAddress(message, env, localPart, inbox);
    return;
  }

  try {
    const stored = await storeInbound(message, env, inbox);
    logEvent("email", { outcome: "stored", inboxId: inbox.id, spam: stored.spam === 1 });
    const agent = await getAgent(env.DB, inbox.agent_id);
    if (agent) {
      const job = deliverWebhook(env, agent, {
        type: "mail.received",
        inboxId: inbox.id,
        threadId: stored.thread_id,
        messageId: stored.id,
        seq: stored.seq,
        from: stored.from_address,
        subject: stored.subject,
        receivedAt: stored.received_at,
      });
      ctx.waitUntil(job);
    }
  } catch (err) {
    logEvent("email", { outcome: "failed", error: err instanceof Error ? err.name : "error" });
    throw err;
  }
}

async function unknownAddress(message: ForwardableEmailMessage, env: Env, localPart: string, inbox: InboxRow | null): Promise<void> {
  if (inbox && inbox.status === "disabled") {
    logEvent("email", { outcome: "rejected_disabled" });
    message.setReject("This inbox is disabled.");
    await audit(env.DB, { actor_type: "system", actor_id: null, action: "mail.rejected", target_type: "inbox", target_id: inbox.id, detail: { reason: "disabled" } });
    return;
  }
  const settings = await getSettings(env.DB);
  if (settings.unknown_policy === "quarantine") {
    const raw = await readRaw(message.raw);
    const id = newId();
    const key = `quarantine/${id}.eml`;
    await env.MAIL_BUCKET.put(key, raw, { httpMetadata: { contentType: "message/rfc822" } });
    let subject: string | null = null;
    try {
      const parsed = await PostalMime.parse(raw);
      subject = (parsed.subject ?? "").slice(0, 998) || null;
    } catch {
      subject = null;
    }
    const spam = isSpamHeaders(message.headers) ? 1 : 0;
    await insertQuarantine(env.DB, {
      id,
      local_part: localPart,
      envelope_from: message.from,
      subject,
      raw_r2_key: key,
      spam,
      received_at: Date.now(),
    });
    await audit(env.DB, {
      actor_type: "system",
      actor_id: null,
      action: "mail.quarantined",
      target_type: "quarantine",
      target_id: id,
      detail: { localPart, spam: spam === 1 },
    });
    logEvent("email", { outcome: "quarantined", spam: spam === 1 });
    return;
  }
  logEvent("email", { outcome: "rejected_unknown" });
  message.setReject("No inbox has this address.");
  await audit(env.DB, {
    actor_type: "system",
    actor_id: null,
    action: "mail.rejected",
    detail: { reason: "unknown" },
  });
}

async function storeInbound(message: ForwardableEmailMessage, env: Env, inbox: InboxRow): Promise<MessageRow> {
  const raw = await readRaw(message.raw);
  const parsed = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
  const text = capText(parsed.text, MAX_TEXT_CHARS);
  const html = capText(parsed.html, MAX_HTML_CHARS);
  const readable = text.value ?? (html.value ? htmlToText(html.value) : "");
  const subject = ((parsed.subject ?? "").trim() || "(no subject)").slice(0, 998);
  const from = firstAddress(parsed.from);
  const id = newId();
  const rawKey = `raw/${inbox.id}/${id}.eml`;
  const now = Date.now();
  const spam = isSpamHeaders(message.headers) ? 1 : 0;
  const inReplyTo = parsed.inReplyTo || headerValue(parsed.headers, "in-reply-to");
  const references = parsed.references || headerValue(parsed.headers, "references");
  const tokens = [...new Set([...messageIdTokens(inReplyTo), ...messageIdTokens(references)])];
  const existingThread = await findThreadByMessageIds(env.DB, inbox.id, tokens);
  const thread = existingThread
    ? { id: existingThread }
    : await insertThread(env.DB, { id: newId(), inbox_id: inbox.id, subject, started_by: "external", now });

  let attachments: AttachmentMeta[] = [];
  try {
    await env.MAIL_BUCKET.put(rawKey, raw, { httpMetadata: { contentType: "message/rfc822" } });
    attachments = await storeParts(env.MAIL_BUCKET, inbox.id, id, parsed.attachments ?? []);
    const stored = await insertMessage(env.DB, {
      id,
      thread_id: thread.id,
      inbox_id: inbox.id,
      direction: "inbound",
      via: "smtp",
      received_at: now,
      envelope_from: message.from,
      from_name: from.name,
      from_address: from.address,
      to_addrs: JSON.stringify(addressList(parsed.to)),
      cc_addrs: JSON.stringify(addressList(parsed.cc)),
      subject,
      snippet: snippetOf(readable),
      text_body: text.value,
      html_body: html.value,
      truncated: text.cut || html.cut ? 1 : 0,
      raw_size: raw.byteLength,
      raw_r2_key: rawKey,
      message_id: formatMessageId(parsed.messageId) || null,
      in_reply_to: inReplyTo,
      references_header: references,
      date_header: parsed.date ?? null,
      spam,
      attachments: JSON.stringify(attachments),
      provider_message_id: null,
    });
    await touchThread(env.DB, thread.id, subject, now);
    await audit(env.DB, {
      actor_type: "system",
      actor_id: null,
      action: "mail.received",
      target_type: "message",
      target_id: stored.id,
      detail: { inboxId: inbox.id, spam: spam === 1 },
    });
    return stored;
  } catch (err) {
    await env.MAIL_BUCKET.delete(rawKey);
    for (const part of attachments) {
      if (part.r2Key) await env.MAIL_BUCKET.delete(part.r2Key);
    }
    throw err;
  }
}

export async function cleanupSpam(env: Env, now = Date.now()): Promise<{ messages: number; quarantine: number }> {
  const settings = await getSettings(env.DB);
  const cutoff = now - settings.spam_ttl_days * DAY_MS;
  const messages = await spamForCleanup(env.DB, cutoff);
  for (const row of messages) {
    if (row.raw_r2_key) await env.MAIL_BUCKET.delete(row.raw_r2_key);
    for (const part of parseAttachments(row.attachments)) {
      if (part.r2Key) await env.MAIL_BUCKET.delete(part.r2Key);
    }
  }
  await deleteSpamMessages(env.DB, cutoff);
  const quarantine = await spamQuarantineForCleanup(env.DB, cutoff);
  for (const row of quarantine) await env.MAIL_BUCKET.delete(row.raw_r2_key);
  await deleteSpamQuarantine(env.DB, cutoff);
  return { messages: messages.length, quarantine: quarantine.length };
}
