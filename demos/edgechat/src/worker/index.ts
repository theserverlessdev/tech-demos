import { handleApi } from "./api";
import { getRoom } from "./db";
import { BASE_PATH, clientIp, HttpError, isAllowedOrigin, safeDecode, stripEdgechatHeaders } from "./http";
import { pruneOldData } from "./prune";
import { requirePersistedSession, sanitizeName } from "./session";

export { ChatRoom } from "./room";

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

const STATIC_PATHS = new Set(["/", "/index.html", "/favicon.svg"]);

function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status, headers: { "cache-control": "no-store" } });
  }
  console.error(JSON.stringify({ event: "api_error", error: String(err), stack: err instanceof Error ? err.stack : undefined }));
  return Response.json({ error: { code: "internal", message: "The server failed. Try again." } }, { status: 500 });
}

async function serveAsset(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  if (!STATIC_PATHS.has(path) && !path.startsWith("/assets/")) {
    return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  }
  const assetUrl = new URL(request.url);
  assetUrl.pathname = path === "/" ? "/index.html" : path;
  const res = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method, headers: request.headers }));
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
  const url = new URL(request.url);
  if (!isAllowedOrigin(request.headers.get("origin"), url)) {
    return new Response("Origin not allowed", { status: 403 });
  }
  const { success } = await env.CONNECT_LIMIT.limit({ key: clientIp(request) });
  if (!success) return new Response("Too many connections. Wait a minute.", { status: 429 });

  const session = await requirePersistedSession(env, request);
  const room = await getRoom(env, roomRaw);
  if (!room) throw new HttpError(404, "not_found", "No room with that name. Create it first.");

  const headers = stripEdgechatHeaders(request.headers);
  headers.set("x-edgechat-public", session.publicId);
  headers.set("x-edgechat-name", encodeURIComponent(sanitizeName(session.displayName)));
  headers.set("x-edgechat-room", encodeURIComponent(room.id));
  headers.set("x-edgechat-ip", clientIp(request));
  headers.set("x-edgechat-room-json", encodeURIComponent(JSON.stringify(room)));
  const id = env.ROOM.idFromName(room.id);
  const stub = env.ROOM.get(id);
  return stub.fetch(new Request(request, { headers }));
}

export default {
  async fetch(request, env): Promise<Response> {
    const incoming = new Request(request, { headers: stripEdgechatHeaders(request.headers) });
    let url: URL;
    try {
      url = new URL(incoming.url);
    } catch {
      return errorResponse(new HttpError(400, "bad_path", "That path is not valid."));
    }
    let path = url.pathname;

    if (path === BASE_PATH) {
      url.pathname = `${BASE_PATH}/`;
      return Response.redirect(url.toString(), 308);
    }
    if (path.startsWith(`${BASE_PATH}/`)) {
      path = path.slice(BASE_PATH.length) || "/";
    } else if (path.startsWith(BASE_PATH)) {
      return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    }

    const wsMatch = path.match(/^\/ws\/([^/]+)$/);
    if (wsMatch) {
      try {
        return await upgradeRoom(incoming, env, safeDecode(wsMatch[1]!));
      } catch (err) {
        return errorResponse(err);
      }
    }

    if (path.startsWith("/api/")) {
      try {
        return await handleApi(incoming, env, path);
      } catch (err) {
        return errorResponse(err);
      }
    }

    return serveAsset(incoming, env, path);
  },

  async scheduled(_event, env): Promise<void> {
    const result = await pruneOldData(env);
    console.log(JSON.stringify({ event: "prune", ...result }));
  },
} satisfies ExportedHandler<Env>;
