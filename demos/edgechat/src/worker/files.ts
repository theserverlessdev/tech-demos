const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const FILE_CSP = "default-src 'none'; sandbox";

export function isInlineImageType(contentType: string): boolean {
  return INLINE_TYPES.has(contentType);
}

export function fileResponseHeaders(row: {
  content_type: string;
  filename: string;
  size: number;
}): Headers {
  const headers = new Headers();
  const inline = isInlineImageType(row.content_type);
  headers.set("content-type", inline ? row.content_type : "application/octet-stream");
  headers.set("content-length", String(row.size));
  headers.set("cache-control", "private, max-age=3600");
  const filename = row.filename.replaceAll('"', "");
  headers.set("content-disposition", `${inline ? "inline" : "attachment"}; filename="${filename}"`);
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", FILE_CSP);
  return headers;
}
