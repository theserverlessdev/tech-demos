const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const ACTION = "personal-agent";

const TEST_SECRETS = new Set([
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);

const ALLOWED_HOSTS = new Set(["tech-demos.theserverless.dev", "personal-agent.tech-demos.theserverless.dev"]);

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

function localHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

export async function verifyTurnstile(env: Env, request: Request, token: string): Promise<GateOk | GateFailure> {
  const secret = env.TURNSTILE_SECRET?.trim() ?? "";
  if (!secret) {
    return {
      ok: false,
      status: 503,
      code: "turnstile_unconfigured",
      message: "Turnstile is not configured, so chat and research are closed.",
    };
  }
  const headerHost = (request.headers.get("host") ?? "").split(":")[0]?.toLowerCase() ?? "";
  const urlHost = new URL(request.url).hostname;
  // `wrangler dev` rewrites Host to the first route, so local dev sets ENVIRONMENT=local in .dev.vars only.
  const localDev = env.ENVIRONMENT === "local";
  const requestHost = localHost(headerHost) ? headerHost : urlHost;
  // The always-pass test secret would disable the check on a public hostname.
  if (TEST_SECRETS.has(secret) && !localHost(requestHost) && !localDev) {
    return {
      ok: false,
      status: 503,
      code: "turnstile_unconfigured",
      message: "The Turnstile test secret is only accepted on localhost.",
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
      body: JSON.stringify({
        secret,
        response: token,
        remoteip: request.headers.get("cf-connecting-ip") ?? undefined,
      }),
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
  const dummyHost = TEST_SECRETS.has(secret) && (localHost(host) || host === "example.com");
  const hostOk = dummyHost || ALLOWED_HOSTS.has(host) || host.endsWith(".workers.dev");
  if (!hostOk) return { ok: false, status: 403, code: "turnstile_failed", message: "Turnstile was solved for a different site." };
  if (!TEST_SECRETS.has(secret) && result.action && result.action !== ACTION) {
    return { ok: false, status: 403, code: "turnstile_failed", message: "Turnstile was solved for a different action." };
  }
  return { ok: true };
}
