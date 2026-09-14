import { handleApi, HttpError } from "./api";
import { ingestInbound } from "./inbound";
import type { InboundMail } from "../shared/types";

/** The hub serves this demo under a path. The subdomain serves it at the root. */
const BASE_PATH = "/demos/resolve-hq";

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

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    let path = url.pathname;

    if (path === BASE_PATH) {
      url.pathname = `${BASE_PATH}/`;
      return Response.redirect(url.toString(), 308);
    }
    if (path.startsWith(`${BASE_PATH}/`)) path = path.slice(BASE_PATH.length);

    if (path.startsWith("/api/")) {
      try {
        return await handleApi(request, env, path);
      } catch (err) {
        return errorResponse(err);
      }
    }

    return serveAsset(request, env, path);
  },

  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const result = await ingestInbound(env, message.body as InboundMail);
        console.log(JSON.stringify({ event: "inbound_consumed", ...result }));
        message.ack();
      } catch (err) {
        console.error(JSON.stringify({ event: "inbound_failed", error: String(err) }));
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;
