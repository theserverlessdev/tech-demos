import { DEMO_HOST, HUB_HOST, TURNSTILE_ACTION } from "../shared/protocol";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const WIDGET_HOSTS = new Set([DEMO_HOST, HUB_HOST]);

/** Cloudflare's published always-pass test pair. Safe to commit. */
export const TEST_TURNSTILE_SECRET = "1x0000000000000000000000000000000AA";
export const TEST_TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
export const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

export type VerifyResult = "ok" | "missing" | "rejected" | "unconfigured";

type Siteverify = { success?: boolean; hostname?: string; action?: string };

export function isLoopback(host: string): boolean {
  const name = host.trim().toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "::1" || name === "[::1]";
}

/**
 * Test tokens need the flag. A loopback host is enough.
 * Wrangler dev rewrites the URL to the zone route, so that host is not loopback.
 * A request that reached Cloudflare carries CF-Ray, and a client cannot remove it,
 * so the flag does not open local mode on the deployed host.
 */
export function localEnabled(flag: string | undefined, hostname: string, ray?: string | null): boolean {
  if (flag !== "1") return false;
  if (isLoopback(hostname)) return true;
  return !ray;
}

export function isTestSecret(secret: string): boolean {
  return secret.trim() === TEST_TURNSTILE_SECRET;
}

export function isTestToken(token: string): boolean {
  return token === DUMMY_TOKEN || token === TEST_TURNSTILE_SECRET || token === TEST_TURNSTILE_SITE_KEY;
}

/** Exact widget hosts. Loopback passes only while local mode is on. */
export function allowedWidgetHost(host: string, local: boolean): boolean {
  const name = host.trim().toLowerCase().split(":")[0] ?? "";
  if (WIDGET_HOSTS.has(name)) return true;
  return local && isLoopback(name);
}

export async function verifyTurnstile(opts: {
  secret: string;
  token: string;
  ip: string;
  local: boolean;
  fetchImpl?: typeof fetch;
}): Promise<VerifyResult> {
  const token = opts.token.trim();
  if (!token || token.length > 2048) return token ? "rejected" : "missing";
  const secret = opts.secret.trim();
  if (opts.local && isTestToken(token) && (secret === "" || isTestSecret(secret))) return "ok";
  if (!opts.local && (isTestToken(token) || isTestSecret(secret))) return "rejected";
  if (!secret) return "unconfigured";

  const fetchImpl = opts.fetchImpl ?? fetch;
  let result: Siteverify;
  try {
    const res = await fetchImpl(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response: token, remoteip: opts.ip || undefined }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return "rejected";
    result = (await res.json()) as Siteverify;
  } catch {
    return "rejected";
  }
  if (!result.success) return "rejected";
  if (result.action !== TURNSTILE_ACTION) return "rejected";
  if (!allowedWidgetHost(result.hostname ?? "", opts.local)) return "rejected";
  return "ok";
}
