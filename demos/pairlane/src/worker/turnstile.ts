import { TURNSTILE_ACTION } from "../shared/protocol";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const WIDGET_HOSTS = new Set(["pairlane.tech-demos.theserverless.dev", "tech-demos.theserverless.dev"]);

/** Cloudflare's published always-pass test pair. Safe to commit. */
export const TEST_TURNSTILE_SECRET = "1x0000000000000000000000000000000AA";
export const TEST_TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
export const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

export type VerifyResult = "ok" | "missing" | "rejected";

type Siteverify = { success?: boolean; hostname?: string; action?: string };

export function localEnabled(value: string | undefined): boolean {
  return value === "1";
}

export function isTestSecret(secret: string): boolean {
  return secret.trim() === TEST_TURNSTILE_SECRET;
}

export function isTestToken(token: string): boolean {
  return token === DUMMY_TOKEN || token === TEST_TURNSTILE_SECRET || token === TEST_TURNSTILE_SITE_KEY;
}

/**
 * Creation stays closed until a real secret is set.
 * The published test pair is accepted only when local mode is on.
 */
export function assessTurnstile(opts: { secret: string; siteKey: string; local: boolean }): "open" | "closed" {
  const secret = opts.secret.trim();
  const siteKey = opts.siteKey.trim();
  if (!secret || !siteKey) return "closed";
  const test = secret === TEST_TURNSTILE_SECRET || siteKey === TEST_TURNSTILE_SITE_KEY;
  if (test && !opts.local) return "closed";
  return "open";
}

/** Exact widget hosts. Loopback passes only in local mode. */
export function allowedWidgetHost(host: string, local: boolean): boolean {
  const name = host.trim().toLowerCase();
  if (WIDGET_HOSTS.has(name)) return true;
  if (!local) return false;
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
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
  if (!opts.local && (isTestToken(token) || isTestSecret(secret) || secret === "")) return "rejected";
  if (opts.local && isTestToken(token) && (isTestSecret(secret) || secret === "")) return "ok";
  if (!secret) return "rejected";

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
