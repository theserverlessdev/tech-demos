import { handleApi, errorResponse, secretsFrom } from "./api";
import type { DemoEnv } from "./env";
import { finish, visitor } from "./session";

/** The hub serves this demo under a path. The subdomain serves it at the root. */
const BASE_PATH = "/demos/byok-playground";

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

async function serveAsset(request: Request, env: DemoEnv, path: string): Promise<Response> {
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
    const who = visitor(request);

    if (path === BASE_PATH) {
      url.pathname = `${BASE_PATH}/`;
      return finish(Response.redirect(url.toString(), 308), who.cookie);
    }
    if (path.startsWith(`${BASE_PATH}/`)) path = path.slice(BASE_PATH.length);

    try {
      if (path.startsWith("/api/")) return finish(await handleApi(request, env as DemoEnv, path), who.cookie);
      return finish(await serveAsset(request, env as DemoEnv, path), who.cookie);
    } catch (err) {
      return finish(errorResponse(err, secretsFrom(request)), who.cookie);
    }
  },
} satisfies ExportedHandler<Env>;
