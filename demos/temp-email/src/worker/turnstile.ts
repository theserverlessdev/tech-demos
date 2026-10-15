import { hostedMode } from "./auth";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const ACTION = "mint-key";

const DUMMY_SECRETS = new Set([
  "1x0000000000000000000000000000000AA",
  "1x0000000000000000000000000000000BB",
  "1x0000000000000000000000000000000CC",
]);

type Siteverify = {
  success: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
};

function allowTestHosts(env: Env, secret: string): boolean {
  return !hostedMode(env) || DUMMY_SECRETS.has(secret);
}

export async function verifyTurnstile(env: Env, token: string, ip: string): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET_KEY;
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
  let expected = "";
  try {
    expected = new URL(env.PUBLIC_ORIGIN).hostname;
  } catch {
    expected = "";
  }
  const testHost = host === "localhost" || host === "127.0.0.1" || host === "example.com";
  if (testHost && !allowTestHosts(env, secret)) return false;
  if (!testHost && result.action && result.action !== ACTION) return false;
  return testHost || host === expected;
}

export function mintEnabled(env: Env): boolean {
  return Boolean(env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY);
}
