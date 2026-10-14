import { handleApi, HttpError, clientIp } from "./api";
import { hashIp, verifyJoinTicket } from "./ticket";
import { isLocalHost } from "./turnstile";
import { sanitizeName, slugifyRoom } from "../shared/types";

export { VibeRoom } from "./room";

/** The hub serves this demo under a path. The subdomain serves it at the root. */
const BASE_PATH = "/demos/goodvibes";

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

const ALLOWED_ORIGINS = [
  "https://tech-demos.theserverless.dev",
  "https://goodvibes.tech-demos.theserverless.dev",
  "https://tech-demos-goodvibes.theserverlessdev.workers.dev",
];

function isAllowedOrigin(origin: string | null, url: URL): boolean {
  if (!origin) return true;
  if (origin === url.origin || ALLOWED_ORIGINS.includes(origin)) return true;
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return false;
  return isLocalHost(url.hostname);
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

const ASSET_PATHS = new Set(["/", "/index.html", "/favicon.svg", "/favicon.ico"]);

async function serveAsset(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const allowed = path === "/" || ASSET_PATHS.has(path) || path.startsWith("/assets/");
  if (!allowed) return new Response("Not found", { status: 404 });
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
  if (!isAllowedOrigin(request.headers.get("origin"), new URL(request.url))) {
    return new Response("Origin not allowed", { status: 403 });
  }
  const { success } = await env.CONNECT_LIMIT.limit({ key: clientIp(request) });
  if (!success) return new Response("Too many connections from this address. Wait a minute.", { status: 429 });

  const joinSecret = (env.JOIN_SECRET ?? "").trim();
  if (!joinSecret) return new Response("Joining is off until JOIN_SECRET is set.", { status: 503 });

  const url = new URL(request.url);
  const room = slugifyRoom(roomRaw);
  const ticket = url.searchParams.get("ticket") ?? "";
  if (!(await verifyJoinTicket(joinSecret, ticket, room))) {
    return new Response("Join ticket missing or expired. Get a new one from the lobby.", { status: 403 });
  }

  const name = sanitizeName(url.searchParams.get("name") ?? request.headers.get("x-goodvibes-name"));
  const ipHash = await hashIp(clientIp(request));
  const headers = new Headers(request.headers);
  headers.delete("x-goodvibes-id");
  headers.set("x-goodvibes-room", room);
  headers.set("x-goodvibes-name", name);
  headers.set("x-goodvibes-ip", ipHash);
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
      let roomRaw: string;
      try {
        roomRaw = decodeURIComponent(wsMatch[1]!);
      } catch {
        return new Response("Bad room name", { status: 400 });
      }
      try {
        return await upgradeRoom(request, env, roomRaw);
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
