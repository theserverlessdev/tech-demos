import type { AiStatus, SessionGate, TurnstileAction } from "../shared/types";
import { isLocalEnv, publicSiteKey } from "./env";
import { HttpError } from "./errors";
import { clientIp, isLocalRequest } from "./origin";

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

export type SecretResolution = { ok: true; secret: string; test: boolean } | { ok: false; reason: "missing" | "test_secret" };

export function resolveTurnstileSecret(environment: string, configured: string | undefined): SecretResolution {
  const local = `${environment}` === "local";
  const secret = configured?.trim() ?? "";
  if (!secret) {
    if (local) return { ok: true, secret: TURNSTILE_TEST_SECRET, test: true };
    return { ok: false, reason: "missing" };
  }
  if (secret === TURNSTILE_TEST_SECRET && !local) return { ok: false, reason: "test_secret" };
  return { ok: true, secret, test: secret === TURNSTILE_TEST_SECRET };
}

export function isTestSiteKey(siteKey: string | null | undefined): boolean {
  return (siteKey?.trim() ?? "") === TURNSTILE_TEST_SITE_KEY;
}

export async function verifyTurnstile(
  secret: string,
  token: string,
  ip: string,
  requestHost: string,
  expectedAction?: TurnstileAction,
): Promise<boolean> {
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
  if (expectedAction && result.action && result.action !== expectedAction) return false;
  const host = result.hostname ?? "";
  if (secret === TURNSTILE_TEST_SECRET) {
    return host === "example.com" || host === "localhost" || host === "127.0.0.1";
  }
  return host === requestHost || host === "theserverless.dev" || host.endsWith(".theserverless.dev");
}

export async function requireTurnstile(env: Env, request: Request, token: unknown, action: TurnstileAction): Promise<void> {
  const resolved = resolveTurnstileSecret(env.ENVIRONMENT, env.TURNSTILE_SECRET);
  if (!resolved.ok) {
    throw new HttpError(503, "turnstile_unconfigured", "This action is off until TURNSTILE_SECRET is set to a real widget secret.");
  }
  if (resolved.test && !isLocalRequest(request)) {
    throw new HttpError(503, "turnstile_unconfigured", "The test Turnstile secret is only valid on localhost when ENVIRONMENT is local.");
  }
  const value = typeof token === "string" ? token.trim() : "";
  const ok = await verifyTurnstile(resolved.secret, value, clientIp(request), new URL(request.url).hostname, action);
  if (!ok) throw new HttpError(403, "turnstile_failed", "Turnstile did not pass. Retry the check, then try again.");
}

export function sessionGate(env: Env): SessionGate {
  const local = isLocalEnv(env);
  const siteKey = publicSiteKey(env);
  const resolved = resolveTurnstileSecret(env.ENVIRONMENT, env.TURNSTILE_SECRET);
  if (local) {
    if (siteKey && !isTestSiteKey(siteKey) && resolved.ok) return "turnstile";
    return "local";
  }
  if (!siteKey || !resolved.ok || isTestSiteKey(siteKey)) return "off";
  return "turnstile";
}

export function aiStatus(env: Env): AiStatus {
  const siteKey = publicSiteKey(env);
  const resolved = resolveTurnstileSecret(env.ENVIRONMENT, env.TURNSTILE_SECRET);
  if (!resolved.ok) return "off";
  if (!siteKey) return isLocalEnv(env) && !env.AI ? "stub" : "off";
  if (isTestSiteKey(siteKey) && !isLocalEnv(env)) return "off";
  if (!env.AI) return isLocalEnv(env) ? "stub" : "off";
  return "ready";
}
