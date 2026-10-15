import { HUB_BASE_PATH } from "../shared/limits";
import type { InboundMail } from "../shared/types";
import { handleApi, HttpError } from "./api";
import { PermanentInboundError } from "./errors";
import { ingestInbound } from "./inbound";
import { sweep } from "./sweep";

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
    return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status, headers: { "cache-control": "no-store" } });
  }
  console.error(JSON.stringify({ event: "api_error", error: String(err), stack: err instanceof Error ? err.stack : undefined }));
  return Response.json({ error: { code: "internal", message: "The server failed. Try again." } }, { status: 500 });
}

function appRoot(request: Request, pathHadBase: boolean): string {
  const url = new URL(request.url);
  return pathHadBase ? `${url.origin}${HUB_BASE_PATH}/` : `${url.origin}/`;
}

function mappedAssetPath(path: string): string | null {
  const match = path.match(/\/assets\/([^/]+)$/);
  return match ? `/assets/${match[1]}` : null;
}

async function serveAsset(request: Request, env: Env, path: string, pathHadBase: boolean): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const remapped = mappedAssetPath(path);
  const assetUrl = new URL(request.url);
  if (remapped) {
    assetUrl.pathname = remapped;
    const res = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method, headers: request.headers }));
    const headers = new Headers(res.headers);
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "no-referrer");
    return new Response(res.body, { status: res.status, headers });
  }
  assetUrl.pathname = path === "/" || path === "" ? "/index.html" : path;
  let res = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method, headers: request.headers }));
  if (res.status === 404) {
    const dest = appRoot(request, pathHadBase);
    return Response.redirect(dest, 302);
  }
  const headers = new Headers(res.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  if ((headers.get("content-type") ?? "").startsWith("text/html")) headers.set("content-security-policy", PAGE_CSP);
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    let path = url.pathname;
    let pathHadBase = false;

    if (path === HUB_BASE_PATH) {
      url.pathname = `${HUB_BASE_PATH}/`;
      return Response.redirect(url.toString(), 308);
    }
    if (path.startsWith(`${HUB_BASE_PATH}/`)) {
      pathHadBase = true;
      path = path.slice(HUB_BASE_PATH.length) || "/";
    }

    if (path.startsWith("/api/")) {
      try {
        return await handleApi(request, env, path);
      } catch (err) {
        return errorResponse(err);
      }
    }

    return serveAsset(request, env, path, pathHadBase);
  },

  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const result = await ingestInbound(env, message.body as InboundMail);
        console.log(JSON.stringify({ event: "inbound_consumed", ...result }));
        message.ack();
      } catch (err) {
        if (err instanceof PermanentInboundError) {
          console.warn(JSON.stringify({ event: "inbound_invalid", error: String(err) }));
          message.ack();
          continue;
        }
        console.error(JSON.stringify({ event: "inbound_failed", error: String(err) }));
        message.retry();
      }
    }
  },

  async scheduled(_controller, env): Promise<void> {
    const result = await sweep(env);
    console.log(JSON.stringify({ event: "sweep", ...result }));
  },
} satisfies ExportedHandler<Env>;
