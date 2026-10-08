import { routePartykitRequest } from "partyserver";
import { BASE_PATH, ROOM_ID } from "../shared/protocol";
import { HttpError, handleApi } from "./api";
import { BoardRoom } from "./room";

export { BoardRoom };

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https://challenges.cloudflare.com https://cloudflareinsights.com",
  "frame-src https://challenges.cloudflare.com",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json(
      { error: { code: err.code, message: err.message } },
      { status: err.status, headers: { "cache-control": "no-store" } },
    );
  }
  console.error(JSON.stringify({ event: "api_error", error: err instanceof Error ? err.name : "unknown" }));
  return Response.json({ error: { code: "internal", message: "The server failed. Try again." } }, { status: 500 });
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

function stripBase(pathname: string): string {
  if (pathname === BASE_PATH) return pathname;
  if (pathname.startsWith(`${BASE_PATH}/`)) return pathname.slice(BASE_PATH.length) || "/";
  return pathname;
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
  const type = headers.get("content-type") ?? "";
  if (type.startsWith("text/html")) headers.set("content-security-policy", PAGE_CSP);
  if (type.startsWith("text/html") || type.includes("javascript")) headers.set("cache-control", "no-cache");
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === BASE_PATH) {
      url.pathname = `${BASE_PATH}/`;
      return Response.redirect(url.toString(), 308);
    }

    const logical = stripBase(path);

    if (logical.startsWith("/api/")) {
      try {
        return await handleApi(request, env, logical);
      } catch (err) {
        return errorResponse(err);
      }
    }

    if (logical.startsWith("/parties/")) {
      // Keep the original request so the WebSocket upgrade stays intact.
      // The prefix includes the hub path when the visitor is not on the subdomain.
      const prefix = path.startsWith(`${BASE_PATH}/`) ? `${BASE_PATH.slice(1)}/parties` : "parties";
      try {
        const routed = await routePartykitRequest(request, env, {
          prefix,
          onBeforeConnect: async (_req, lobby) => {
            if (lobby.className !== "BoardRoom" || !ROOM_ID.test(lobby.name)) {
              return new Response("Not found", { status: 404 });
            }
            const { success } = await env.CONNECT_LIMIT.limit({ key: clientIp(request) });
            if (!success) return new Response("Too many connections. Wait a minute.", { status: 429 });
          },
          onBeforeRequest: (req) => {
            const headers = new Headers(req.headers);
            headers.delete("x-party-internal");
            return new Request(req, { headers });
          },
        });
        if (routed) return routed;
      } catch (err) {
        console.error(JSON.stringify({ event: "party_route_failed", error: err instanceof Error ? err.name : "unknown" }));
        return new Response("The room is unavailable.", { status: 502 });
      }
    }

    return serveAsset(request, env, logical);
  },
} satisfies ExportedHandler<Env>;
