import { handleApi, HttpError } from "./api";
import { cleanupExpired, findActiveInbox } from "./db";
import { ingest, Refusal } from "./ingest";
import { MAX_RAW_BYTES } from "./limits";

/** The hub path and the hub-style subdomain both send the visitor to the mail domain, where the addresses live. */
const REDIRECT_HOSTS = new Set(["tech-demos.theserverless.dev", "temp-email.tech-demos.theserverless.dev"]);
const HUB_PREFIX = "/demos/temp-email";

const PAGE_CSP = [
  "default-src 'self'",
  // The zone injects the Cloudflare Web Analytics beacon.
  "script-src 'self' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  // Mail HTML renders in a srcdoc frame. The frame inherits this policy, and its own policy is stricter.
  "img-src 'self' data: https: http:",
  "connect-src 'self' https://cloudflareinsights.com",
  "frame-src 'self'",
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

    if (REDIRECT_HOSTS.has(url.hostname)) {
      const rest = url.pathname.startsWith(HUB_PREFIX) ? url.pathname.slice(HUB_PREFIX.length) || "/" : url.pathname;
      return Response.redirect(`${env.PUBLIC_ORIGIN}${rest}${url.search}`, 302);
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url.pathname);
      } catch (err) {
        return errorResponse(err);
      }
    }
    return serveAsset(request, env, url.pathname);
  },

  async email(message, env): Promise<void> {
    const to = message.to.toLowerCase();
    const at = to.lastIndexOf("@");
    const domain = to.slice(at + 1);
    const localPart = to.slice(0, at).split("+")[0];
    const log = (outcome: string, extra: Record<string, unknown> = {}) =>
      console.log(JSON.stringify({ event: "email", outcome, size: message.rawSize, ...extra }));

    if (domain !== env.MAIL_DOMAIN) {
      log("rejected_domain", { domain });
      message.setReject(`This server accepts mail for @${env.MAIL_DOMAIN} only.`);
      return;
    }
    if (message.rawSize > MAX_RAW_BYTES) {
      log("rejected_size");
      message.setReject("The message is larger than 1 MB.");
      return;
    }
    const inbox = await findActiveInbox(env.DB, localPart);
    if (!inbox) {
      log("rejected_unknown");
      message.setReject("No active inbox has this address. It may have expired.");
      return;
    }
    try {
      const stored = await ingest(env.DB, inbox, { raw: message.raw, rawSize: message.rawSize, envelopeFrom: message.from, via: "smtp" });
      log("stored", { codes: stored.codes.length, attachments: stored.attachments.length });
    } catch (err) {
      if (err instanceof Refusal) {
        log(`rejected_${err.code}`);
        message.setReject(err.message);
        return;
      }
      // Throwing makes Email Routing return a temporary failure, so the sender retries later.
      log("failed", { error: String(err) });
      throw err;
    }
  },

  async scheduled(_controller, env): Promise<void> {
    const removed = await cleanupExpired(env.DB);
    console.log(JSON.stringify({ event: "cleanup", ...removed }));
  },
} satisfies ExportedHandler<Env>;
