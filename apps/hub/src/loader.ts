export const COMPATIBILITY_DATE = "2026-09-01";

export const DEMO_RESPONSE_CSP =
  "sandbox allow-scripts allow-forms allow-popups; frame-ancestors 'none'";

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable Dynamic Worker id: changes when source or compatibility date changes. */
export async function demoLoaderId(
  slug: string,
  source: string,
  compatibilityDate = COMPATIBILITY_DATE,
): Promise<string> {
  const hash = await sha256Hex(`${compatibilityDate}\n${source}`);
  return `${slug}:${hash}`;
}

/** Loader demos are GET/HEAD pages. Rejecting other methods avoids a billed isolate and a body stream. */
export function isLoaderMethodAllowed(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

export function forwardToLoader(request: Request, loaderId: string): Request {
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  headers.set("x-dynamic-worker", loaderId);
  // Do not attach the inbound body. Dynamic workers in this hub answer without
  // reading it, which throws after the response: "Can't read from request stream
  // after response has been sent."
  return new Request(request.url, {
    method: request.method,
    headers,
    redirect: request.redirect,
  });
}

export function wrapDemoResponse(response: Response, loaderId: string): Response {
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  headers.set("content-security-policy", DEMO_RESPONSE_CSP);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-dynamic-worker", loaderId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function sha256CspHash(source: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  let bin = "";
  for (const byte of new Uint8Array(digest)) bin += String.fromCharCode(byte);
  return `sha256-${btoa(bin)}`;
}
