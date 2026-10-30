const DEMO_HOSTS = new Set(["pairlane.tech-demos.theserverless.dev", "tech-demos.theserverless.dev"]);

/**
 * Browser Origin for room creation and the signalling socket.
 * Production allows the two demo hosts over https. Local mode also allows loopback.
 */
export function allowedRequestOrigin(origin: string | null, local: boolean): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (DEMO_HOSTS.has(host)) return url.protocol === "https:";
  if (!local) return false;
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return false;
  return url.protocol === "http:" || url.protocol === "https:";
}
