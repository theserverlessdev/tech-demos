import { ensureLocalApp, purgeExpired } from "./db";
import { BodyTooLargeError, HttpError, OauthError } from "./errors";
import { PAGE_CSP, corsJson, corsPreflight, json } from "./headers";
import { envSecret } from "./clients";
import { handleDeviceAuthorization, handleDevicePage } from "./device";
import { handleFederationCallback, handleFederationStart } from "./federation";
import { handleToken } from "./grants";
import { rotateSigningKeys } from "./jwks";
import { isLocalEnv, PROD_ORIGIN } from "./origin";
import {
  handleAuthorizeGet,
  handleAuthorizePost,
  handleConfig,
  handleConsentPost,
  handleDiscovery,
  handleJwks,
  handleLogout,
  handleUserinfo,
  limit,
  stripBase,
} from "./oidc";
import { handlePar } from "./par";
import { handleRegister } from "./register";
import { ensureMachineApp, ensureSampleMeta } from "./store";
import { handleAdminApi } from "./admin";
import { handleIntrospect, handleRevoke } from "./tokenops";

const BASE_PATH = "/demos/melody-auth";

let localSeeded = false;

function errorResponse(err: unknown, request?: Request): Response {
  if (err instanceof OauthError) {
    const payload = { error: err.error, error_description: err.description };
    return request ? corsJson(request, payload, err.status) : json(payload, err.status);
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
    path === "/playground" ||
    path === "/playground.html" ||
    path === "/favicon.svg" ||
    path.startsWith("/assets/")
  );
}

async function serveAsset(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  if (!assetPathAllowed(path)) return new Response("Not found", { status: 404, headers: { "x-content-type-options": "nosniff" } });
  const assetUrl = new URL(request.url);
  if (path === "/admin") assetUrl.pathname = "/admin.html";
  else if (path === "/playground") assetUrl.pathname = "/playground.html";
  else assetUrl.pathname = path === "/" ? "/index.html" : path;
  const res = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method, headers: request.headers }));
  const headers = new Headers(res.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "same-origin");
  if ((headers.get("content-type") ?? "").startsWith("text/html")) headers.set("content-security-policy", PAGE_CSP);
  return new Response(res.body, { status: res.status, headers });
}

async function seed(env: Env): Promise<void> {
  const now = Date.now();
  const machineSecret = envSecret(env, "MACHINE_CLIENT_SECRET") || (isLocalEnv(env) ? "melody-machine-secret" : "");
  const steps: Array<() => Promise<void>> = [
    async () => {
      if (isLocalEnv(env)) await ensureLocalApp(env.DB, now);
    },
    async () => {
      if (machineSecret) await ensureMachineApp(env.DB, now, machineSecret);
    },
    async () => {
      await ensureSampleMeta(env.DB, now, isLocalEnv(env));
    },
  ];
  const failures: string[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      failures.push(err instanceof Error ? err.name : "error");
    }
  }
  if (failures.length) throw new Error("seed");
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { path, onHub } = stripBase(url.pathname);

  if (!localSeeded) {
    try {
      await seed(env);
      localSeeded = true;
    } catch (err) {
      console.error(JSON.stringify({ event: "seed_failed", name: err instanceof Error ? err.name : "error" }));
    }
  }

  if (onHub && !isLocalEnv(env)) {
    const rest = `${url.pathname.slice(BASE_PATH.length) || "/"}${url.search}`;
    return Response.redirect(`${PROD_ORIGIN}${rest}`, 308);
  }

  if (url.pathname === BASE_PATH) {
    url.pathname = `${BASE_PATH}/`;
    return Response.redirect(url.toString(), 308);
  }

  if (request.method === "OPTIONS") return corsPreflight(request);

  if (path === "/.well-known/openid-configuration" && request.method === "GET") return handleDiscovery(request, env);
  if (path === "/.well-known/jwks.json" && request.method === "GET") return handleJwks(request, env);
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
  if (path === "/authorize" && request.method === "GET") {
    await limit(env.PAGE_LIMIT, request);
    return handleAuthorizeGet(request, env, onHub);
  }
  if (path === "/authorize" && request.method === "POST") return handleAuthorizePost(request, env, onHub);
  if (path === "/consent" && request.method === "POST") return handleConsentPost(request, env, onHub);
  if (path === "/token") return handleToken(request, env);
  if (path === "/userinfo" && request.method === "GET") {
    await limit(env.SESSION_LIMIT, request);
    return handleUserinfo(request, env);
  }
  if (path === "/logout" && (request.method === "GET" || request.method === "POST")) {
    await limit(env.SESSION_LIMIT, request);
    return handleLogout(request, env, onHub);
  }
  if (path === "/introspect") return handleIntrospect(request, env);
  if (path === "/revoke") return handleRevoke(request, env);
  if (path === "/par") return handlePar(request, env);
  if (path === "/device_authorization") return handleDeviceAuthorization(request, env);
  if (path === "/device") return handleDevicePage(request, env, onHub);
  if (path === "/register" || path.startsWith("/register/")) return handleRegister(request, env);
  const fed = /^\/fed\/([a-z]+)(?:\/callback)?$/.exec(path);
  if (fed?.[1]) {
    if (path.endsWith("/callback")) return handleFederationCallback(request, env, fed[1], onHub);
    return handleFederationStart(request, env, fed[1], onHub);
  }
  if (path === "/playground.html" || path === "/playground") {
    await limit(env.PLAY_LIMIT, request);
  }

  return serveAsset(request, env, path);
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (err) {
      return errorResponse(err, request);
    }
  },

  async scheduled(_event, env, ctx): Promise<void> {
    ctx.waitUntil(
      Promise.all([
        purgeExpired(env.DB, Date.now()),
        rotateSigningKeys(env),
      ])
        .then(([result, keys]) => console.log(JSON.stringify({ event: "cleanup", ...result, keys })))
        .catch((err: unknown) => console.error(JSON.stringify({ event: "cleanup_error", name: err instanceof Error ? err.name : "error" }))),
    );
  },
} satisfies ExportedHandler<Env>;
