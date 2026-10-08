const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Cloudflare's published always-pass test secret. It is not a production credential. */
const TEST_SECRET = "1x0000000000000000000000000000000AA";
/** Paired with the always-pass test site key. Accepted only on localhost. */
export const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

type Siteverify = {
  success: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
};

function localHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Fail closed when TURNSTILE_SECRET is missing.
 * The test secret only accepts the dummy token on localhost, so a production
 * deploy that still has the test secret does not let the public widget through.
 */
export async function verifyTurnstile(env: Env, token: string, request: Request): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET;
  if (!secret || !token || token.length > 2048) return false;

  const host = new URL(request.url).hostname;
  // The published test secret must not unlock a public hostname.
  if (secret === TEST_SECRET && !localHost(host)) return false;
  // Smoke tests send the documented dummy token and do not need a widget round-trip.
  if (secret === TEST_SECRET && token === DUMMY_TOKEN) return true;

  let result: Siteverify;
  try {
    const res = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response: token, remoteip: request.headers.get("cf-connecting-ip") ?? undefined }),
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
  // Local test keys report a dummy hostname. The request host was already required to be local.
  if (secret === TEST_SECRET) return true;
  if (result.action && result.action !== "company-brain") return false;
  return result.hostname === host;
}
