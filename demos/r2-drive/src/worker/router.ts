import { AUP_TEXT, AUP_VERSION, DAILY_MINT_CAP, DRIVE_TTL_MS, MAX_DRIVE_BYTES, MAX_FILE_BYTES, MAX_FILES, RATE_LIMIT_IDS, VERIFY_TTL_MS, type LimitName } from "../shared/constants";
import { isDisposableEmail, normalizeEmail } from "../shared/email-address";
import { LITMUS_RESULTS } from "../shared/litmus-results";
import { basePrefix, splitDavPath, type DavTarget } from "../shared/paths";
import type { Caps, LogEvent, PublicLock, SessionView } from "../shared/types";
import { hashSession, newPasswordRecord, parseBasic, passwordMatches, readCookie, sessionCookie } from "./auth";
import { deletePrefix, type DavBucket } from "./bucket";
import { bytesToB64Url, bytesToHex, decryptString, encryptString, hexToBytes, hmacHex, randomBytes, sha256Hex, timingSafeEqual, tokensMatch } from "./crypto";
import { clientIp, clientNetwork, rateLimitIp } from "./ip";
import { handleWebdav } from "./webdav";
import type { LockRecord, LockStore } from "./locks";
import { GuardedBucket } from "./quota";
import { PrefixBucket } from "./bucket";
import type { DriveRepo, DriveRow } from "./repo";

const encoder = new TextEncoder();
const WRITE_METHODS = new Set(["PUT", "DELETE", "MKCOL", "MOVE", "COPY", "LOCK", "UNLOCK", "PROPPATCH"]);

export type Deps = {
  repo: DriveRepo;
  bucket: DavBucket;
  locksFor: (driveId: string) => LockStore;
  limit: (name: LimitName, key: string) => Promise<boolean>;
  verifyTurnstile: (token: string, request: Request) => Promise<boolean>;
  sendEmail: (message: { to: string; subject: string; text: string }) => Promise<void>;
  now: () => number;
  mintEnabledEnv: boolean;
  adminToken: string;
  auditKey: CryptoKey;
  auditHmac: CryptoKey;
  mailFrom: string;
  publicOrigin: string;
  devOutbox: boolean;
  siteKey: string;
  configured: boolean;
  recent: (driveId: string) => LogEvent[] | Promise<LogEvent[]>;
  note: (driveId: string, event: LogEvent) => void;
  forwardDav?: (request: Request, drive: DriveRow, target: DavTarget) => Promise<Response>;
  openSocket?: (request: Request, driveId: string) => Promise<Response>;
  scheduleWipe?: (driveId: string, expiresAt: number) => Promise<void>;
  assets?: (request: Request, path: string) => Promise<Response>;
};

/** Anything other than the string "true" leaves minting off. */
export function envMintEnabled(value: string | undefined): boolean {
  return value === "true";
}

export function resolveMintEnabled(envFlag: boolean, killed: boolean): boolean {
  return envFlag && !killed;
}

export function limitName(method: string, path: string): LimitName {
  const bare = path.replace(/\/+$/, "") || "/";
  if (bare === "/dav" || bare.startsWith("/dav/")) return WRITE_METHODS.has(method) ? "DAV_WRITE" : "DAV_READ";
  if (bare === "/api/mint") return "MINT_IP";
  if (bare === "/api/verify") return "VERIFY";
  if (bare === "/api/report") return "REPORT";
  if (bare.startsWith("/api/admin")) return "ADMIN";
  if (bare === "/api/live") return "WS";
  if (bare === "/api/session" || bare === "/api/locks" || bare === "/api/log") return "READ";
  return "PAGE";
}

export function caps(): Caps {
  return { maxFileBytes: MAX_FILE_BYTES, maxDriveBytes: MAX_DRIVE_BYTES, maxFiles: MAX_FILES, ttlMs: DRIVE_TTL_MS };
}

export async function handleRequest(request: Request, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const path = routePath(url.pathname);
  const name = limitName(request.method, path);
  const allowed = await deps.limit(name, name === "MINT_IP" ? clientNetwork(clientIp(request)) : rateLimitIp(clientIp(request)));
  if (!allowed) return seal(error(429, "rate_limited", "Too many requests. Wait a minute."));

  const dav = splitDavPath(url.pathname);
  if (dav === "bad") return seal(error(400, "bad_path", "That path is not valid."));
  if (dav) return seal(await handleDav(request, deps, dav));

  if (path === "/api/live") return await handleLive(request, deps, url);
  if (path === "/api/health" && request.method === "GET") {
    return seal(json({ ok: true, mintEnabled: resolveMintEnabled(deps.mintEnabledEnv, await deps.repo.mintKilled()) }));
  }
  if (path === "/api/config" && request.method === "GET") {
    return seal(
      json({
        siteKey: deps.siteKey,
        mintEnabled: resolveMintEnabled(deps.mintEnabledEnv, await deps.repo.mintKilled()),
        aup: AUP_TEXT,
        aupVersion: AUP_VERSION,
        caps: caps(),
        rateLimits: RATE_LIMIT_IDS,
      }),
    );
  }
  if (path === "/api/litmus" && request.method === "GET") return seal(json(LITMUS_RESULTS));
  if (path === "/api/mint" && request.method === "POST") return seal(await mint(request, deps));
  if (path === "/api/verify" && request.method === "POST") return seal(await verify(request, deps, url));
  if (path === "/api/session" && request.method === "GET") return seal(await session(request, deps));
  if (path === "/api/locks" && request.method === "GET") return seal(await locks(request, deps));
  if (path === "/api/log" && request.method === "GET") return seal(await log(request, deps));
  if (path === "/api/report" && request.method === "POST") return seal(await report(request, deps));
  if (path === "/api/dev/outbox" && request.method === "GET") return seal(await outbox(request, deps, url));
  if (path.startsWith("/api/admin/")) return seal(await admin(request, deps, path));
  if (path.startsWith("/api/")) return seal(error(404, "not_found", "Not found."));
  if (request.method !== "GET" && request.method !== "HEAD") return seal(error(405, "method", "Method not allowed."));
  if (!deps.assets) return seal(error(404, "not_found", "Not found."));
  const assetPath = path === "/" ? "/index.html" : path;
  if (assetPath !== "/index.html" && assetPath !== "/favicon.svg" && !assetPath.startsWith("/assets/")) {
    return seal(error(404, "not_found", "Not found."));
  }
  return seal(await deps.assets(request, assetPath));
}

export async function wipeDrive(deps: Deps, drive: DriveRow, now: number): Promise<void> {
  await deletePrefix(deps.bucket, `drives/${drive.id}/`);
  await deps.locksFor(drive.id).clear();
  await deps.repo.markWiped(drive.id, now);
}

export async function wipeExpired(deps: Deps): Promise<number> {
  const now = deps.now();
  const rows = await deps.repo.listExpired(now);
  for (const row of rows) await wipeDrive(deps, row, now);
  await deps.repo.purge(now - 30 * 24 * 60 * 60 * 1000);
  return rows.length;
}

async function handleDav(request: Request, deps: Deps, target: DavTarget): Promise<Response> {
  const basic = parseBasic(request.headers.get("authorization"));
  const cookie = readCookie(request.headers.get("cookie"), "r2drive_session");
  if (!basic && !cookie) return unauthorized();
  const drive = await deps.repo.getDrive(target.driveId);
  if (basic) {
    if (basic.username !== target.driveId) {
      await passwordMatches(basic.password, null, null);
      return unauthorized();
    }
    const matches = await passwordMatches(basic.password, drive?.passwordSalt ?? null, drive?.passwordHash ?? null);
    if (!drive || !matches || drive.status === "wiped") return unauthorized();
  } else {
    const presented = await hashSession(cookie ?? "");
    const left = hexToBytes(presented);
    const right = drive?.sessionHash ? hexToBytes(drive.sessionHash) : new Uint8Array(32);
    if (!drive || !left || !right || !timingSafeEqual(left, right) || drive.status === "wiped") return unauthorized();
    if (WRITE_METHODS.has(request.method) && !allowedPageOrigin(request, deps)) {
      return error(403, "origin", "That origin cannot change this drive.");
    }
  }
  if (!drive) return unauthorized();
  if (drive.status === "frozen" || (await deps.repo.blocked("email", drive.emailHmac)) || (await deps.repo.blocked("network", drive.networkHmac))) {
    return error(403, "frozen", "This drive is frozen.");
  }
  const now = deps.now();
  if (drive.expiresAt <= now || drive.status !== "active") {
    await wipeDrive(deps, drive, now);
    return unauthorized();
  }
  if (deps.forwardDav) return deps.forwardDav(request, drive, target);
  const quota = { bytes: drive.bytesUsed, files: drive.fileCount };
  const guarded = new GuardedBucket(new PrefixBucket(deps.bucket, `drives/${drive.id}/`), quota, async (info) => {
    await deps.repo.addObject({
      driveId: drive.id,
      key: `drives/${drive.id}/${info.key}`,
      sha256: info.sha256,
      size: info.size,
      firstSeen: deps.now(),
    });
  });
  const response = await handleWebdav(request, {
    bucket: guarded,
    locks: deps.locksFor(drive.id),
    now,
    mountPath: target.mountPath,
    key: target.key,
  });
  await deps.repo.updateUsage(drive.id, quota.bytes, quota.files);
  drive.bytesUsed = quota.bytes;
  drive.fileCount = quota.files;
  deps.note(drive.id, { at: now, method: request.method, path: target.key || "/", status: response.status });
  return response;
}

async function mint(request: Request, deps: Deps): Promise<Response> {
  if (!deps.configured || !deps.mailFrom) return error(503, "not_configured", "This demo is not configured.");
  const body = await readJson(request);
  if (body instanceof Response) return body;
  if (body.aup !== true) return error(400, "aup_required", "Accept the use rules to mint a drive.");
  const email = normalizeEmail(typeof body.email === "string" ? body.email : "");
  if (!email) return error(400, "bad_email", "Enter a normal email address.");
  if (isDisposableEmail(email)) {
    return error(400, "disposable_email", "That email domain is on a disposable-domain list. The list is a soft signal and can be wrong. Use a regular mailbox.");
  }
  if (!(await deps.verifyTurnstile(typeof body.turnstileToken === "string" ? body.turnstileToken : "", request))) {
    return error(403, "turnstile_failed", "The human check failed. Try again.");
  }
  if (!resolveMintEnabled(deps.mintEnabledEnv, await deps.repo.mintKilled())) return error(403, "mint_disabled", "Minting is turned off.");
  const ip = clientIp(request);
  const emailHmac = await hmacHex(deps.auditHmac, email);
  const networkHmac = await hmacHex(deps.auditHmac, clientNetwork(ip));
  const ipHmac = await hmacHex(deps.auditHmac, rateLimitIp(ip));
  if ((await deps.repo.blocked("email", emailHmac)) || (await deps.repo.blocked("network", networkHmac))) {
    return error(403, "blocked", "This email or network is blocked.");
  }
  if (!(await deps.limit("MINT_EMAIL", emailHmac)) || !(await deps.limit("MINT_GLOBAL", "global"))) {
    return error(429, "rate_limited", "Too many requests. Wait a minute.");
  }
  const day = new Date(deps.now()).toISOString().slice(0, 10);
  if (!(await deps.repo.tryIncrementDaily(day, DAILY_MINT_CAP))) return error(429, "daily_cap", "The demo has reached its mint cap for today.");
  const expired = await deps.repo.findExpiredByEmail(emailHmac, deps.now());
  if (expired) await wipeDrive(deps, expired, deps.now());
  if (await deps.repo.findLiveByEmail(emailHmac, deps.now())) {
    return error(409, "drive_exists", "This email already has a drive. Wait until it expires.");
  }
  const token = bytesToB64Url(randomBytes(32));
  const tokenHash = await sha256Hex(encoder.encode(token));
  const now = deps.now();
  await deps.repo.insertVerification({
    tokenHash,
    emailHmac,
    emailEnc: await encryptString(deps.auditKey, email),
    ipHmac,
    networkHmac,
    createdAt: now,
    expiresAt: now + VERIFY_TTL_MS,
    usedAt: null,
    aupVersion: AUP_VERSION,
    devToken: deps.devOutbox ? token : null,
  });
  const link = `${deps.publicOrigin.replace(/\/$/, "")}/?verify=${encodeURIComponent(token)}`;
  try {
    await deps.sendEmail({
      to: email,
      subject: "Your R2 Drive link",
      text: `Confirm your one-hour WebDAV drive.\n\n${link}\n\nThe link works once and expires in 15 minutes. If you did not ask for this, ignore it.`,
    });
  } catch {
    await deps.repo.deleteVerification(tokenHash);
    return error(502, "email_failed", "The confirmation email could not be sent.");
  }
  return json({ ok: true, expiresInMinutes: 15 });
}

async function verify(request: Request, deps: Deps, url: URL): Promise<Response> {
  if (!deps.configured) return error(503, "not_configured", "This demo is not configured.");
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const token = typeof body.token === "string" ? body.token : "";
  if (!token || token.length > 200) return error(400, "bad_token", "That link is invalid or expired.");
  const row = await deps.repo.takeVerification(await sha256Hex(encoder.encode(token)), deps.now());
  if (!row) return error(400, "bad_token", "That link is invalid or expired.");
  if (!resolveMintEnabled(deps.mintEnabledEnv, await deps.repo.mintKilled())) return error(403, "mint_disabled", "Minting is turned off.");
  if ((await deps.repo.blocked("email", row.emailHmac)) || (await deps.repo.blocked("network", row.networkHmac))) {
    return error(403, "blocked", "This email or network is blocked.");
  }
  const expired = await deps.repo.findExpiredByEmail(row.emailHmac, deps.now());
  if (expired) await wipeDrive(deps, expired, deps.now());
  if (await deps.repo.findLiveByEmail(row.emailHmac, deps.now())) {
    return error(409, "drive_exists", "This email already has a drive. Wait until it expires.");
  }
  const now = deps.now();
  const password = bytesToB64Url(randomBytes(18));
  const passwordRecord = await newPasswordRecord(password);
  const session = bytesToB64Url(randomBytes(32));
  const driveId = `drv_${bytesToHex(randomBytes(16))}`;
  const expiresAt = now + DRIVE_TTL_MS;
  try {
    await deps.repo.insertDrive({
      id: driveId,
      emailHmac: row.emailHmac,
      emailEnc: row.emailEnc,
      ipHmac: row.ipHmac,
      networkHmac: row.networkHmac,
      createdAt: now,
      expiresAt,
      wipedAt: null,
      frozenAt: null,
      status: "active",
      passwordHash: passwordRecord.hash,
      passwordSalt: passwordRecord.salt,
      sessionHash: await hashSession(session),
      bytesUsed: 0,
      fileCount: 0,
      aupVersion: row.aupVersion,
    });
  } catch (error) {
    if (await deps.repo.findLiveByEmail(row.emailHmac, now)) {
      return error(409, "drive_exists", "This email already has a drive. Wait until it expires.");
    }
    throw error;
  }
  await deps.scheduleWipe?.(driveId, expiresAt);
  const base = basePrefix(url.pathname);
  const headers = new Headers({ "set-cookie": sessionCookie(session, cookieSecure(deps, url), Math.ceil(DRIVE_TTL_MS / 1000)) });
  return json(
    { driveId, username: driveId, password, expiresAt, mountPath: `${base}/dav/${driveId}/`, caps: caps() },
    200,
    headers,
  );
}

async function session(request: Request, deps: Deps): Promise<Response> {
  const drive = await sessionDrive(request, deps);
  if (drive instanceof Response) return drive;
  return json(sessionView(drive));
}

async function locks(request: Request, deps: Deps): Promise<Response> {
  const drive = await sessionDrive(request, deps);
  if (drive instanceof Response) return drive;
  const rows = await deps.locksFor(drive.id).list(deps.now());
  return json({ locks: rows.map(publicLock) });
}

async function log(request: Request, deps: Deps): Promise<Response> {
  const drive = await sessionDrive(request, deps);
  if (drive instanceof Response) return drive;
  return json({ events: await deps.recent(drive.id) });
}

async function handleLive(request: Request, deps: Deps, url: URL): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return seal(error(426, "upgrade", "Expected a WebSocket."));
  const drive = await sessionDrive(request, deps);
  if (drive instanceof Response) return seal(drive);
  if (!allowedPageOrigin(request, deps)) return seal(error(403, "origin", "That origin cannot watch this drive."));
  if (!deps.openSocket) return seal(error(501, "no_socket", "The live log is not available in this process."));
  return deps.openSocket(request, drive.id);
}

async function report(request: Request, deps: Deps): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  if (!(await deps.verifyTurnstile(typeof body.turnstileToken === "string" ? body.turnstileToken : "", request))) {
    return error(403, "turnstile_failed", "The human check failed. Try again.");
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 10 || reason.length > 2000) return error(400, "bad_reason", "Describe the problem in 10 to 2000 characters.");
  const driveId = typeof body.driveId === "string" ? body.driveId : "";
  const drive = /^drv_[a-f0-9]{32}$/.test(driveId) ? await deps.repo.getDrive(driveId) : null;
  let frozen = false;
  if (drive && drive.status !== "wiped") {
    frozen = await deps.repo.freeze(drive.id, deps.now());
    await deps.repo.block("email", drive.emailHmac, "report", deps.now());
    await deps.repo.block("network", drive.networkHmac, "report", deps.now());
  }
  let contactEnc: string | null = null;
  if (typeof body.contact === "string" && body.contact.trim()) {
    const contact = normalizeEmail(body.contact);
    if (contact) contactEnc = await encryptString(deps.auditKey, contact);
  }
  await deps.repo.addReport({
    driveId: drive?.id ?? null,
    reason,
    contactEnc,
    ipHmac: await hmacHex(deps.auditHmac, rateLimitIp(clientIp(request))),
    createdAt: deps.now(),
  });
  return json({ ok: true, frozen }, 202);
}

async function outbox(request: Request, deps: Deps, url: URL): Promise<Response> {
  if (!devOutboxOpen(request, deps, url)) return error(404, "not_found", "Not found.");
  return json({ token: await deps.repo.latestDevToken() });
}

function devOutboxOpen(request: Request, deps: Deps, url: URL): boolean {
  if (!deps.devOutbox) return false;
  const host = (request.headers.get("host") ?? "").replace(/:\d+$/, "");
  return loopback(url.hostname) || loopback(host);
}

async function admin(request: Request, deps: Deps, path: string): Promise<Response> {
  if (request.method !== "POST") return error(405, "method", "Method not allowed.");
  if (!deps.adminToken) return error(503, "not_configured", "The admin token is not configured.");
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!(await tokensMatch(token, deps.adminToken))) return error(401, "unauthorized", "Unauthorized.");
  const body = await readJson(request);
  if (body instanceof Response) return body;
  if (path === "/api/admin/mint") {
    if (body.enabled === true && !deps.mintEnabledEnv) return error(409, "mint_disabled", "Minting is off in the Worker config.");
    await deps.repo.setMintKilled(body.enabled !== true);
    return json({ mintEnabled: resolveMintEnabled(deps.mintEnabledEnv, await deps.repo.mintKilled()) });
  }
  if (path === "/api/admin/freeze") {
    const driveId = typeof body.driveId === "string" ? body.driveId : "";
    const ok = await deps.repo.freeze(driveId, deps.now());
    return json({ ok });
  }
  if (path === "/api/admin/block" || path === "/api/admin/unblock") {
    const email = typeof body.email === "string" ? normalizeEmail(body.email) : null;
    const ip = typeof body.ip === "string" ? body.ip : "";
    if (!email && !ip) return error(400, "bad_block", "Provide an email or an IP address.");
    if (email) {
      const hmac = await hmacHex(deps.auditHmac, email);
      if (path.endsWith("/block")) await deps.repo.block("email", hmac, "admin", deps.now());
      else await deps.repo.unblock("email", hmac);
    }
    if (ip) {
      const hmac = await hmacHex(deps.auditHmac, clientNetwork(ip));
      if (path.endsWith("/block")) await deps.repo.block("network", hmac, "admin", deps.now());
      else await deps.repo.unblock("network", hmac);
    }
    return json({ ok: true });
  }
  if (path === "/api/admin/audit") {
    const driveId = typeof body.driveId === "string" ? body.driveId : "";
    const drive = await deps.repo.getDrive(driveId);
    if (!drive) return error(404, "not_found", "No drive with that id.");
    return json({
      driveId: drive.id,
      email: await decryptString(deps.auditKey, drive.emailEnc),
      createdAt: drive.createdAt,
      expiresAt: drive.expiresAt,
      status: drive.status,
      objects: await deps.repo.listObjects(drive.id),
    });
  }
  return error(404, "not_found", "Not found.");
}

async function sessionDrive(request: Request, deps: Deps): Promise<DriveRow | Response> {
  const cookie = readCookie(request.headers.get("cookie"), "r2drive_session");
  if (!cookie) return error(401, "unauthorized", "Unauthorized.");
  const presentedHex = await hashSession(cookie);
  const presented = hexToBytes(presentedHex);
  const drive = await deps.repo.findBySession(presentedHex);
  const stored = drive?.sessionHash ? hexToBytes(drive.sessionHash) : new Uint8Array(32);
  if (!drive || !presented || !stored || !timingSafeEqual(presented, stored)) return error(401, "unauthorized", "Unauthorized.");
  if (drive.expiresAt <= deps.now()) {
    await wipeDrive(deps, drive, deps.now());
    return error(401, "unauthorized", "Unauthorized.");
  }
  if (drive.status === "frozen") return error(403, "frozen", "This drive is frozen.");
  if (drive.status !== "active") return error(401, "unauthorized", "Unauthorized.");
  return drive;
}

function sessionView(drive: DriveRow): SessionView {
  return {
    driveId: drive.id,
    expiresAt: drive.expiresAt,
    bytesUsed: drive.bytesUsed,
    fileCount: drive.fileCount,
    status: drive.status,
    caps: caps(),
  };
}

function publicLock(lock: LockRecord): PublicLock {
  return {
    path: lock.path,
    owner: lock.owner ?? null,
    scope: lock.scope,
    depth: lock.depth,
    timeout: lock.timeout,
    expiresAt: lock.expiresAt,
  };
}

function routePath(pathname: string): string {
  const base = basePrefix(pathname);
  return base ? pathname.slice(base.length) || "/" : pathname;
}

function loopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function allowedPageOrigin(request: Request, deps: Deps): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  if (origin === new URL(request.url).origin) return true;
  try {
    return origin === new URL(deps.publicOrigin).origin;
  } catch {
    return false;
  }
}

function cookieSecure(deps: Deps, url: URL): boolean {
  try {
    return new URL(deps.publicOrigin).protocol === "https:";
  } catch {
    return url.protocol === "https:";
  }
}

function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="r2-drive"', DAV: "1, 2", Allow: "OPTIONS, PROPFIND, PROPPATCH, MKCOL, GET, HEAD, PUT, DELETE, COPY, MOVE, LOCK, UNLOCK" },
  });
}

export function seal(response: Response): Response {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  for (const name of ["access-control-allow-origin", "access-control-allow-credentials", "access-control-allow-methods", "access-control-allow-headers"]) {
    headers.delete(name);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(data: unknown, status = 200, extra?: Headers): Response {
  const headers = extra ?? new Headers();
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers });
}

function error(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > 32 * 1024) return error(413, "too_large", "The request body is too large.");
  const text = await request.text();
  if (text.length > 32 * 1024) return error(413, "too_large", "The request body is too large.");
  try {
    const parsed: unknown = JSON.parse(text || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return error(400, "bad_json", "Expected a JSON object.");
    return parsed as Record<string, unknown>;
  } catch {
    return error(400, "bad_json", "Expected a JSON object.");
  }
}
