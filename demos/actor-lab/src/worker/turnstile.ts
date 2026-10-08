const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Published always-pass test secret. Local `.dev.vars` only. */
const TEST_SECRET = "1x0000000000000000000000000000000AA";
const TEST_SITE_KEY = "1x00000000000000000000AA";

const ALLOWED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "example.com",
  "tech-demos.theserverless.dev",
  "actor-lab.tech-demos.theserverless.dev",
]);

type Siteverify = {
  success?: boolean;
  hostname?: string;
  "error-codes"?: string[];
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type SecretEnv = Env & { TURNSTILE_SECRET?: string };

function secretOf(env: SecretEnv): string {
  return (env.TURNSTILE_SECRET ?? "").trim();
}

export function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

/**
 * Production AI stays off until a real widget secret is set. The published
 * test secret always passes, so it is accepted only on localhost.
 */
export function aiGate(env: Env, request: Request): "ready" | "off" {
  const secret = secretOf(env);
  const siteKey = (env.TURNSTILE_SITE_KEY ?? "").trim();
  const local = isLocalHost(new URL(request.url).hostname);
  if (!secret || !siteKey) return "off";
  if (!local && (secret === TEST_SECRET || siteKey === TEST_SITE_KEY)) return "off";
  return "ready";
}

function hostAllowed(host: string): boolean {
  if (ALLOWED_HOSTS.has(host)) return true;
  return host.endsWith(".workers.dev");
}

export async function assertTurnstile(env: Env, request: Request, token: unknown): Promise<void> {
  if (aiGate(env, request) === "off") {
    throw new HttpError(503, "turnstile_unconfigured", "AI runs are off until TURNSTILE_SECRET is a real widget secret and the site key is not the test key.");
  }
  if (typeof token !== "string" || token.length < 8 || token.length > 2048) {
    throw new HttpError(403, "turnstile_required", "Complete the Turnstile check first.");
  }
  const secret = secretOf(env);
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  let result: Siteverify;
  try {
    const res = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`siteverify_${res.status}`);
    result = (await res.json()) as Siteverify;
  } catch (err) {
    console.error(JSON.stringify({ event: "turnstile_unreachable", error: String(err) }));
    throw new HttpError(503, "turnstile_unreachable", "Could not reach Turnstile. Try again.");
  }
  if (!result.success) {
    console.warn(JSON.stringify({ event: "turnstile_failed", errors: result["error-codes"] ?? [] }));
    throw new HttpError(403, "turnstile_failed", "Turnstile check failed. Refresh and try again.");
  }
  if (secret === TEST_SECRET) return;
  if (!hostAllowed(result.hostname ?? "")) {
    throw new HttpError(403, "turnstile_failed", "Turnstile check failed. Refresh and try again.");
  }
}
