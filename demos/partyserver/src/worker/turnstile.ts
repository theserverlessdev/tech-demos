const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Cloudflare's published always-pass test credentials. Not a production secret. */
export const TEST_TURNSTILE_SECRET = "1x0000000000000000000000000000000AA";
export const TEST_TURNSTILE_SITE_KEY = "1x00000000000000000000AA";

type Siteverify = {
  success: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
};

export function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Room creation fails closed until both a site key and a secret are set.
 * The published always-pass pair is accepted only when `allowTestCredentials`
 * is set, which `.dev.vars` does for local wrangler. Wrangler dev rewrites the
 * Host header to the production route, so the hostname cannot tell local from live.
 */
export function assessTurnstile(opts: { secret: string; siteKey: string; allowTestCredentials: boolean }): "open" | "closed" {
  const secret = opts.secret.trim();
  const siteKey = opts.siteKey.trim();
  if (!secret || !siteKey) return "closed";
  const test = secret === TEST_TURNSTILE_SECRET || siteKey === TEST_TURNSTILE_SITE_KEY;
  if (test && !opts.allowTestCredentials) return "closed";
  return "open";
}

export async function verifyTurnstile(secret: string, token: string, ip: string, requestHost: string): Promise<boolean> {
  if (!secret.trim() || !token || token.length > 2048) return false;
  let result: Siteverify;
  try {
    const res = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    result = (await res.json()) as Siteverify;
  } catch {
    return false;
  }
  if (!result.success) {
    console.warn(JSON.stringify({ event: "turnstile_failed", errors: result["error-codes"] ?? [] }));
    return false;
  }
  const host = result.hostname ?? "";
  const testHost = host === "example.com" || isLocalHost(host);
  if (!testHost && result.action && result.action !== "create-room") return false;
  if (!testHost && host !== requestHost) return false;
  return true;
}
