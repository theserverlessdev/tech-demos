import type { AppConfig, CreatedInbox, KeyInfo, MessageList, MintedKey, WaitResult } from "../shared/types";
import { bearerToken, hostedMode, isAdminKey, newApiKey, newId, newToken, sha256Hex } from "./auth";
import {
  countMessages,
  deleteInbox,
  deleteMessage,
  findActiveInbox,
  getMessage,
  insertInbox,
  listFullAfter,
  listSummaries,
  setExpiry,
  toInboxInfo,
  type InboxRow,
} from "./db";
import { consumeCreateQuota, findKeyByHash, insertApiKey, revokeKey, toKeyInfo, touchKey, type ApiKeyRow } from "./keys";
import { downloadHeaders } from "./attachments";
import { ingest, Refusal, sampleMime } from "./ingest";
import { rateLimitIp, webCreateLimitKey } from "./ip";
import { nextExpiry } from "./ttl";
import {
  JSON_BODY_MAX,
  KEY_CREATE_LIMIT,
  KEY_INBOX_LIMIT,
  MAX_INBOX_BYTES,
  MAX_KEY_NAME,
  MAX_MESSAGES_PER_INBOX,
  MAX_RAW_BYTES,
  MAX_WAIT_SECONDS,
  MINUTE_MS,
  WAIT_POLL_MS,
  WEB_MAX_TTL_MINUTES,
} from "./limits";
import { mxStatus } from "./mx";
import { checkLocalPart, randomLocalPart } from "./names";
import { mintEnabled, verifyTurnstile } from "./turnstile";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Caller = {
  admin: boolean;
  agent: boolean;
  key: ApiKeyRow | null;
  token: string | null;
  ip: string;
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new HttpError(400, "bad_request", `"${name}" must be an integer.`);
  return Math.min(max, Math.max(min, n));
}

export async function readCapped(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && declared !== "") {
    const n = Number(declared);
    if (!Number.isFinite(n) || n < 0 || n > maxBytes) {
      throw new HttpError(413, "too_large", `Body must be ${maxBytes} bytes or smaller.`);
    }
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "too_large", `Body must be ${maxBytes} bytes or smaller.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const bytes = await readCapped(request, JSON_BODY_MAX);
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) return {};
  try {
    const body = JSON.parse(text);
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // Fall through to the error below.
  }
  throw new HttpError(400, "bad_request", "The body must be a JSON object.");
}

async function limit(binding: RateLimit, key: string): Promise<void> {
  const { success } = await binding.limit({ key });
  if (!success) throw new HttpError(429, "rate_limited", "Too many requests. Wait one minute, then try again.");
}

function mintConfig(env: Env): AppConfig["mint"] {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim() || null;
  return {
    enabled: mintEnabled(env),
    turnstileSiteKey: siteKey,
    inboxLimit: KEY_INBOX_LIMIT,
    createLimit: KEY_CREATE_LIMIT,
  };
}

async function resolveCaller(request: Request, env: Env): Promise<Caller> {
  const token = bearerToken(request);
  const ip = rateLimitIp(request.headers.get("cf-connecting-ip") ?? "local");
  if (!token) return { admin: false, agent: false, key: null, token: null, ip };
  if (await isAdminKey(token, env)) return { admin: true, agent: true, key: null, token: null, ip };
  const key = await findKeyByHash(env.DB, await sha256Hex(token));
  if (key) return { admin: false, agent: true, key, token: null, ip };
  return { admin: false, agent: false, key: null, token, ip };
}

/** Accepts "name" or "name@domain". Rejects any other domain. Drops a "+tag". */
function localPartOf(param: string, domain: string): string {
  let value: string;
  try {
    value = decodeURIComponent(param).trim().toLowerCase();
  } catch {
    throw new HttpError(400, "bad_request", "The address in the path is not valid.");
  }
  const at = value.lastIndexOf("@");
  if (at >= 0 && value.slice(at + 1) !== domain) throw new HttpError(404, "not_found", "No active inbox has this address.");
  return (at >= 0 ? value.slice(0, at) : value).split("+")[0];
}

/** Admin opens every inbox. A minted key opens inboxes it created. An inbox token opens only its own inbox. */
async function authorizedInbox(env: Env, caller: Caller, param: string): Promise<InboxRow> {
  const inbox = await findActiveInbox(env.DB, localPartOf(param, env.MAIL_DOMAIN));
  if (inbox && caller.admin) return inbox;
  if (inbox && caller.key && inbox.api_key_id === caller.key.id) return inbox;
  if (inbox && caller.token !== null && (await sha256Hex(caller.token)) === inbox.token_hash) return inbox;
  if (!caller.agent && !caller.token) {
    throw new HttpError(401, "unauthorized", "Send the inbox token or an API key as a bearer token.");
  }
  throw new HttpError(404, "not_found", "No active inbox has this address, or the token does not match it.");
}

async function inboxInfo(env: Env, inbox: InboxRow) {
  return toInboxInfo(inbox, env.MAIL_DOMAIN, await countMessages(env.DB, inbox.id));
}

function keyName(body: Record<string, unknown>): string {
  const raw = typeof body.name === "string" ? body.name.trim() : "";
  if (!raw) return "agent";
  if (raw.length > MAX_KEY_NAME) throw new HttpError(400, "bad_request", `Name must be ${MAX_KEY_NAME} characters or fewer.`);
  if (!/^[\w .:@+/-]+$/u.test(raw)) throw new HttpError(400, "bad_request", "Use letters, digits, spaces, and .:@+/- in the name.");
  return raw;
}

async function mintKey(request: Request, env: Env, caller: Caller): Promise<Response> {
  await limit(env.CREATE_LIMIT, `mint:${caller.ip}`);
  if (!mintEnabled(env)) {
    throw new HttpError(503, "mint_disabled", "Key mint is off. Set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY, or use the admin key.");
  }
  const body = await readJson(request);
  const name = keyName(body);
  const turnstileToken = typeof body.turnstileToken === "string" ? body.turnstileToken.trim() : "";
  if (!(await verifyTurnstile(env, turnstileToken, caller.ip))) {
    throw new HttpError(403, "turnstile_failed", "Turnstile did not pass. Retry the check, then mint again.");
  }
  const plaintext = newApiKey();
  const now = Date.now();
  const row = await insertApiKey(env.DB, {
    id: newId(),
    name,
    key_hash: await sha256Hex(plaintext),
    created_at: now,
  });
  const created: MintedKey = {
    id: row.id,
    name: row.name,
    key: plaintext,
    createdAt: row.created_at,
    inboxLimit: row.inbox_limit,
    createLimit: row.create_limit,
  };
  console.log(JSON.stringify({ event: "key_minted", keyId: row.id, hosted: hostedMode(env) }));
  return json(created, 201);
}

async function requireMintedKey(caller: Caller): Promise<ApiKeyRow> {
  if (caller.admin) throw new HttpError(400, "bad_request", "The admin key cannot be listed or revoked through this path.");
  if (!caller.key) throw new HttpError(401, "unauthorized", "Send a minted API key as a bearer token.");
  return caller.key;
}

async function createInbox(request: Request, env: Env, caller: Caller): Promise<Response> {
  if (caller.key) {
    await limit(env.CREATE_LIMIT, `create:key:${caller.key.id}`);
  } else if (!caller.admin) {
    await limit(env.CREATE_LIMIT, `create:${caller.ip}`);
    const webKey = webCreateLimitKey(hostedMode(env), caller.ip);
    if (webKey) await limit(env.WEB_CREATE_LIMIT, webKey);
  }

  const body = await readJson(request);
  const webTtl = Number(env.WEB_TTL_MINUTES);
  const maxTtl = Number(env.MAX_TTL_MINUTES);

  let ttlMinutes = webTtl;
  if (body.ttlMinutes !== undefined) {
    if (!caller.agent) throw new HttpError(403, "forbidden", "Only an API key can set ttlMinutes.");
    if (!Number.isInteger(body.ttlMinutes) || (body.ttlMinutes as number) < 1 || (body.ttlMinutes as number) > maxTtl) {
      throw new HttpError(400, "bad_request", `ttlMinutes must be an integer from 1 to ${maxTtl}.`);
    }
    ttlMinutes = body.ttlMinutes as number;
  }

  const custom = typeof body.localPart === "string" && body.localPart.trim() !== "" ? body.localPart.trim().toLowerCase() : null;
  if (custom !== null) {
    const problem = checkLocalPart(custom);
    if (problem) throw new HttpError(400, "invalid_local_part", problem);
  }

  const token = newToken();
  const tokenHash = await sha256Hex(token);
  for (let attempt = 0; attempt < 5; attempt++) {
    const now = Date.now();
    const inserted = await insertInbox(
      env.DB,
      env.ATTACHMENTS,
      {
        id: newId(),
        local_part: custom ?? randomLocalPart(),
        token_hash: tokenHash,
        source: caller.agent ? "agent" : "web",
        created_at: now,
        expires_at: now + ttlMinutes * MINUTE_MS,
        api_key_id: caller.key?.id ?? null,
      },
      caller.key ? { activeLimit: caller.key.inbox_limit } : undefined,
    );
    if ("error" in inserted) {
      if (inserted.error === "quota") {
        throw new HttpError(429, "quota", `This key already has ${caller.key?.inbox_limit} active inboxes. Delete or wait for expiry.`);
      }
      if (custom !== null) throw new HttpError(409, "taken", `${custom}@${env.MAIL_DOMAIN} is in use. Choose another name.`);
      continue;
    }
    const row = inserted.ok;
    if (caller.key) {
      if (!(await consumeCreateQuota(env.DB, caller.key))) {
        await deleteInbox(env.DB, env.ATTACHMENTS, row.id);
        throw new HttpError(429, "quota", `This key reached ${caller.key.create_limit} inbox creates in 24 hours.`);
      }
    }
    const created: CreatedInbox = { ...toInboxInfo(row, env.MAIL_DOMAIN, 0), token };
    console.log(JSON.stringify({ event: "inbox_created", source: row.source, custom: custom !== null, ttlMinutes, keyed: caller.key !== null }));
    return json(created, 201);
  }
  throw new HttpError(503, "name_collision", "No free random name was found. Try again.");
}

async function extendInbox(request: Request, env: Env, caller: Caller, inbox: InboxRow): Promise<Response> {
  const body = await readJson(request);
  const maxTtl = Number(env.MAX_TTL_MINUTES);
  const step = Number(env.WEB_TTL_MINUTES);
  let minutes = step;
  if (body.minutes !== undefined) {
    if (!Number.isInteger(body.minutes) || (body.minutes as number) < 1) {
      throw new HttpError(400, "bad_request", "minutes must be a positive integer.");
    }
    minutes = caller.agent ? (body.minutes as number) : Math.min(step, body.minutes as number);
  }
  const now = Date.now();
  const ceilingMinutes = caller.agent ? maxTtl : WEB_MAX_TTL_MINUTES;
  const expiresAt = nextExpiry({
    createdAt: inbox.created_at,
    expiresAt: inbox.expires_at,
    now,
    minutes,
    ceilingMinutes,
  });
  if (expiresAt === null) {
    throw new HttpError(
      400,
      "ttl_capped",
      caller.agent
        ? `This inbox cannot extend past ${maxTtl} minutes from creation.`
        : `Web inboxes last at most ${WEB_MAX_TTL_MINUTES} minutes from creation.`,
    );
  }
  await setExpiry(env.DB, inbox.id, expiresAt);
  return json(await inboxInfo(env, { ...inbox, expires_at: expiresAt }));
}

async function wait(request: Request, env: Env, url: URL, inbox: InboxRow): Promise<Response> {
  const after = intParam(url, "after", 0, 0, Number.MAX_SAFE_INTEGER);
  const timeout = intParam(url, "timeout", 20, 0, MAX_WAIT_SECONDS);
  const deadline = Date.now() + timeout * 1000;
  for (;;) {
    const messages = await listFullAfter(env.DB, env.ATTACHMENTS, inbox.id, after, 10);
    const done = messages.length > 0 || Date.now() + WAIT_POLL_MS > deadline || request.signal.aborted;
    if (done) {
      const result: WaitResult = {
        inbox: await inboxInfo(env, inbox),
        messages,
        cursor: messages.length ? messages[messages.length - 1].seq : after,
        timedOut: messages.length === 0,
      };
      return json(result);
    }
    await scheduler.wait(WAIT_POLL_MS);
  }
}

async function deliver(request: Request, env: Env, inbox: InboxRow, via: "sample" | "test"): Promise<Response> {
  let raw: string;
  let envelopeFrom: string;
  if (via === "sample") {
    raw = sampleMime(`${inbox.local_part}@${env.MAIL_DOMAIN}`, env.PUBLIC_ORIGIN, env.MAIL_DOMAIN);
    envelopeFrom = `sample@${env.MAIL_DOMAIN}`;
  } else {
    const bytes = await readCapped(request, MAX_RAW_BYTES);
    raw = new TextDecoder().decode(bytes);
    if (!raw.trim()) throw new HttpError(400, "bad_request", "Send the raw MIME message as the request body.");
    envelopeFrom = request.headers.get("x-envelope-from") ?? "test@localhost";
  }
  try {
    const message = await ingest(env.DB, env.ATTACHMENTS, inbox, {
      raw,
      rawSize: new TextEncoder().encode(raw).byteLength,
      envelopeFrom,
      via,
    });
    console.log(JSON.stringify({ event: "message_stored", via, size: message.rawSize }));
    return json(message, 201);
  } catch (err) {
    if (err instanceof Refusal) {
      const status = err.code === "too_large" ? 413 : 409;
      throw new HttpError(status, err.code, err.message);
    }
    throw err;
  }
}

async function streamAttachment(env: Env, inbox: InboxRow, messageId: string, indexRaw: string): Promise<Response> {
  const index = Number(indexRaw);
  if (!Number.isInteger(index) || index < 0) throw new HttpError(400, "bad_request", "Attachment index must be a non-negative integer.");
  const message = await getMessage(env.DB, env.ATTACHMENTS, inbox.id, messageId);
  if (!message) throw new HttpError(404, "not_found", "No message has this ID in the inbox.");
  const meta = message.attachments[index];
  if (!meta?.r2Key) throw new HttpError(404, "not_found", "No stored file for this attachment.");
  const object = await env.ATTACHMENTS.get(meta.r2Key);
  if (!object) throw new HttpError(404, "not_found", "The attachment file is gone.");
  return new Response(object.body, { headers: downloadHeaders(object, meta.filename, meta.mimeType) });
}

export async function handleApi(request: Request, env: Env, path: string, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const ip = rateLimitIp(request.headers.get("cf-connecting-ip") ?? "local");
  const token = bearerToken(request);
  const admin = await isAdminKey(token, env);
  if (!admin) await limit(env.GATE_LIMIT, `gate:${ip}`);

  const caller = await resolveCaller(request, env);
  if (!caller.admin) {
    const bucket = caller.key ? `read:key:${caller.key.id}` : `read:${caller.ip}`;
    await limit(env.READ_LIMIT, bucket);
  }
  if (caller.key) ctx.waitUntil(touchKey(env.DB, caller.key.id, Date.now()));

  const method = request.method;
  const parts = path.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean);

  if (parts[0] === "config" && parts.length === 1 && method === "GET") {
    const config: AppConfig = {
      domain: env.MAIL_DOMAIN,
      webTtlMinutes: Number(env.WEB_TTL_MINUTES),
      webMaxTtlMinutes: WEB_MAX_TTL_MINUTES,
      maxTtlMinutes: Number(env.MAX_TTL_MINUTES),
      maxMessagesPerInbox: MAX_MESSAGES_PER_INBOX,
      maxMessageBytes: MAX_RAW_BYTES,
      maxInboxBytes: MAX_INBOX_BYTES,
      mx: await mxStatus(env.MAIL_DOMAIN),
      hosted: hostedMode(env),
      mint: mintConfig(env),
    };
    return json(config);
  }

  if (parts[0] === "keys") {
    if (parts.length === 1 && method === "POST") return mintKey(request, env, caller);
    if (parts.length === 2 && parts[1] === "me" && method === "GET") {
      const key = await requireMintedKey(caller);
      const info: KeyInfo = await toKeyInfo(env.DB, key);
      return json(info);
    }
    if (parts.length === 2 && parts[1] === "revoke" && method === "POST") {
      const key = await requireMintedKey(caller);
      await revokeKey(env.DB, key.id);
      console.log(JSON.stringify({ event: "key_revoked", keyId: key.id }));
      return json({ revoked: true });
    }
    throw new HttpError(404, "not_found", "Unknown API path.");
  }

  if (parts[0] !== "inboxes") throw new HttpError(404, "not_found", "Unknown API path.");
  if (parts.length === 1) {
    if (method === "POST") return createInbox(request, env, caller);
    throw new HttpError(405, "method_not_allowed", "Use POST to create an inbox.");
  }

  const inbox = await authorizedInbox(env, caller, parts[1]);
  const [, , section, messageId, ...extra] = parts;

  if (section === undefined) {
    if (method === "GET") return json(await inboxInfo(env, inbox));
    if (method === "DELETE") {
      await deleteInbox(env.DB, env.ATTACHMENTS, inbox.id);
      return json({ deleted: true });
    }
  } else if (section === "extend" && method === "POST" && !messageId) {
    return extendInbox(request, env, caller, inbox);
  } else if (section === "wait" && method === "GET" && !messageId) {
    return wait(request, env, url, inbox);
  } else if (section === "sample" && method === "POST" && !messageId) {
    if (caller.key) await limit(env.CREATE_LIMIT, `sample:key:${caller.key.id}`);
    else if (!caller.admin) await limit(env.CREATE_LIMIT, `sample:${caller.ip}`);
    return deliver(request, env, inbox, "sample");
  } else if (section === "deliver" && method === "POST" && !messageId) {
    if (!caller.agent) throw new HttpError(403, "forbidden", "Only an API key can deliver raw MIME.");
    return deliver(request, env, inbox, "test");
  } else if (section === "messages") {
    if (messageId && extra[0] === "attachments" && extra.length === 2 && method === "GET") {
      return streamAttachment(env, inbox, messageId, extra[1]);
    }
    if (extra.length !== 0) throw new HttpError(404, "not_found", "Unknown API path or method.");
    if (!messageId && method === "GET") {
      const after = intParam(url, "after", 0, 0, Number.MAX_SAFE_INTEGER);
      const lim = intParam(url, "limit", MAX_MESSAGES_PER_INBOX, 1, MAX_MESSAGES_PER_INBOX);
      const messages = await listSummaries(env.DB, inbox.id, after, lim);
      const list: MessageList = {
        inbox: await inboxInfo(env, inbox),
        messages,
        cursor: messages.length ? Math.max(...messages.map((m) => m.seq)) : after,
      };
      return json(list);
    }
    if (messageId && method === "GET") {
      const message = await getMessage(env.DB, env.ATTACHMENTS, inbox.id, messageId);
      if (!message) throw new HttpError(404, "not_found", "No message has this ID in the inbox.");
      return json(message);
    }
    if (messageId && method === "DELETE") {
      if (!(await deleteMessage(env.DB, env.ATTACHMENTS, inbox.id, messageId))) {
        throw new HttpError(404, "not_found", "No message has this ID in the inbox.");
      }
      return json({ deleted: true });
    }
  }
  throw new HttpError(404, "not_found", "Unknown API path or method.");
}
