import { adaptR2 } from "./bucket";
import { hexToBytes, importAesKey, importHmacKey } from "./crypto";
import { DriveObject } from "./drive";
import { D1Repo } from "./repo";
import { envMintEnabled, handleRequest, hubRedirectTarget, wipeExpired, type Deps } from "./router";
import type { LimitName } from "../shared/constants";
import { verifyTurnstile } from "./turnstile";

export { DriveObject };

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https://challenges.cloudflare.com https://cloudflareinsights.com",
  "frame-src blob: https://challenges.cloudflare.com",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

type Keys = { aes: CryptoKey; hmac: CryptoKey };

let keyCache: Promise<Keys | null> | null = null;

function keysFor(env: Env): Promise<Keys | null> {
  keyCache ??= loadKeys(env);
  return keyCache;
}

async function loadKeys(env: Env): Promise<Keys | null> {
  const aesRaw = hexToBytes(env.AUDIT_KEY ?? "");
  const hmacRaw = hexToBytes(env.AUDIT_HMAC_KEY ?? "");
  if (!aesRaw || aesRaw.byteLength !== 32 || !hmacRaw || hmacRaw.byteLength !== 32) return null;
  return { aes: await importAesKey(aesRaw), hmac: await importHmacKey(hmacRaw) };
}

function stripInternal(headers: Headers): Headers {
  const next = new Headers(headers);
  for (const name of [...next.keys()]) {
    if (name.toLowerCase().startsWith("x-r2drive-")) next.delete(name);
  }
  return next;
}

function authed(request: Request): Request {
  const headers = stripInternal(request.headers);
  headers.set("x-r2drive-authed", "1");
  return new Request(request, { headers });
}

async function buildDeps(env: Env): Promise<Deps> {
  const keys = await keysFor(env);
  const emailSink: string = env.EMAIL_SINK;
  const turnstileLocal: string = env.TURNSTILE_LOCAL;
  const sink = emailSink === "1" && turnstileLocal === "1";
  return {
    repo: new D1Repo(env.DB),
    bucket: adaptR2(env.BUCKET),
    locksFor: (driveId) => driveLocks(env, driveId),
    limit: (name, key) => limit(env, name, key),
    verifyTurnstile: (token, request) => verifyTurnstile(token, request, env),
    sendEmail: async (message) => {
      if (sink) return;
      await env.EMAIL.send({ to: message.to, from: env.MAIL_FROM, subject: message.subject, text: message.text });
    },
    now: () => Date.now(),
    mintEnabledEnv: envMintEnabled(env.MINT_ENABLED),
    adminToken: env.ADMIN_TOKEN ?? "",
    auditKey: keys?.aes ?? null,
    auditHmac: keys?.hmac ?? null,
    mailFrom: env.MAIL_FROM ?? "",
    publicOrigin: env.PUBLIC_ORIGIN ?? "",
    devOutbox: sink,
    siteKey: env.TURNSTILE_SITE_KEY ?? "",
    configured: Boolean(keys && env.TURNSTILE_SECRET && env.MAIL_FROM && env.PUBLIC_ORIGIN),
    recent: (driveId) => env.DRIVE.getByName(driveId).recentEvents(),
    forwardDav: async (request, drive) => env.DRIVE.getByName(drive.id).fetch(authed(request)),
    openSocket: async (request, driveId) => env.DRIVE.getByName(driveId).fetch(authed(request)),
    scheduleWipe: (driveId, expiresAt) => env.DRIVE.getByName(driveId).schedule(expiresAt),
    deferAlarm: (driveId, until) => env.DRIVE.getByName(driveId).deferAlarm(until),
    assets: (request, path) => serveAsset(env, request, path),
  };
}

function driveLocks(env: Env, driveId: string) {
  const stub = env.DRIVE.getByName(driveId);
  return {
    list: (now: number) => stub.listLocks().then((locks) => locks.filter((lock) => lock.expiresAt > now)),
    wipe: (now: number) => stub.wipe(now),
  };
}

async function limit(env: Env, name: LimitName, key: string): Promise<boolean> {
  const binding = env[name];
  const result = await binding.limit({ key });
  return result.success;
}

async function serveAsset(env: Env, request: Request, path: string): Promise<Response> {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = path;
  const response = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method }));
  const headers = new Headers(response.headers);
  if ((headers.get("content-type") ?? "").includes("text/html")) headers.set("content-security-policy", PAGE_CSP);
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const redirect = hubRedirectTarget(url);
    if (redirect) return Response.redirect(redirect, 308);
    const incoming = new Request(request, { headers: stripInternal(request.headers) });
    try {
      return await handleRequest(incoming, await buildDeps(env));
    } catch (error) {
      console.error(JSON.stringify({ event: "request_failed", error: String(error) }));
      return new Response(JSON.stringify({ error: { code: "internal", message: "The server failed. Try again." } }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" },
      });
    }
  },
  async scheduled(_controller, env): Promise<void> {
    const removed = await wipeExpired(await buildDeps(env));
    console.log(JSON.stringify({ event: "wipe", removed }));
  },
} satisfies ExportedHandler<Env>;
