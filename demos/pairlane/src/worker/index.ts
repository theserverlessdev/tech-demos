import { connectSources } from "../shared/ice";
import { BASE_PATH, DEMO_HOST, ROOM_ID } from "../shared/protocol";
import { HttpError, connectRoom, handleApi } from "./api";
import type { Env } from "./env";
import { localEnabled } from "./turnstile";

export { CreateCap } from "./cap-do";
export { PairRoom } from "./room";

function pageCsp(env: Env): string {
  const connect = connectSources(env.TURN_URLS).join(" ");
  return [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    `font-src https://fonts.gstatic.com`,
    "img-src 'self' data:",
    `connect-src ${connect}`,
    "frame-src https://challenges.cloudflare.com",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function logicalPath(pathname: string): { base: string; path: string } {
  if (pathname === BASE_PATH || pathname.startsWith(`${BASE_PATH}/`)) {
    return { base: BASE_PATH, path: pathname.slice(BASE_PATH.length) || "/" };
  }
  return { base: "", path: pathname };
}

function demoHost(hostname: string, local: boolean): boolean {
  if (hostname === DEMO_HOST || hostname === "tech-demos.theserverless.dev") return true;
  if (!local) return false;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json(
      { error: { code: err.code, message: err.message } },
      { status: err.status, headers: { "cache-control": "no-store" } },
    );
  }
  console.log(JSON.stringify({ event: "api_error", name: err instanceof Error ? err.name : "error" }));
  return Response.json(
    { error: { code: "internal", message: "The server failed. Try again." } },
    { status: 500, headers: { "cache-control": "no-store" } },
  );
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
  if (type.startsWith("text/html")) {
    headers.set("content-security-policy", pageCsp(env));
    headers.set("cache-control", "no-cache");
  }
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const { base, path } = logicalPath(url.pathname);
    const local = localEnabled(env.TURNSTILE_LOCAL) || url.hostname === "localhost" || url.hostname === "127.0.0.1";

    if (path === "/r" || path.startsWith("/r/")) {
      const id = path.slice(3).replace(/^\//, "");
      if (!ROOM_ID.test(id)) return new Response("Not found", { status: 404 });
      const target = new URL(request.url);
      target.pathname = `${base}/`;
      target.search = `?r=${id}`;
      return Response.redirect(target.toString(), 302);
    }

    if (url.pathname === BASE_PATH) {
      return Response.redirect(`${url.origin}${BASE_PATH}/${url.search}`, 308);
    }

    if (path.startsWith("/api/")) {
      if (!demoHost(url.hostname, local)) {
        return new Response("This demo is unavailable.", { status: 503 });
      }
      try {
        return await handleApi(request, env, path);
      } catch (err) {
        return errorResponse(err);
      }
    }

    const wsMatch = path.match(/^\/ws\/([a-z0-9]+)$/);
    if (wsMatch && request.method === "GET") {
      if (!demoHost(url.hostname, local)) return new Response("This demo is unavailable.", { status: 503 });
      return connectRoom(request, env, wsMatch[1] ?? "");
    }

    if (!demoHost(url.hostname, local) && url.hostname.endsWith(".theserverless.dev")) {
      return Response.redirect(`https://${DEMO_HOST}${path}${url.search}`, 302);
    }

    return serveAsset(request, env, path);
  },
} satisfies ExportedHandler<Env>;
