import { handleApi, HttpError } from "./api";
import { requireSession, sanitizeName } from "./session";
import { ensureRoom } from "./db";

export { ChatRoom } from "./room";

/** The hub serves this demo under a path. The subdomain serves it at the root. */
const BASE_PATH = "/demos/edgechat";

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https://cloudflareinsights.com",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status, headers: { "cache-control": "no-store" } });
  }
  console.error(JSON.stringify({ event: "api_error", error: String(err), stack: err instanceof Error ? err.stack : undefined }));
  return Response.json({ error: { code: "internal", message: "The server failed. Try again." } }, { status: 500 });
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

async function upgradeRoom(request: Request, env: Env, roomRaw: string): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }
  const session = await requireSession(env, request);
  const room = await ensureRoom(env, roomRaw);
  const headers = new Headers(request.headers);
  headers.set("x-edgechat-session", session.id);
  headers.set("x-edgechat-name", sanitizeName(session.displayName));
  headers.set("x-edgechat-room", room.id);
  const id = env.ROOM.idFromName(room.id);
  const stub = env.ROOM.get(id);
  // Forward the original upgrade request so the Hibernation API receives the WebSocket pair.
  return stub.fetch(new Request(request, { headers }));
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    let path = url.pathname;

    if (path === BASE_PATH) {
      url.pathname = `${BASE_PATH}/`;
      return Response.redirect(url.toString(), 308);
    }
    if (path.startsWith(`${BASE_PATH}/`)) path = path.slice(BASE_PATH.length);

    const wsMatch = path.match(/^\/ws\/([^/]+)$/);
    if (wsMatch) {
      try {
        return await upgradeRoom(request, env, decodeURIComponent(wsMatch[1]!));
      } catch (err) {
        return errorResponse(err);
      }
    }

    if (path.startsWith("/api/")) {
      try {
        return await handleApi(request, env, path);
      } catch (err) {
        return errorResponse(err);
      }
    }

    return serveAsset(request, env, path);
  },
} satisfies ExportedHandler<Env>;
