const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export const TEST_TURNSTILE_SECRET = "1x0000000000000000000000000000000AA";
export const TEST_TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
export const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LOCAL_HOSTS = new Set([...LOOPBACK, "example.com"]);

export type VerifyResult = "ok" | "missing" | "rejected";

export function devEnabled(value: string | undefined): boolean {
  return value === "1";
}

export function isLocalHostname(host: string): boolean {
  return LOCAL_HOSTS.has(host);
}

export function isTestToken(token: string): boolean {
  return token === DUMMY_TOKEN || token === TEST_TURNSTILE_SECRET || token === TEST_TURNSTILE_SITE_KEY;
}

/** theserverless.dev and its subdomains. Local names only while DEV=1. */
export function allowedWidgetHost(host: string, dev = false): boolean {
  const name = host.toLowerCase().split(":")[0] ?? "";
  if (name === "theserverless.dev" || name.endsWith(".theserverless.dev")) return true;
  return dev && isLocalHostname(name);
}

type Siteverify = { success?: boolean; hostname?: string };

export async function verifyTurnstile(opts: {
  secret: string;
  token: string;
  ip: string;
  dev: boolean;
  fetchImpl?: typeof fetch;
}): Promise<VerifyResult> {
  const token = opts.token.trim();
  if (!token) return "missing";
  const secret = opts.secret.trim();
  const testSecret = secret === TEST_TURNSTILE_SECRET || secret === "";
  if (!opts.dev && (isTestToken(token) || testSecret)) return "rejected";
  if (opts.dev && isTestToken(token)) return "ok";
  if (!secret) return "rejected";

  const fetchImpl = opts.fetchImpl ?? fetch;
  let result: Siteverify;
  try {
    const res = await fetchImpl(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response: token, remoteip: opts.ip || undefined }),
    });
    if (!res.ok) return "rejected";
    result = (await res.json()) as Siteverify;
  } catch {
    return "rejected";
  }
  if (!result.success) return "rejected";
  if (!allowedWidgetHost(result.hostname ?? "", opts.dev)) return "rejected";
  return "ok";
}
