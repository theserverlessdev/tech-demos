const ALLOWED_ORIGINS = [
  "https://tech-demos.theserverless.dev",
  "https://cloudflare-os.tech-demos.theserverless.dev",
  "https://tech-demos-cloudflare-os.theserverlessdev.workers.dev",
];

/**
 * Origin allowlist is defense-in-depth only. The workspace id is the capability;
 * there is no cookie or ambient auth, so a cross-site WebSocket does not inherit
 * a session. A missing Origin (non-browser clients, some same-origin WS) or a
 * localhost Origin is allowed so `wrangler dev` and the smoke script work.
 * This is not an authentication boundary.
 */
export function isAllowedOrigin(origin: string | null, url: URL): boolean {
  if (!origin) return true;
  if (origin === url.origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}
