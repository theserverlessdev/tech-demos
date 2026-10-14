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

/** Upstream response headers that may reach the browser. Cookies and hop-by-hop names are dropped. */
export function sanitizeResponseHeaders(upstream: Headers): Headers {
  const extra = extraHopByHop(upstream);
  const headers = new Headers();
  const contentType = upstream.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  for (const [name, value] of upstream) {
    const lower = name.toLowerCase();
    if (isHopByHop(lower) || extra.has(lower)) continue;
    if (lower === "content-type" || lower === "cache-control") continue;
    if (lower === "content-security-policy") continue;
    if (lower.startsWith("x-")) continue;
  }
  return headers;
}

export function forwardedVisitorCookies(headers: Headers): boolean {
  return headers.has("cookie") || headers.has("cookie2");
}
