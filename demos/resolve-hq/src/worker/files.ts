import { ALLOWED_UPLOAD_TYPES, type AllowedUploadType } from "../shared/limits";
import { HttpError } from "./errors";

const FILE_CSP = "default-src 'none'; sandbox";

const SNIFF: Record<AllowedUploadType, (bytes: Uint8Array) => boolean> = {
  "image/png": (bytes) => bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
  "image/jpeg": (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "application/pdf": (bytes) => bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46,
  "text/plain": (bytes) => {
    const sample = bytes.subarray(0, Math.min(bytes.length, 1024));
    for (const byte of sample) if (byte === 0) return false;
    return true;
  },
};

export function sniffUpload(contentType: string, bytes: Uint8Array): AllowedUploadType {
  const declared = (contentType.split(";")[0]?.trim().toLowerCase() ?? "") as AllowedUploadType;
  const check = SNIFF[declared];
  if (!check || !check(bytes)) {
    throw new HttpError(415, "type", "Files must be PNG, JPEG, PDF, or plain text.");
  }
  return declared;
}

export function serveContentType(stored: string): string {
  const type = stored.split(";")[0]?.trim().toLowerCase() ?? "";
  return (ALLOWED_UPLOAD_TYPES as readonly string[]).includes(type) ? stored : "application/octet-stream";
}

export function fileResponseHeaders(row: { content_type: string; filename: string; size: number }): Headers {
  const headers = new Headers();
  headers.set("content-type", serveContentType(row.content_type));
  headers.set("content-length", String(row.size));
  headers.set("cache-control", "private, max-age=60");
  const filename = row.filename.replaceAll('"', "");
  headers.set("content-disposition", `attachment; filename="${filename}"`);
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", FILE_CSP);
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("x-robots-tag", "noindex");
  return headers;
}

export function safeFilename(name: string): string {
  const cleaned = (name || "attachment").replace(/[^\w.\- ()]/g, "_").replace(/^\.+/, "_").slice(0, 80);
  return cleaned || "attachment";
}
