import { isStatus, type BoardConfig, type ChangelogEntry, type Post } from "../shared/types";
import { adminToken, bearerToken, secretEquals } from "./auth";
import { gateCookieValid, randomHex, readCookie, setCookie, signGate, visitorFrom } from "./cookies";
import {
  cleanupExpired,
  countChangelog,
  countVisiblePosts,
  evictIfFull,
  getImage,
  getPost,
  insertChangelog,
  insertPost,
  listChangelog,
  listPosts,
  setStatus,
  toggleVote,
} from "./db";
import { HttpError, cleanLine, displayName, enforceLimit, json, readJson, str } from "./http";
export { HttpError };
import { sniffImage } from "./images";
import {
  GATE_TTL_SECONDS,
  MAX_BODY,
  MAX_IMAGE_BYTES,
  MAX_TITLE,
  MIN_BODY,
  MIN_TITLE,
  VISITOR_TTL_MS,
  VISITOR_TTL_SECONDS,
} from "./limits";
import { findSimilar, indexPostLater, indexSeedsLater } from "./similar";
import { turnstileSecret, turnstileSiteKey, verifyTurnstile, writesOpen, devFixtureMode } from "./turnstile";

const POST_ID = /^post_[a-z0-9_]{4,40}$/;
const VISITOR_COOKIE_AGE = 60 * 60 * 24 * 400;

function requireId(id: string): string {
  if (!POST_ID.test(id)) throw new HttpError(404, "not_found", "That post is gone.");
  return id;
}

async function requireAdmin(env: Env, request: Request): Promise<void> {
  const expected = adminToken(env, request);
  if (!expected) throw new HttpError(503, "admin_unconfigured", "Admin actions are off until ADMIN_TOKEN is set.");
  const given = bearerToken(request);
  const matches = await secretEquals(given || "missing", expected);
  if (!given || !matches) throw new HttpError(401, "unauthorized", "Admin token rejected.");
}

async function requireGate(env: Env, request: Request, visitorId: string, token: string, now: number): Promise<boolean> {
  const secret = turnstileSecret(env, request);
  if (!secret) return false;
  if (await gateCookieValid(secret, readCookie(request, "fl_gate"), visitorId, now)) return true;
  return verifyTurnstile(env, request, token);
}

function contentLength(request: Request): number {
  const raw = request.headers.get("content-length");
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function postPath(pathname: string): { id: string; rest: string } | null {
  const match = pathname.match(/^\/api\/posts\/([^/]+)(?:\/(.*))?$/);
  if (!match?.[1]) return null;
  return { id: decodeURIComponent(match[1]), rest: match[2] ?? "" };
}

export async function handleApi(request: Request, env: Env, path: string, ctx: ExecutionContext, pageUrl: URL): Promise<Response> {
  const visitor = visitorFrom(request);
  const response = await route(request, env, path, ctx, pageUrl, visitor.id);
  indexSeedsLater(ctx, env);
  if (!visitor.fresh) return response;
  const headers = new Headers(response.headers);
  headers.append("set-cookie", setCookie(pageUrl, "fl_vid", visitor.id, VISITOR_COOKIE_AGE));
  return new Response(response.body, { status: response.status, headers });
}

async function route(
  request: Request,
  env: Env,
  path: string,
  ctx: ExecutionContext,
  pageUrl: URL,
  visitorId: string,
): Promise<Response> {
  const method = request.method;
  const now = Date.now();

  if (path === "/api/health" && method === "GET") {
    return json({
      ok: true,
      posts: await countVisiblePosts(env, now),
      changelog: await countChangelog(env),
      writesOpen: writesOpen(env, request),
      embedModel: env.EMBED_MODEL,
    });
  }

  if (path === "/api/config" && method === "GET") {
    const config: BoardConfig = {
      turnstileSiteKey: turnstileSiteKey(env, request),
      writesOpen: writesOpen(env, request),
      embedModel: env.EMBED_MODEL,
      visitorTtlDays: 14,
    };
    return json(config);
  }

  if (path === "/api/posts" && method === "GET") {
    const url = new URL(request.url);
    const statusRaw = url.searchParams.get("status") ?? "";
    const status = statusRaw && isStatus(statusRaw) ? statusRaw : null;
    if (statusRaw && !status) throw new HttpError(400, "invalid", "Unknown status.");
    const sort = url.searchParams.get("sort") === "new" ? "new" : "top";
    return json({ posts: await listPosts(env, visitorId, now, status, sort) });
  }

  if (path === "/api/posts" && method === "POST") {
    await enforceLimit(env.POST_LIMIT, request, "Too many new posts from this network. Wait a minute.");
    if (!writesOpen(env, request)) throw new HttpError(503, "writes_closed", "Posting is off until Turnstile is configured.");
    const created = await createPost(request, env, ctx, visitorId, now);
    return json({ post: created }, 201);
  }

  if (path === "/api/gate" && method === "POST") {
    await enforceLimit(env.POST_LIMIT, request, "Too many checks from this network. Wait a minute.");
    if (!writesOpen(env, request)) throw new HttpError(503, "writes_closed", "Posting is off until Turnstile is configured.");
    const body = await readJson(request);
    const ok = await verifyTurnstile(env, request, str(body.turnstileToken).trim());
    if (!ok) throw new HttpError(403, "turnstile_failed", "Complete the check, then try again.");
    const secret = turnstileSecret(env, request);
    if (!secret) throw new HttpError(503, "writes_closed", "Posting is off until Turnstile is configured.");
    const headers = new Headers();
    headers.append("set-cookie", setCookie(pageUrl, "fl_gate", await signGate(secret, visitorId, now), GATE_TTL_SECONDS));
    return json({ ok: true }, 200, headers);
  }

  if (path === "/api/similar" && method === "POST") {
    await enforceLimit(env.AI_LIMIT, request, "Too many similarity checks. Wait a minute.");
    if (!writesOpen(env, request)) throw new HttpError(503, "writes_closed", "Similarity checks are off until Turnstile is configured.");
    const body = await readJson(request);
    const allowed = await requireGate(env, request, visitorId, str(body.turnstileToken).trim(), now);
    if (!allowed) throw new HttpError(403, "turnstile_failed", "Complete the check before looking for duplicates.");
    const title = str(body.title).slice(0, MAX_TITLE);
    const text = str(body.body).slice(0, MAX_BODY);
    return json(await findSimilar(env, visitorId, `${title}\n${text}`, now));
  }

  if (path === "/api/changelog" && method === "GET") {
    return json({ entries: await listChangelog(env) });
  }

  if (path === "/api/changelog" && method === "POST") {
    await enforceLimit(env.ADMIN_LIMIT, request, "Too many admin writes. Wait a minute.");
    await requireAdmin(env, request);
    const body = await readJson(request);
    const entry: ChangelogEntry = {
      id: `log_${randomHex(8)}`,
      title: cleanLine(body.title, MIN_TITLE, MAX_TITLE, "Title"),
      body: cleanLine(body.body, MIN_BODY, MAX_BODY, "Body"),
      publishedAt: now,
      seeded: false,
    };
    await insertChangelog(env, entry);
    return json({ entry }, 201);
  }

  if (path === "/api/admin/cleanup" && method === "POST") {
    await enforceLimit(env.ADMIN_LIMIT, request, "Too many admin writes. Wait a minute.");
    await requireAdmin(env, request);
    return json(await cleanupExpired(env, now));
  }

  const match = postPath(path);
  if (!match) throw new HttpError(404, "not_found", "Unknown API route.");
  const id = requireId(match.id);

  if (match.rest === "" && method === "GET") {
    const post = await getPost(env, id, visitorId, now);
    if (!post) throw new HttpError(404, "not_found", "That post is gone.");
    return json({ post });
  }

  if (match.rest === "" && method === "PATCH") {
    await enforceLimit(env.ADMIN_LIMIT, request, "Too many admin writes. Wait a minute.");
    await requireAdmin(env, request);
    const body = await readJson(request);
    const status = str(body.status);
    if (!isStatus(status)) throw new HttpError(400, "invalid", "Unknown status.");
    const changed = await setStatus(env, id, status, now);
    if (!changed) throw new HttpError(404, "not_found", "That post is gone.");
    const post = await getPost(env, id, visitorId, now);
    if (!post) throw new HttpError(404, "not_found", "That post is gone.");
    return json({ post });
  }

  if (match.rest === "vote" && method === "POST") {
    await enforceLimit(env.VOTE_LIMIT, request, "Too many votes from this network. Wait a minute.");
    const result = await toggleVote(env, id, visitorId, now);
    if (!result) throw new HttpError(404, "not_found", "That post is gone.");
    return json(result);
  }

  if (match.rest === "image" && method === "GET") {
    const image = await getImage(env, id, now);
    if (!image) throw new HttpError(404, "not_found", "That post has no image.");
    const object = await env.IMAGES.get(image.key);
    if (!object) throw new HttpError(404, "not_found", "That image is gone.");
    const headers = new Headers();
    headers.set("content-type", image.type);
    headers.set("cache-control", "public, max-age=3600");
    headers.set("x-content-type-options", "nosniff");
    return new Response(object.body, { headers });
  }

  throw new HttpError(404, "not_found", "Unknown API route.");
}

async function createPost(request: Request, env: Env, ctx: ExecutionContext, visitorId: string, now: number): Promise<Post> {
  if (contentLength(request) > MAX_IMAGE_BYTES + 64_000) throw new HttpError(413, "too_large", "The upload is too large.");
  const type = request.headers.get("content-type") ?? "";
  let title = "";
  let body = "";
  let name = "Visitor";
  let token = "";
  let expiresAt = now + VISITOR_TTL_MS;
  let image: { bytes: ArrayBuffer; type: string } | null = null;

  if (type.includes("multipart/form-data")) {
    const form = await request.formData();
    title = str(form.get("title"));
    body = str(form.get("body"));
    name = displayName(form.get("displayName"));
    token = str(form.get("turnstileToken")).trim();
    expiresAt = expiresOverride(request, env, form.get("expiresInSeconds"), now) ?? expiresAt;
    const file = form.get("image");
    if (file instanceof File && file.size > 0) image = await readImage(file);
  } else {
    const payload = await readJson(request);
    title = str(payload.title);
    body = str(payload.body);
    name = displayName(payload.displayName);
    token = str(payload.turnstileToken).trim();
    expiresAt = expiresOverride(request, env, payload.expiresInSeconds, now) ?? expiresAt;
  }

  const cleanTitle = cleanLine(title, MIN_TITLE, MAX_TITLE, "Title");
  const cleanBody = cleanLine(body, MIN_BODY, MAX_BODY, "Body");
  const allowed = await requireGate(env, request, visitorId, token, now);
  if (!allowed) throw new HttpError(403, "turnstile_failed", "Complete the check before posting.");

  await evictIfFull(env, now);
  const id = `post_${randomHex(8)}`;
  const imageKey = image ? `posts/${id}` : null;
  if (image && imageKey) {
    await env.IMAGES.put(imageKey, image.bytes, { httpMetadata: { contentType: image.type } });
  }
  try {
    await insertPost(env, {
      id,
      title: cleanTitle,
      body: cleanBody,
      displayName: name,
      visitorId,
      now,
      expiresAt,
      imageKey,
      imageType: image?.type ?? null,
    });
  } catch (err) {
    if (imageKey) await env.IMAGES.delete(imageKey).catch(() => undefined);
    throw err;
  }

  if (expiresAt > now) indexPostLater(ctx, env, { id, title: cleanTitle, body: cleanBody });
  const post = await getPost(env, id, visitorId, now);
  if (post) return post;
  if (expiresAt <= now) {
    return {
      id,
      title: cleanTitle,
      body: cleanBody,
      status: "open",
      votes: 0,
      displayName: name,
      hasImage: Boolean(image),
      seeded: false,
      createdAt: now,
      expiresAt,
      voted: false,
    };
  }
  throw new HttpError(500, "internal", "The post was saved but could not be read back.");
}

function expiresOverride(request: Request, env: Env, value: unknown, now: number): number | null {
  // Smoke uses this in local dev to prove cron deletion without waiting out the 14-day TTL.
  if (!devFixtureMode(env, request) || value === undefined || value === null || value === "") return null;
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(seconds)) throw new HttpError(400, "invalid", "expiresInSeconds must be a number.");
  const whole = Math.trunc(seconds);
  if (whole < -86_400 || whole > VISITOR_TTL_SECONDS) throw new HttpError(400, "invalid", "expiresInSeconds is out of range.");
  return now + whole * 1000;
}

async function readImage(file: File): Promise<{ bytes: ArrayBuffer; type: string }> {
  if (file.size > MAX_IMAGE_BYTES) throw new HttpError(413, "too_large", "Images must be 1.5 MB or smaller.");
  const bytes = await file.arrayBuffer();
  const sniffed = sniffImage(new Uint8Array(bytes), file.type || "");
  if (!sniffed) throw new HttpError(415, "unsupported_type", "Attach a JPEG, PNG, GIF, or WebP image.");
  return { bytes, type: sniffed };
}
