import { isInlineImageType } from "../shared/types";

export { isInlineImageType };

const FILE_CSP = "default-src 'none'; sandbox";

export function fileResponseHeaders(row: {
  content_type: string;
  filename: string;
  size: number;
}): Headers {
  const headers = new Headers();
  const inline = isInlineImageType(row.content_type);
  headers.set("content-type", inline ? row.content_type : "application/octet-stream");
  headers.set("content-length", String(row.size));
  headers.set("cache-control", "public, max-age=31536000, immutable");
  const filename = row.filename.replaceAll('"', "");
  headers.set("content-disposition", `${inline ? "inline" : "attachment"}; filename="${filename}"`);
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", FILE_CSP);
  return headers;
}
