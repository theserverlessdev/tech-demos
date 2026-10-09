import type { DemoEnv } from "./env";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const ACTION = "create-repo";

const TEST_SECRETS = new Set([
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);

const ALLOWED_HOSTS = new Set(["tech-demos.theserverless.dev", "memory-repo.tech-demos.theserverless.dev"]);

type Siteverify = {
  success?: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
};

export function turnstileConfigured(env: DemoEnv): boolean {
  return Boolean(env.TURNSTILE_SECRET?.trim() && env.TURNSTILE_SITE_KEY?.trim());
}

function localHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/** Fail closed when the production secret is missing. The always-pass test secret is local-only. */
export async function verifyTurnstile(env: DemoEnv, request: Request, token: string): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET?.trim() ?? "";
  if (!secret) return false;
  if (!token || token.length > 2048) return false;

  const headerHost = (request.headers.get("host") ?? "").split(":")[0]?.toLowerCase() ?? "";
  const urlHost = new URL(request.url).hostname;
  // wrangler types ENVIRONMENT as the committed "". .dev.vars sets "local" only for wrangler dev.
  const environment: string = env.ENVIRONMENT;
  const localDev = environment === "local";
  const requestHost = localHost(headerHost) ? headerHost : urlHost;
  if (TEST_SECRETS.has(secret) && !localHost(requestHost) && !localDev) return false;

  let result: Siteverify;
  try {
    const res = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret,
        response: token,
        remoteip: request.headers.get("cf-connecting-ip") ?? undefined,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    result = (await res.json()) as Siteverify;
  } catch {
    return false;
  }
  if (!result.success) {
    console.warn(JSON.stringify({ event: "turnstile_failed", errors: result["error-codes"] ?? [] }));
    return false;
  }
  const host = result.hostname ?? "";
  const dummyHost = TEST_SECRETS.has(secret) && (localHost(host) || host === "example.com");
  const hostOk = dummyHost || ALLOWED_HOSTS.has(host) || host.endsWith(".workers.dev");
  if (!hostOk) return false;
  if (!TEST_SECRETS.has(secret) && result.action && result.action !== ACTION) return false;
  return true;
}
