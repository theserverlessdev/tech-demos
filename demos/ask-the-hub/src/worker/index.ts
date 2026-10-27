import { handleApi, depsFromEnv } from "./api";
import { isLoopback } from "./turnstile";
import type { Env } from "./env";

export { AskCap } from "./ask-cap";

const BASE_PATH = "/demos/ask-the-hub";
const DEMO_HOST = "ask-the-hub.tech-demos.theserverless.dev";

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function demoHost(hostname: string): boolean {
  return hostname === DEMO_HOST || isLoopback(hostname);
}

async function serveAsset(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }
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
  const type = headers.get("content-type") ?? "";
  if (type.startsWith("text/html")) headers.set("content-security-policy", PAGE_CSP);
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === BASE_PATH || url.pathname.startsWith(`${BASE_PATH}/`)) {
      const rest = url.pathname.slice(BASE_PATH.length) || "/";
      return Response.redirect(`https://${DEMO_HOST}${rest}${url.search}`, 308);
    }
    const path = url.pathname;
    if (path.startsWith("/api/")) {
      if (!demoHost(url.hostname)) {
        return new Response("This demo is unavailable.", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      try {
        const response = await handleApi(request, depsFromEnv(env), path);
        if (response) return response;
      } catch (err) {
        console.log(JSON.stringify({ event: "api_error", name: err instanceof Error ? err.name : "error" }));
        return new Response(JSON.stringify({ error: "Search is unavailable right now.", code: "search_unavailable" }), {
          status: 502,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        });
      }
      return new Response("Not found", { status: 404 });
    }
    if (!demoHost(url.hostname)) {
      return Response.redirect(`https://${DEMO_HOST}${path}${url.search}`, 308);
    }
    return serveAsset(request, env, path);
  },
} satisfies ExportedHandler<Env>;
