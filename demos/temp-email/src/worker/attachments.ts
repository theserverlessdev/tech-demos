import type { AttachmentMeta } from "../shared/types";
import { clipChars, MAX_ATTACHMENTS, MAX_DISPOSITION_FILENAME } from "./limits";

function safeFilename(name: string | null | undefined): string {
  const base = (name ?? "attachment").split(/[/\\]/).pop() || "attachment";
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 80);
  return cleaned || "attachment";
}

export function contentDisposition(filename: string | null): string {
  const raw = (filename || "attachment").slice(0, MAX_DISPOSITION_FILENAME);
  const ascii = raw.replace(/[^\x20-\x7E]+/g, "_").replace(/["\\]/g, "_") || "attachment";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

function asBytes(content: unknown): ArrayBuffer | null {
  if (content == null) return null;
  let view: Uint8Array | null = null;
  if (typeof content === "string") view = content ? new TextEncoder().encode(content) : null;
  else if (content instanceof ArrayBuffer) view = new Uint8Array(content);
  else if (ArrayBuffer.isView(content)) view = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  if (!view?.byteLength) return null;
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy.buffer as ArrayBuffer;
}

export function attachmentObjectKey(inboxId: string, messageId: string, index: number, filename: string | null): string {
  return `${inboxId}/${messageId}/${index}-${safeFilename(filename)}`;
}

export function inboxPrefix(inboxId: string): string {
  return `${inboxId}/`;
}

export function messagePrefix(inboxId: string, messageId: string): string {
  return `${inboxId}/${messageId}/`;
}

export type MailPart = {
  filename?: string | null;
  mimeType?: string;
  disposition?: string | null;
  content?: unknown;
};

export function clipAttachmentPart(part: MailPart): { filename: string | null; mimeType: string; disposition: string | null } {
  return {
    filename: clipChars(part.filename ?? null),
    mimeType: clipChars(part.mimeType || "application/octet-stream") ?? "application/octet-stream",
    disposition: clipChars(part.disposition ?? null),
  };
}

/** Puts each part with bytes into R2. Meta (including r2Key) goes to D1 — never the blob. */
export async function storeAttachments(
  bucket: R2Bucket,
  inboxId: string,
  messageId: string,
  parts: MailPart[],
): Promise<AttachmentMeta[]> {
  const stored: AttachmentMeta[] = [];
  const take = parts.slice(0, MAX_ATTACHMENTS);
  try {
    for (let i = 0; i < take.length; i++) {
      const part = take[i];
      const { filename, mimeType, disposition } = clipAttachmentPart(part);
      const body = asBytes(part.content);
      if (!body) {
        stored.push({ filename, mimeType, disposition, size: 0, r2Key: null });
        continue;
      }
      const r2Key = attachmentObjectKey(inboxId, messageId, i, filename);
      await bucket.put(r2Key, body, {
        httpMetadata: {
          contentType: mimeType,
          contentDisposition: contentDisposition(filename),
        },
      });
      stored.push({ filename, mimeType, disposition, size: body.byteLength, r2Key });
    }
  } catch (err) {
    await deletePrefix(bucket, messagePrefix(inboxId, messageId));
    throw err;
  }
  return stored;
}

export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix, limit: 1000, cursor });
    const keys = page.objects.map((object) => object.key);
    if (keys.length) {
      await bucket.delete(keys);
      deleted += keys.length;
    }
    if (!page.truncated || !page.cursor) return deleted;
    cursor = page.cursor;
  }
}

export function textBodyKey(inboxId: string, messageId: string): string {
  return `${inboxId}/${messageId}/body.txt`;
}

export function htmlBodyKey(inboxId: string, messageId: string): string {
  return `${inboxId}/${messageId}/body.html`;
}

export async function storeBodies(
  bucket: R2Bucket,
  inboxId: string,
  messageId: string,
  text: string | null,
  html: string | null,
): Promise<{ textKey: string | null; htmlKey: string | null }> {
  let textKey: string | null = null;
  let htmlKey: string | null = null;
  try {
    if (text) {
      textKey = textBodyKey(inboxId, messageId);
      await bucket.put(textKey, text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    }
    if (html) {
      htmlKey = htmlBodyKey(inboxId, messageId);
      await bucket.put(htmlKey, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
    }
  } catch (err) {
    await deletePrefix(bucket, messagePrefix(inboxId, messageId));
    throw err;
  }
  return { textKey, htmlKey };
}

export function downloadHeaders(object: R2ObjectBody, filename: string | null, mimeType: string): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "sandbox");
  if (!headers.has("content-type")) headers.set("content-type", mimeType || "application/octet-stream");
  headers.set("content-disposition", contentDisposition(filename));
  return headers;
}
