const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITEVERIFY_TIMEOUT_MS = 5000;

/** Cloudflare's published always-pass token. Honoured only when TURNSTILE_LOCAL=1. */
export const TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

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
  if (env.TURNSTILE_LOCAL === "1" && token === TURNSTILE_DUMMY_TOKEN) return true;
  if (!token || token.length > 2048 || !env.TURNSTILE_SECRET || !hostname) return false;
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  const remote = request.headers.get("cf-connecting-ip");
  if (remote) body.set("remoteip", remote);
  let response: Response;
  try {
    response = await fetch(SITEVERIFY, { method: "POST", body, signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS) });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  const result = (await response.json()) as { success?: boolean; hostname?: string };
  return result.success === true && result.hostname === hostname;
}
