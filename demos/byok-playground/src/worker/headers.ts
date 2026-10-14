import { KEY_HEADER } from "../shared/limits";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

const NEVER_FORWARD = new Set([
  "cookie",
  "cookie2",
  "set-cookie",
  "set-cookie2",
  "authorization",
  "host",
  "content-length",
  "origin",
  "referer",
  "referrer",
  "forwarded",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "cf-connecting-ip",
  "cf-ray",
  "cf-visitor",
  "cf-ipcountry",
  "true-client-ip",
  KEY_HEADER,
]);

const API_CSP = "default-src 'none'; sandbox";

function extraHopByHop(headers: Headers): Set<string> {
  const extra = new Set<string>();
  const connection = headers.get("connection");
  if (!connection) return extra;
  for (const token of connection.split(",")) {
    const name = token.trim().toLowerCase();
    if (name) extra.add(name);
  }
  return extra;
}

export function isHopByHop(name: string, headers?: Headers): boolean {
  const lower = name.toLowerCase();
  if (HOP_BY_HOP.has(lower) || NEVER_FORWARD.has(lower)) return true;
  if (headers && extraHopByHop(headers).has(lower)) return true;
  if (lower.startsWith("proxy-")) return true;
  return false;
}

/** Headers we send to the visitor's endpoint. Visitor cookies never leave this Worker. */
export function outboundHeaders(apiKey: string, accept: string): Headers {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${apiKey}`);
  headers.set("content-type", "application/json");
  headers.set("accept", accept);
  headers.set("accept-encoding", "identity");
  return headers;
}

/** Forced API response headers. Upstream content-type is not copied. */
export function apiHeaders(kind: "json" | "sse"): Headers {
  const headers = new Headers();
  headers.set("content-type", kind === "sse" ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", API_CSP);
  return headers;
}

export function mimeType(headers: Headers): string {
  return (headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
}

export function forwardedVisitorCookies(headers: Headers): boolean {
  return headers.has("cookie") || headers.has("cookie2");
}
