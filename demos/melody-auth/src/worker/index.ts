import { ensureLocalApp, purgeExpired } from "./db";
import { BodyTooLargeError, HttpError, OauthError } from "./errors";
import { PAGE_CSP, json } from "./headers";
import {
  handleAuthorizeGet,
  handleAuthorizePost,
  handleConfig,
  handleDiscovery,
  handleJwks,
  handleLogout,
  handleToken,
  handleUserinfo,
  limit,
  stripBase,
} from "./oidc";
import { handleAdminApi } from "./admin";
import { isLocalEnv, PROD_ORIGIN } from "./origin";

const BASE_PATH = "/demos/melody-auth";

let localSeeded = false;

function errorResponse(err: unknown): Response {
  if (err instanceof OauthError) {
    return json({ error: err.error, error_description: err.description }, err.status);
  }
  if (err instanceof HttpError) {
    return json({ error: { code: err.code, message: err.message } }, err.status);
  }
  if (err instanceof BodyTooLargeError) {
    return json({ error: { code: err.code, message: err.message } }, err.status);
  }
  console.error(JSON.stringify({ event: "api_error", name: err instanceof Error ? err.name : "error" }));
  return json({ error: { code: "internal", message: "The server failed. Try again." } }, 500);
}

function assetPathAllowed(path: string): boolean {
  return (
    path === "/" ||
    path === "/index.html" ||
    path === "/admin" ||
    path === "/admin.html" ||
    path === "/callback" ||
    path === "/favicon.svg" ||
    path.startsWith("/assets/")
  );
}

async function serveAsset(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  if (!assetPathAllowed(path)) return new Response("Not found", { status: 404, headers: { "x-content-type-options": "nosniff" } });
  const assetUrl = new URL(request.url);
  if (path === "/admin") assetUrl.pathname = "/admin.html";
  else if (path === "/callback") assetUrl.pathname = "/index.html";
  else assetUrl.pathname = path === "/" ? "/index.html" : path;
  const res = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method, headers: request.headers }));
  const headers = new Headers(res.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "same-origin");
  if ((headers.get("content-type") ?? "").startsWith("text/html")) headers.set("content-security-policy", PAGE_CSP);
  return new Response(res.body, { status: res.status, headers });
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { path, onHub } = stripBase(url.pathname);

  if (isLocalEnv(env) && !localSeeded) {
    await ensureLocalApp(env.DB, Date.now());
    localSeeded = true;
  }

  if (onHub && !isLocalEnv(env)) {
    const rest = `${url.pathname.slice(BASE_PATH.length) || "/"}${url.search}`;
    return Response.redirect(`${PROD_ORIGIN}${rest}`, 308);
  }

  if (url.pathname === BASE_PATH) {
    url.pathname = `${BASE_PATH}/`;
    return Response.redirect(url.toString(), 308);
  }

  if (path === "/.well-known/openid-configuration" && request.method === "GET") return handleDiscovery(request, env);
  if (path === "/.well-known/jwks.json" && request.method === "GET") return handleJwks(env);
  if (path === "/api/health" && request.method === "GET") {
    let d1 = false;
    try {
      const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      d1 = row?.ok === 1;
    } catch {
      d1 = false;
    }
    return json(
      { ok: d1, d1, turnstile: Boolean(env.TURNSTILE_SECRET), keys: Boolean(env.AUTH_PRIVATE_JWK) },
      d1 ? 200 : 503,
    );
  }
  if (path === "/api/config" && request.method === "GET") return handleConfig(request, env);
  if (path.startsWith("/api/admin")) return handleAdminApi(request, env, path);
  if (path === "/authorize" && request.method === "GET") return handleAuthorizeGet(request, env, onHub);
  if (path === "/authorize" && request.method === "POST") return handleAuthorizePost(request, env, onHub);
  if (path === "/token") return handleToken(request, env);
  if (path === "/userinfo" && request.method === "GET") {
    await limit(env.SESSION_LIMIT, request);
    return handleUserinfo(request, env);
  }
  if (path === "/logout" && (request.method === "GET" || request.method === "POST")) {
    await limit(env.SESSION_LIMIT, request);
    return handleLogout(request, env, onHub);
  }

  return serveAsset(request, env, path);
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (err) {
      return errorResponse(err);
    }
  },

  async scheduled(_event, env, ctx): Promise<void> {
    ctx.waitUntil(
      purgeExpired(env.DB, Date.now())
        .then((result) => console.log(JSON.stringify({ event: "cleanup", ...result })))
        .catch((err: unknown) => console.error(JSON.stringify({ event: "cleanup_error", name: err instanceof Error ? err.name : "error" }))),
    );
  },
} satisfies ExportedHandler<Env>;
