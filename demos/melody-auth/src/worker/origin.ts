function localHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  // Missing Origin, or Chrome's "null" on a no-referrer navigational POST.
  if (!origin || origin === "null") return true;
  let host = "";
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  const url = new URL(request.url);
  if (origin === url.origin) return true;
  if (host === "tech-demos.theserverless.dev" || host === "melody-auth.tech-demos.theserverless.dev") return true;
  if (localHost(host)) return localHost(url.hostname);
  return false;
}

export function publicBase(request: Request, path: string): { origin: string; basePath: string; issuer: string } {
  const url = new URL(request.url);
  const onHub = path === "/demos/melody-auth" || path.startsWith("/demos/melody-auth/");
  const basePath = onHub ? "/demos/melody-auth" : "";
  return { origin: url.origin, basePath, issuer: `${url.origin}${basePath}` };
}
