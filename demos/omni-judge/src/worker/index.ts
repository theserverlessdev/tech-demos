import { cleanupExpired } from "./db";
import { errorResponse, handleApi } from "./api";

const BASE_PATH = "/demos/omni-judge";

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' https://challenges.cloudflare.com https://cloudflareinsights.com",
  "frame-src https://challenges.cloudflare.com",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

async function serveAsset(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const assetUrl = new URL(request.url);
  assetUrl.pathname = path === "/" ? "/index.html" : path;
  let res = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method, headers: request.headers }));
  if (res.status === 404 && !path.startsWith("/assets/") && !path.startsWith("/samples/")) {
    assetUrl.pathname = "/index.html";
    res = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method, headers: request.headers }));
  }
  const headers = new Headers(res.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  const type = headers.get("content-type") ?? "";
  if (type.startsWith("text/html")) headers.set("content-security-policy", PAGE_CSP);
  if (path.startsWith("/samples/")) {
    headers.set("cross-origin-resource-policy", "same-origin");
    headers.set("x-robots-tag", "noindex");
    headers.set("cache-control", "public, max-age=3600");
  }
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === BASE_PATH) {
      url.pathname = `${BASE_PATH}/`;
      return Response.redirect(url.toString(), 308);
    }
    let path = url.pathname;
    if (path.startsWith(`${BASE_PATH}/`)) path = path.slice(BASE_PATH.length) || "/";
    if (path.startsWith("/api/")) {
      try {
        return await handleApi(request, env, path);
      } catch (err) {
        return errorResponse(err);
      }
    }
    return serveAsset(request, env, path);
  },

  async scheduled(_controller, env): Promise<void> {
    const result = await cleanupExpired(env, Date.now());
    console.log(JSON.stringify({ event: "cleanup", media: result.media, judgments: result.judgments }));
  },
} satisfies ExportedHandler<Env>;
