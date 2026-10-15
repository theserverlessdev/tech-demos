/** Strip a `/demos/<slug>` prefix only when the next char is `/` or end-of-string. */
export function rewriteDemoPath(pathname: string, slug: string): string {
  const prefix = `/demos/${slug}`;
  if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
    return pathname.slice(prefix.length) || "/";
  }
  return pathname;
}

/**
 * Build a same-origin redirect for a hub `/demos/<slug>` URL.
 * Returns null when `origin` is not a valid absolute URL or the resolved
 * target would leave that origin (open-redirect / path-escape).
 *
 * Self-contained copy of the hub redirect helper so this Worker folder
 * builds on its own (Deploy to Cloudflare button and a copied directory).
 */
export function safeRedirectTarget(requestUrl: URL | string, slug: string, origin: string): URL | null {
  const url = typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return null;
  }
  const rest = rewriteDemoPath(url.pathname, slug);
  let target: URL;
  try {
    target = new URL(rest || "/", base);
  } catch {
    return null;
  }
  if (target.origin !== base.origin) return null;
  target.search = url.search;
  return target;
}
