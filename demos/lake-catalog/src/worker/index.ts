import { DEV_CONNECTION_SECRET, DEV_JWT_SECRET } from "../shared/jwt";
import { bucketName, CATALOGS, dataPath, type CatalogId } from "../shared/rows";
import type { ClaimResult } from "../shared/cap";
import type { QueryResult } from "../shared/sql";
import { CatalogRegistry } from "./registry";
import { QuackCatalog } from "./catalog";
import type { Env } from "./env";
import { handleRequest, type Deps, type MapPayload } from "./http";
import { devEnabled, isLocalHostname, verifyTurnstile } from "./turnstile";

export { CatalogRegistry, QuackCatalog };

const BASE_PATH = "/demos/lake-catalog";
const DEMO_HOST = "lake-catalog.tech-demos.theserverless.dev";

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

function demoHost(hostname: string, dev: boolean): boolean {
  const name = hostname.toLowerCase().split(":")[0] ?? "";
  if (name === DEMO_HOST) return true;
  return dev && isLocalHostname(name);
}

export function depsFromEnv(env: Env): Deps {
  const dev = devEnabled(env.DEV);
  const bucket = bucketName(env.LAKE_BUCKET);
  const ttl = Number(env.TOKEN_TTL_SECONDS);
  const registryId = env.CATALOG_REGISTRY.idFromName("global");
  const registry = env.CATALOG_REGISTRY.get(registryId);
  const stub = (catalog: CatalogId) => env.CATALOGS.get(env.CATALOGS.idFromName(catalog));
  return {
    dev,
    siteKey: env.TURNSTILE_SITE_KEY || "0x4AAAAAAFRUoj5qDpf7XyIW",
    jwtSecret: env.QUACK_JWT_SECRET || (dev ? DEV_JWT_SECRET : null),
    connectionSecret: env.CONNECTION_SIGNING_SECRET || (dev ? DEV_CONNECTION_SECRET : null),
    bucket,
    ttlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : 600,
    now: () => Date.now(),
    async limit(name, key) {
      const binding = name === "QUERY_LIMIT" ? env.QUERY_LIMIT : name === "TOKEN_LIMIT" ? env.TOKEN_LIMIT : env.READ_LIMIT;
      const result = await binding.limit({ key });
      return result.success;
    },
    verify: (token, ip) => verifyTurnstile({ secret: env.TURNSTILE_SECRET ?? "", token, ip, dev }),
    async charge() {
      const response = await registry.fetch("https://registry/charge", { method: "POST", body: "{}" });
      return (await response.json()) as ClaimResult;
    },
    async resolveCatalog(catalog) {
      const response = await registry.fetch("https://registry/resolve", {
        method: "POST",
        body: JSON.stringify({ catalog }),
      });
      return response.ok;
    },
    async queryCatalog(catalog, role, sql) {
      const response = await stub(catalog).fetch(`https://catalog/query?catalog=${catalog}`, {
        method: "POST",
        body: JSON.stringify({ role, sql }),
      });
      if (!response.ok) throw new Error("catalog_query_failed");
      return (await response.json()) as QueryResult;
    },
    async status(): Promise<MapPayload> {
      const catalogs = [];
      for (const id of CATALOGS) {
        const response = await stub(id).fetch(`https://catalog/status?catalog=${id}`);
        const body = (await response.json()) as { rows?: number; parquet?: boolean };
        catalogs.push({
          id,
          durableObjectId: env.CATALOGS.idFromName(id).toString(),
          dataPath: dataPath(bucket, id),
          rows: Number(body.rows ?? 0),
          parquet: Boolean(body.parquet),
        });
      }
      return { registryId: registryId.toString(), catalogs };
    },
    async reset() {
      for (const id of CATALOGS) {
        await stub(id).fetch(`https://catalog/reset?catalog=${id}`, { method: "POST", body: "{}" });
      }
      console.log(JSON.stringify({ event: "nightly_reset", catalogs: CATALOGS.length }));
    },
  };
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
    const dev = devEnabled(env.DEV);
    if (url.pathname === BASE_PATH || url.pathname.startsWith(`${BASE_PATH}/`)) {
      const rest = url.pathname.slice(BASE_PATH.length) || "/";
      return Response.redirect(`https://${DEMO_HOST}${rest}${url.search}`, 308);
    }
    const path = url.pathname;
    if (path.startsWith("/api/") || path === "/quack") {
      try {
        const response = await handleRequest(request, depsFromEnv(env), path);
        if (response) return response;
      } catch (err) {
        console.log(JSON.stringify({ event: "api_error", name: err instanceof Error ? err.name : "error" }));
        return new Response(JSON.stringify({ error: "The catalog is unavailable right now.", code: "unavailable" }), {
          status: 502,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        });
      }
      return new Response("Not found", { status: 404 });
    }
    if (!demoHost(url.hostname, dev)) {
      return Response.redirect(`https://${DEMO_HOST}${path}${url.search}`, 308);
    }
    return serveAsset(request, env, path);
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(depsFromEnv(env).reset());
  },
} satisfies ExportedHandler<Env>;
