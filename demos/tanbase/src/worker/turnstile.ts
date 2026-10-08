import { HttpError } from "./errors";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TEST_HOSTS = new Set(["localhost", "127.0.0.1", "example.com"]);

type Siteverify = {
  success?: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
};

export function turnstileConfigured(env: Env): boolean {
  return Boolean(env.TURNSTILE_SECRET?.trim() && env.TURNSTILE_SITE_KEY?.trim());
}

export async function verifyTurnstile(env: Env, request: Request, token: unknown, action: string): Promise<void> {
  const secret = env.TURNSTILE_SECRET?.trim() ?? "";
  if (!secret) throw new HttpError(503, "turnstile_unconfigured", "Turnstile is not configured on this Worker.");
  if (typeof token !== "string" || token.length < 1 || token.length > 2048) {
    throw new HttpError(400, "turnstile_required", "Complete the Turnstile check and try again.");
  }

  let result: Siteverify;
  try {
    const res = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret,
        response: token,
        remoteip: request.headers.get("cf-connecting-ip") || undefined,
        idempotency_key: crypto.randomUUID(),
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new HttpError(503, "turnstile_unavailable", "Turnstile could not be checked. Try again.");
    result = (await res.json()) as Siteverify;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(503, "turnstile_unavailable", "Turnstile could not be checked. Try again.");
  }

  if (!result.success) {
    console.warn(JSON.stringify({ event: "turnstile_failed", errors: result["error-codes"] ?? [] }));
    throw new HttpError(403, "turnstile_failed", "Turnstile rejected that check.");
  }

  const host = result.hostname ?? "";
  if (!TEST_HOSTS.has(host) && result.action && result.action !== action) {
    throw new HttpError(403, "turnstile_failed", "Turnstile rejected that check.");
  }
}
