/** Cloudflare's published always-pass test pair. Safe to commit. Rejected off localhost. */
export const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";
export const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";
export const TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

type Siteverify = {
  success?: boolean;
  hostname?: string;
  "error-codes"?: string[];
};

export type SecretResolution =
  | { ok: true; secret: string; test: boolean }
  | { ok: false; reason: "missing" | "test_secret" };

export function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * `wrangler dev` rewrites the request URL to the first route host, so the
 * URL is not localhost. Cloudflare sets CF-Connecting-IP and does not let a
 * client spoof it; 127.0.0.1 only shows up under local dev.
 */
export function isLocalRequest(request: Request): boolean {
  const url = new URL(request.url);
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  return isLocalHost(url.hostname) || isLocalHost(ip);
}

/**
 * Production must have a real TURNSTILE_SECRET. An empty secret, or the
 * published test secret on a public host, fails closed.
 */
export function resolveTurnstileSecret(hostname: string, configured: string | undefined): SecretResolution {
  const local = isLocalHost(hostname);
  const secret = configured?.trim() ?? "";
  if (!secret) {
    if (local) return { ok: true, secret: TURNSTILE_TEST_SECRET, test: true };
    return { ok: false, reason: "missing" };
  }
  if (secret === TURNSTILE_TEST_SECRET && !local) return { ok: false, reason: "test_secret" };
  return { ok: true, secret, test: secret === TURNSTILE_TEST_SECRET };
}

export function isTestSiteKey(siteKey: string | undefined): boolean {
  return (siteKey?.trim() || TURNSTILE_TEST_SITE_KEY) === TURNSTILE_TEST_SITE_KEY;
}

export async function verifyTurnstile(secret: string, token: string, ip: string, requestHost: string): Promise<boolean> {
  if (!token || token.length > 2048) return false;
  let result: Siteverify;
  try {
    const res = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response: token, remoteip: ip || undefined }),
      signal: AbortSignal.timeout(8_000),
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
  if (secret === TURNSTILE_TEST_SECRET) {
    return host === "example.com" || host === "localhost" || host === "127.0.0.1";
  }
  return host === requestHost || host.endsWith(".theserverless.dev");
}
