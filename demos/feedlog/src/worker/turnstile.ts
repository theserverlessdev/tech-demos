import { isLoopback } from "./http";
import { LOOPBACK_ADMIN_TOKEN, LOOPBACK_TURNSTILE_SECRET, LOOPBACK_TURNSTILE_SITE_KEY } from "./limits";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

type Siteverify = {
  success?: boolean;
  hostname?: string;
  "error-codes"?: string[];
};

export function turnstileSecret(env: Env, request: Request): string | null {
  const set = env.TURNSTILE_SECRET?.trim();
  if (set) return set;
  if (isLoopback(request)) return LOOPBACK_TURNSTILE_SECRET;
  return null;
}

export function turnstileSiteKey(env: Env, request: Request): string | null {
  const set = env.TURNSTILE_SITE_KEY?.trim();
  if (set) return set;
  if (isLoopback(request)) return LOOPBACK_TURNSTILE_SITE_KEY;
  return null;
}

export function writesOpen(env: Env, request: Request): boolean {
  return Boolean(turnstileSecret(env, request) && turnstileSiteKey(env, request));
}

/** wrangler dev advertises the zone route host, so URL loopback is not enough. Both dev values must match. */
export function devFixtureMode(env: Env, request: Request): boolean {
  if (isLoopback(request)) return true;
  return env.TURNSTILE_SECRET === LOOPBACK_TURNSTILE_SECRET && env.ADMIN_TOKEN === LOOPBACK_ADMIN_TOKEN;
}

export async function verifyTurnstile(env: Env, request: Request, token: string): Promise<boolean> {
  const secret = turnstileSecret(env, request);
  if (!secret) return false;
  if (!token || token.length > 2048) return false;

  let result: Siteverify;
  try {
    const res = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response: token, remoteip: request.headers.get("cf-connecting-ip") || undefined }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const parsed: unknown = await res.json();
    if (!parsed || typeof parsed !== "object") return false;
    result = parsed as Siteverify;
  } catch (err) {
    console.warn(JSON.stringify({ event: "turnstile_unreachable", error: String(err) }));
    return false;
  }

  if (!result.success) {
    console.warn(JSON.stringify({ event: "turnstile_failed", errors: result["error-codes"] ?? [] }));
    return false;
  }

  const host = result.hostname ?? "";
  const testHost = host === "example.com" || host === "localhost" || host === "127.0.0.1" || host === "";
  if (testHost) return true;
  const requestHost = new URL(request.url).hostname;
  return host === requestHost;
}
