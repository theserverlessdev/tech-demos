import { CANONICAL_HOST, HUB_BASE_PATH } from "../shared/limits";
import { errorResponse, handleApi } from "./api";
import { isLocalEnv } from "./env";

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https://challenges.cloudflare.com https://cloudflareinsights.com",
  "frame-src https://challenges.cloudflare.com",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function canonicalRedirect(request: Request, path: string): Response | null {
  const url = new URL(request.url);
  let rest = path;
  if (rest === HUB_BASE_PATH) rest = "/";
  else if (rest.startsWith(`${HUB_BASE_PATH}/`)) rest = rest.slice(HUB_BASE_PATH.length) || "/";
  if (url.hostname === CANONICAL_HOST && rest === path) return null;
  const dest = `https://${CANONICAL_HOST}${rest}${url.search}`;
  if (dest === url.href) return null;
  return Response.redirect(dest, 308);
}

async function serveAsset(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const assetUrl = new URL(request.url);
  assetUrl.pathname = path === "/" ? "/index.html" : path;
  let res = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method, headers: request.headers }));
  if (res.status === 404 && !path.startsWith("/assets/")) {
    assetUrl.pathname = "/index.html";
    res = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method, headers: request.headers }));
  }
  const headers = new Headers(res.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  if ((headers.get("content-type") ?? "").startsWith("text/html")) headers.set("content-security-policy", PAGE_CSP);
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    let path = url.pathname;

    if (isLocalEnv(env)) {
      if (path === HUB_BASE_PATH) {
        url.pathname = `${HUB_BASE_PATH}/`;
        return Response.redirect(url.toString(), 308);
      }
      if (path.startsWith(`${HUB_BASE_PATH}/`)) path = path.slice(HUB_BASE_PATH.length) || "/";
    } else {
      const redirected = canonicalRedirect(request, path);
      if (redirected) return redirected;
    }

    try {
      if (path.startsWith("/api/")) return await handleApi(request, env, path);
      return await serveAsset(request, env, path);
    } catch (err) {
      return errorResponse(err);
    }
  },
} satisfies ExportedHandler<Env>;
