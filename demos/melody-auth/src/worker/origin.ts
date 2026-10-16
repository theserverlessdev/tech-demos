function localHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export const PROD_ORIGIN = "https://melody-auth.tech-demos.theserverless.dev";

export function originAllowed(request: Request): boolean {
  if ((request.headers.get("sec-fetch-site") ?? "").toLowerCase() === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (origin === "null") return false;
  if (!origin) return true;
  let host = "";
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  const url = new URL(request.url);
  if (origin === url.origin) return true;
  if (host === "melody-auth.tech-demos.theserverless.dev") return origin === PROD_ORIGIN;
  if (localHost(host)) return localHost(url.hostname);
  return false;
}

export function isLocalEnv(env: { ENVIRONMENT?: string }): boolean {
  return String(env.ENVIRONMENT) === "local";
}

export function publicBase(request: Request, env: { ENVIRONMENT?: string }): { origin: string; issuer: string } {
  const url = new URL(request.url);
  if (isLocalEnv(env) || localHost(url.hostname)) {
    return { origin: url.origin, issuer: url.origin };
  }
  return { origin: PROD_ORIGIN, issuer: PROD_ORIGIN };
}
