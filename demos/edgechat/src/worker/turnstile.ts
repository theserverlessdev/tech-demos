import { isLoopback, isLoopbackHost } from "./http";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Cloudflare's published always-pass test credentials. Not a production secret. */
export const TEST_TURNSTILE_SECRET = "1x0000000000000000000000000000000AA";
export const TEST_TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
export const TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

type Siteverify = {
  success?: boolean;
  hostname?: string;
  "error-codes"?: string[];
};

type SecretEnv = Env & { TURNSTILE_SECRET?: string; TURNSTILE_LOCAL?: string };

export function turnstileSecret(env: Env, request: Request): string | null {
  const set = (env as SecretEnv).TURNSTILE_SECRET?.trim();
  if (set) return set;
  if (isLoopback(request) || allowTestCredentials(env)) return TEST_TURNSTILE_SECRET;
  return null;
}

export function turnstileSiteKey(env: Env, request: Request): string | null {
  const set = env.TURNSTILE_SITE_KEY?.trim();
  if (set) return set;
  if (isLoopback(request) || allowTestCredentials(env)) return TEST_TURNSTILE_SITE_KEY;
  return null;
}

export function allowTestCredentials(env: Env): boolean {
  return String((env as SecretEnv).TURNSTILE_LOCAL ?? "") === "1";
}

/**
 * Room writes fail closed until a site key and secret are set.
 * The published always-pass pair is accepted only on loopback or when
 * TURNSTILE_LOCAL=1 (.dev.vars). wrangler dev rewrites Host to the zone route.
 */
export function writesOpen(env: Env, request: Request): boolean {
  const secret = turnstileSecret(env, request);
  const siteKey = turnstileSiteKey(env, request);
  if (!secret || !siteKey) return false;
  const test = secret === TEST_TURNSTILE_SECRET || siteKey === TEST_TURNSTILE_SITE_KEY;
  if (test && !isLoopback(request) && !allowTestCredentials(env)) return false;
  return true;
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
  if (host === "example.com" || isLoopbackHost(host) || host === "") return true;
  return host === new URL(request.url).hostname;
}
