export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https://challenges.cloudflare.com https://cloudflareinsights.com",
  "frame-src https://challenges.cloudflare.com",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function pageCsp(formActionOrigin?: string): string {
  if (!formActionOrigin) return PAGE_CSP;
  return PAGE_CSP.replace("form-action 'self'", `form-action 'self' ${formActionOrigin}`);
}

export function json(data: unknown, status = 200, extra?: Headers, cache = "no-store"): Response {
  const headers = extra ?? new Headers();
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", cache);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "same-origin");
  return new Response(JSON.stringify(data), { status, headers });
}

export function html(body: string, status = 200, extra?: Headers, formActionOrigin?: string): Response {
  const headers = extra ?? new Headers();
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "same-origin");
  headers.set("content-security-policy", pageCsp(formActionOrigin));
  return new Response(body, { status, headers });
}

export function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}
