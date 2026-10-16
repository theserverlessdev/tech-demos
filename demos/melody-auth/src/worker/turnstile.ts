const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const ACTION = "melody-auth";

const TEST_SECRETS = new Set([
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);

export const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

const ALLOWED_HOSTS = new Set(["tech-demos.theserverless.dev", "melody-auth.tech-demos.theserverless.dev"]);

type Siteverify = {
  success?: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
};

function localHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function turnstileConfigured(env: Env): boolean {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim() ?? "";
  return Boolean(env.TURNSTILE_SECRET?.trim() && siteKey && siteKey !== "REPLACE_ME");
}

export async function verifyTurnstile(env: Env, request: Request, token: string): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET?.trim() ?? "";
  if (!secret) return false;
  if (!token || token.length > 2048) return false;

  const headerHost = (request.headers.get("host") ?? "").split(":")[0]?.toLowerCase() ?? "";
  const urlHost = new URL(request.url).hostname;
  const localDev = env.ENVIRONMENT === "local";
  const requestHost = localHost(headerHost) ? headerHost : urlHost;
  if (TEST_SECRETS.has(secret) && !localHost(requestHost) && !localDev) return false;
  if (TEST_SECRETS.has(secret) && token === DUMMY_TOKEN && (localHost(requestHost) || localDev)) return true;

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
  const hostOk = dummyHost || ALLOWED_HOSTS.has(host);
  if (!hostOk) return false;
  if (result.action !== ACTION && !(TEST_SECRETS.has(secret) && !result.action)) return false;
  return true;
}
