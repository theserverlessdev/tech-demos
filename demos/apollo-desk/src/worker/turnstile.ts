const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const ACTION = "apollo-desk";

const TEST_SECRETS = new Set([
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);

const ALLOWED_HOSTS = new Set(["tech-demos.theserverless.dev", "apollo-desk.tech-demos.theserverless.dev"]);

export const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";
export const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";
export const TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

type Siteverify = {
  success?: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
};

export type GateFailure = { ok: false; status: number; code: string; message: string };
export type GateOk = { ok: true };

export function turnstileConfigured(env: Env): boolean {
  return Boolean(env.TURNSTILE_SECRET?.trim());
}

export function isTestSiteKey(siteKey: string | undefined): boolean {
  return (siteKey?.trim() || TURNSTILE_TEST_SITE_KEY) === TURNSTILE_TEST_SITE_KEY;
}

export function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * `wrangler dev` rewrites the request URL to the first route host, so the
 * URL is not localhost. Cloudflare sets CF-Connecting-IP and does not let a
 * client spoof it; 127.0.0.1 only shows up under local dev.
 */
export function isLocalRequest(hostname: string, ip: string, environment: string): boolean {
  return isLocalHost(hostname) || isLocalHost(ip) || environment === "local";
}

export function resolveTurnstileSecret(hostname: string, ip: string, environment: string, configured: string | undefined): { ok: true; secret: string; test: boolean } | { ok: false; reason: "missing" | "test_secret" } {
  const local = isLocalRequest(hostname, ip, environment);
  const secret = configured?.trim() ?? "";
  if (!secret) {
    if (local) return { ok: true, secret: TURNSTILE_TEST_SECRET, test: true };
    return { ok: false, reason: "missing" };
  }
  if (TEST_SECRETS.has(secret) && !local) return { ok: false, reason: "test_secret" };
  return { ok: true, secret, test: TEST_SECRETS.has(secret) };
}

export async function verifyTurnstile(env: Env, token: string, ip: string, hostname: string): Promise<GateOk | GateFailure> {
  const resolved = resolveTurnstileSecret(hostname, ip, env.ENVIRONMENT, env.TURNSTILE_SECRET);
  if (!resolved.ok) {
    return {
      ok: false,
      status: 503,
      code: "turnstile_unconfigured",
      message:
        resolved.reason === "test_secret"
          ? "The Turnstile test secret is only accepted on localhost."
          : "Turnstile is not configured, so the desk's AI paths are closed.",
    };
  }
  if (!token || token.length > 2048) {
    return { ok: false, status: 403, code: "turnstile_required", message: "Complete the Turnstile check and try again." };
  }

  let result: Siteverify;
  try {
    const res = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: resolved.secret, response: token, remoteip: ip && !isLocalHost(ip) ? ip : undefined }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, status: 403, code: "turnstile_failed", message: "Turnstile could not be verified. Try again." };
    result = (await res.json()) as Siteverify;
  } catch {
    return { ok: false, status: 403, code: "turnstile_failed", message: "Turnstile could not be verified. Try again." };
  }

  if (!result.success) {
    console.warn(JSON.stringify({ event: "turnstile_failed", errors: result["error-codes"] ?? [] }));
    return { ok: false, status: 403, code: "turnstile_failed", message: "The Turnstile check failed. Try again." };
  }

  const host = result.hostname ?? "";
  const dummyHost = resolved.test && (isLocalHost(host) || host === "example.com");
  const hostOk = dummyHost || ALLOWED_HOSTS.has(host) || host.endsWith(".workers.dev") || host.endsWith(".theserverless.dev");
  if (!hostOk) return { ok: false, status: 403, code: "turnstile_failed", message: "Turnstile was solved for a different site." };
  if (!resolved.test && result.action && result.action !== ACTION) {
    return { ok: false, status: 403, code: "turnstile_failed", message: "Turnstile was solved for a different action." };
  }
  return { ok: true };
}
