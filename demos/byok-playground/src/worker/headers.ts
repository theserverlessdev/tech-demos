const API_CSP = "default-src 'none'; sandbox";

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
