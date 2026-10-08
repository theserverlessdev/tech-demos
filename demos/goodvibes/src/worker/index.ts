import { handleApi, HttpError } from "./api";
import { sanitizeName, slugifyRoom } from "../shared/types";

export { VibeRoom } from "./room";

/** The hub serves this demo under a path. The subdomain serves it at the root. */
const BASE_PATH = "/demos/goodvibes";

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

const ALLOWED_ORIGINS = [
  "https://tech-demos.theserverless.dev",
  "https://goodvibes.tech-demos.theserverless.dev",
  "https://tech-demos-goodvibes.theserverlessdev.workers.dev",
];

function isAllowedOrigin(origin: string | null, url: URL): boolean {
  if (!origin) return true;
  if (origin === url.origin || ALLOWED_ORIGINS.includes(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json(
      { error: { code: err.code, message: err.message } },
      { status: err.status, headers: { "cache-control": "no-store" } },
    );
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
  if (!isAllowedOrigin(request.headers.get("origin"), new URL(request.url))) {
    return new Response("Origin not allowed", { status: 403 });
  }
  const url = new URL(request.url);
  const room = slugifyRoom(roomRaw);
  const name = sanitizeName(url.searchParams.get("name") ?? request.headers.get("x-goodvibes-name"));
  const id = (url.searchParams.get("id") ?? "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40) || crypto.randomUUID();
  const headers = new Headers(request.headers);
  headers.set("x-goodvibes-room", room);
  headers.set("x-goodvibes-name", name);
  headers.set("x-goodvibes-id", id);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
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
