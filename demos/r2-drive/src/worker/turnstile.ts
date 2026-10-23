const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Cloudflare's published always-pass token. Honoured only for local dev. */
export const TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

export function loopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

export async function verifyTurnstile(
  token: string,
  request: Request,
  env: { TURNSTILE_SECRET?: string; TURNSTILE_LOCAL?: string },
): Promise<boolean> {
  let hostname = "";
  try {
    hostname = new URL(request.url).hostname;
  } catch {
    hostname = "";
  }
  const local = env.TURNSTILE_LOCAL === "1" || loopbackHost(hostname);
  if (local && token === TURNSTILE_DUMMY_TOKEN) return true;
  if (!token || token.length > 2048 || !env.TURNSTILE_SECRET) return false;
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  const remote = request.headers.get("cf-connecting-ip");
  if (remote) body.set("remoteip", remote);
  const response = await fetch(SITEVERIFY, { method: "POST", body });
  if (!response.ok) return false;
  const result = (await response.json()) as { success?: boolean };
  return result.success === true;
}
