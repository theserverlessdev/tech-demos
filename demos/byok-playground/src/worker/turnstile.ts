import { HttpError } from "./errors";
import type { DemoEnv } from "./env";
import { clientIp, isLocalHost, isLocalRequest } from "./origin";

export const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";
export const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";
export const TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

type Siteverify = {
  success?: boolean;
  hostname?: string;
  "error-codes"?: string[];
};

export type SecretResolution = { ok: true; secret: string; test: boolean } | { ok: false; reason: "missing" | "test_secret" };

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
  const host = result.hostname ?? "";
  if (secret === TURNSTILE_TEST_SECRET) {
    return host === "example.com" || host === "localhost" || host === "127.0.0.1";
  }
  return host === requestHost || host === "theserverless.dev" || host.endsWith(".theserverless.dev");
}

export async function requireTurnstile(env: DemoEnv, request: Request, token: unknown): Promise<void> {
  const url = new URL(request.url);
  const hostForPolicy = isLocalRequest(request) ? "127.0.0.1" : url.hostname;
  const resolved = resolveTurnstileSecret(hostForPolicy, env.TURNSTILE_SECRET);
  if (!resolved.ok) {
    throw new HttpError(503, "turnstile_unconfigured", "Compare is off until TURNSTILE_SECRET is set to a real widget secret.");
  }
  const value = typeof token === "string" ? token.trim() : "";
  const ok = await verifyTurnstile(resolved.secret, value, clientIp(request), url.hostname);
  if (!ok) throw new HttpError(403, "turnstile_failed", "Turnstile did not pass. Retry the check, then compare again.");
}

export function aiStatus(env: DemoEnv, request: Request): "ready" | "stub" | "off" {
  if (!env.AI) return isLocalRequest(request) || env.ENVIRONMENT === "local" ? "stub" : "off";
  const hostForPolicy = isLocalRequest(request) ? "127.0.0.1" : new URL(request.url).hostname;
  const resolved = resolveTurnstileSecret(hostForPolicy, env.TURNSTILE_SECRET);
  if (!resolved.ok) return "off";
  if (isTestSiteKey(env.TURNSTILE_SITE_KEY) && !isLocalRequest(request) && env.ENVIRONMENT !== "local") return "off";
  return "ready";
}
