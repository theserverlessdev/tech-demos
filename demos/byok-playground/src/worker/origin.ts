import { HttpError } from "./errors";

export function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * `wrangler dev` rewrites the request URL to the first route host, so the
 * URL is not localhost. Cloudflare sets CF-Connecting-IP and does not let a
 * client spoof it; 127.0.0.1 only shows up under local dev.
 */
export function isLocalRequest(request: Request): boolean {
  const url = new URL(request.url);
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  return isLocalHost(url.hostname) || isLocalHost(ip);
}

export function clientIp(request: Request): string {
  return (request.headers.get("cf-connecting-ip") ?? "local").slice(0, 64);
}

const PROD_ORIGINS = new Set(["https://tech-demos.theserverless.dev", "https://byok-playground.tech-demos.theserverless.dev"]);

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) throw new HttpError(403, "origin", "Same-origin required.");
  const url = new URL(request.url);
  if (origin === url.origin) return;
  if (PROD_ORIGINS.has(origin) && (PROD_ORIGINS.has(url.origin) || isLocalRequest(request))) return;
  if (isLocalRequest(request) && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    throw new HttpError(403, "origin", "Same-origin required.");
  }
  throw new HttpError(403, "origin", "Same-origin required.");
}

export async function limit(binding: { limit(input: { key: string }): Promise<{ success: boolean }> }, request: Request, label: string): Promise<void> {
  const { success } = await binding.limit({ key: clientIp(request) });
  if (!success) throw new HttpError(429, "rate_limited", `Too many ${label}. Wait a minute.`);
}
