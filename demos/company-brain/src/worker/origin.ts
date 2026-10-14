function localHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  let host = "";
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  const url = new URL(request.url);
  if (origin === url.origin) return true;
  if (host === "tech-demos.theserverless.dev" || host === "company-brain.tech-demos.theserverless.dev") return true;
  if (localHost(host)) return localHost(url.hostname);
  return false;
}
