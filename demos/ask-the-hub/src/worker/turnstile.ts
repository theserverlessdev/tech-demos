const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Cloudflare's published always-pass test pair. Safe to commit. */
export const TEST_TURNSTILE_SECRET = "1x0000000000000000000000000000000AA";
export const TEST_TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
export const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LOCAL_HOSTS = new Set([...LOOPBACK, "example.com"]);

export type VerifyResult = "ok" | "missing" | "rejected";

export function devEnabled(value: string | undefined): boolean {
  return value === "1";
}

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

export function isLocalHostname(host: string): boolean {
  return LOCAL_HOSTS.has(host);
}

/** Dummy token, test site key, or test secret used as a token. */
export function isTestToken(token: string): boolean {
  return token === DUMMY_TOKEN || token === TEST_TURNSTILE_SECRET || token === TEST_TURNSTILE_SITE_KEY;
}

export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const TURNSTILE_ACTION = "ask-the-hub";

const WIDGET_HOSTS = new Set(["tech-demos.theserverless.dev", "ask-the-hub.tech-demos.theserverless.dev"]);

export function allowedWidgetHost(host: string, dev = false): boolean {
  if (WIDGET_HOSTS.has(host)) return true;
  return dev && isLocalHostname(host);
}

type Siteverify = { success?: boolean; hostname?: string; action?: string };

/**
 * Production rejects a missing token, a failed siteverify, the dummy token,
 * the test secret, and any siteverify hostname of localhost. Those pass only
 * when DEV=1.
 */
export async function verifyTurnstile(opts: {
  secret: string;
  token: string;
  ip: string;
  dev: boolean;
  fetchImpl?: typeof fetch;
}): Promise<VerifyResult> {
  const token = opts.token.trim();
  if (!token) return "missing";
  const secret = opts.secret.trim();
  const testSecret = secret === TEST_TURNSTILE_SECRET || secret === "";
  if (!opts.dev && (isTestToken(token) || testSecret)) return "rejected";
  if (opts.dev && isTestToken(token)) return "ok";
  if (!secret) return "rejected";

  const fetchImpl = opts.fetchImpl ?? fetch;
  let result: Siteverify;
  try {
    const res = await fetchImpl(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response: token, remoteip: opts.ip || undefined }),
    });
    if (!res.ok) return "rejected";
    result = (await res.json()) as Siteverify;
  } catch {
    return "rejected";
  }
  if (!result.success) return "rejected";
  if (!allowedWidgetHost(result.hostname ?? "", opts.dev)) return "rejected";
  if (result.action !== TURNSTILE_ACTION) return "rejected";
  return "ok";
}
