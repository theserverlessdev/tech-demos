/** Cloudflare's published always-pass test pair. Safe to commit. Rejected off local dev. */
export const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";
export const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";
export const TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

type Siteverify = {
  success?: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
};

export function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/** wrangler types ENVIRONMENT as the committed "". .dev.vars sets "local" only for wrangler dev. */
export function environmentName(env: { ENVIRONMENT: string }): string {
  const environment: string = env.ENVIRONMENT;
  return environment;
}

export function isLocalRequest(request: Request, environment: string): boolean {
  if (environment === "local") return true;
  const url = new URL(request.url);
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  return isLocalHost(url.hostname) || isLocalHost(ip);
}

export function resolveTurnstileSecret(local: boolean, configured: string | undefined): { ok: true; secret: string; test: boolean } | { ok: false } {
  const secret = configured?.trim() ?? "";
  if (!secret) {
    if (local) return { ok: true, secret: TURNSTILE_TEST_SECRET, test: true };
    return { ok: false };
  }
  if (secret === TURNSTILE_TEST_SECRET && !local) return { ok: false };
  return { ok: true, secret, test: secret === TURNSTILE_TEST_SECRET };
}

export function isTestSiteKey(siteKey: string | undefined): boolean {
  const key = siteKey?.trim() ?? "";
  return key === TURNSTILE_TEST_SITE_KEY;
}

export async function verifyTurnstile(secret: string, token: string, ip: string, requestHost: string): Promise<boolean> {
  if (!token || token.length > 2048) return false;
  if (secret === TURNSTILE_TEST_SECRET && token === TURNSTILE_DUMMY_TOKEN) return true;
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
  if (!result.success) return false;
  if (secret === TURNSTILE_TEST_SECRET) return true;
  if (result.action && result.action !== "judge") return false;
  const host = result.hostname ?? "";
  return host === requestHost || host.endsWith(".theserverless.dev");
}
