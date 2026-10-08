import type { DemoEnv } from "./env";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

type Siteverify = {
  success?: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
};

export function turnstileConfigured(env: DemoEnv): boolean {
  return Boolean(env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY);
}

/** Fail closed when the production secret is missing. Local `.dev.vars` supplies the test secret. */
export async function verifyTurnstile(env: DemoEnv, token: string, ip: string, action: string): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET;
  if (!secret) return false;
  if (!token || token.length > 2048) return false;

  let result: Siteverify;
  try {
    const res = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response: token, remoteip: ip }),
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
  const testHost = host === "example.com" || host === "localhost" || host === "127.0.0.1";
  if (testHost) return true;
  if (result.action && result.action !== action) return false;
  return host === "theserverless.dev" || host.endsWith(".theserverless.dev") || host.endsWith(".workers.dev");
}
