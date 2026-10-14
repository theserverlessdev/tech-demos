/// <reference lib="dom" />

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

/**
 * Self-contained Dynamic Worker source that 302s `/demos/<slug>` to `origin`,
 * using the same boundary + `new URL` rules as `safeRedirectTarget`.
 */
export function redirectSource(slug: string, origin: string): string {
  return `export default {
  fetch(request) {
    const url = new URL(request.url);
    const slug = ${JSON.stringify(slug)};
    const origin = ${JSON.stringify(origin)};
    const prefix = "/demos/" + slug;
    const rest = url.pathname === prefix || url.pathname.startsWith(prefix + "/")
      ? url.pathname.slice(prefix.length) || "/"
      : url.pathname;
    const target = new URL(rest || "/", origin);
    if (target.origin !== new URL(origin).origin) {
      return new Response("Bad redirect", { status: 400 });
    }
    target.search = url.search;
    return Response.redirect(target.href, 302);
  },
};
`;
}
