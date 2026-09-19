const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

type Siteverify = {
  success: boolean;
  hostname?: string;
  "error-codes"?: string[];
};

export async function verifyTurnstile(env: Env, token: string, ip: string): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return true;
  if (!token || token.length > 2048) return false;
  try {
    const res = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const result = (await res.json()) as Siteverify;
    if (!result.success) {
      console.warn(JSON.stringify({ event: "turnstile_failed", errors: result["error-codes"] ?? [] }));
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
