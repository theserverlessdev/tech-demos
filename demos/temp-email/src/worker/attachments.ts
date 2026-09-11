import type { AttachmentMeta } from "../shared/types";

function safeFilename(name: string | null | undefined): string {
  const base = (name ?? "attachment").split(/[/\\]/).pop() || "attachment";
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 80);
  return cleaned || "attachment";
}

function contentDisposition(filename: string | null): string {
  const raw = filename || "attachment";
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

type MailPart = {
  filename?: string | null;
  mimeType?: string;
  disposition?: string | null;
  content?: unknown;
};

/** Puts each part with bytes into R2. Meta (including r2Key) goes to D1 — never the blob. */
export async function storeAttachments(
  bucket: R2Bucket,
  inboxId: string,
  messageId: string,
  parts: MailPart[],
): Promise<AttachmentMeta[]> {
  const stored: AttachmentMeta[] = [];
  try {
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const filename = part.filename ?? null;
      const mimeType = part.mimeType || "application/octet-stream";
      const body = asBytes(part.content);
      if (!body) {
        stored.push({ filename, mimeType, disposition: part.disposition ?? null, size: 0, r2Key: null });
        continue;
      }
      const r2Key = attachmentObjectKey(inboxId, messageId, i, filename);
      await bucket.put(r2Key, body, {
        httpMetadata: {
          contentType: mimeType,
          contentDisposition: contentDisposition(filename),
        },
      });
      stored.push({ filename, mimeType, disposition: part.disposition ?? null, size: body.byteLength, r2Key });
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

export function downloadHeaders(object: R2ObjectBody, filename: string | null, mimeType: string): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "no-store");
  if (!headers.has("content-type")) headers.set("content-type", mimeType || "application/octet-stream");
  headers.set("content-disposition", contentDisposition(filename));
  return headers;
}
