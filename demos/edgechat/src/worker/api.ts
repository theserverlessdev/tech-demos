import type { ChatMessage, SessionResponse } from "../shared/types";
import { DAILY_UPLOAD_BUDGET, MAX_BODY, MAX_JSON_BODY, MAX_UPLOAD, MAX_UPLOAD_BODY } from "../shared/types";
import {
  counts,
  ensureRoom,
  ensureSeedFiles,
  getAttachmentRow,
  getRoom,
  insertAttachment,
  insertMessage,
  listMessages,
  listRooms,
} from "./db";
import { fileResponseHeaders } from "./files";
import { assertContentLength, clientIp, HttpError, json, safeDecode } from "./http";
import { sessionWriteKey } from "./limits";
import { fanout } from "./room";
import {
  ephemeralSession,
  loadSession,
  persistSession,
  publicSession,
  requirePersistedSession,
  sanitizeName,
  sessionCookie,
  type SessionRecord,
} from "./session";
import { turnstileSiteKey, verifyTurnstile, writesOpen } from "./turnstile";

const ALLOWED_FILE = /^[\w .\-()[\]]+$/;

async function limitWrite(env: Env, request: Request, publicId?: string): Promise<void> {
  const ip = await env.WRITE_LIMIT.limit({ key: clientIp(request) });
  if (!ip.success) throw new HttpError(429, "rate_limited", "Too many writes from this address. Wait a minute.");
  if (!publicId) return;
  const session = await env.WRITE_LIMIT.limit({ key: sessionWriteKey(publicId) });
  if (!session.success) throw new HttpError(429, "rate_limited", "Too many writes from this session. Wait a minute.");
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  assertContentLength(request, MAX_JSON_BODY);
  const text = await request.text();
  if (text.length > MAX_JSON_BODY) throw new HttpError(413, "too_large", "The request body is too large.");
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "bad_json", "The body must be a JSON object.");
  }
}

function withSession(session: SessionRecord, request: Request, res: Response): Response {
  const headers = new Headers(res.headers);
  headers.append("set-cookie", sessionCookie(session.id, request));
  return new Response(res.body, { status: res.status, headers });
}

function sessionPayload(env: Env, request: Request, session: SessionResponse["session"]): SessionResponse {
  return {
    session,
    turnstileSiteKey: turnstileSiteKey(env, request),
    writesOpen: writesOpen(env, request),
  };
}

function roomFromPath(pathname: string): { id: string; rest: string } | null {
  const match = pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(.*))?$/);
  if (!match) return null;
  return { id: safeDecode(match[1]!), rest: match[2] ?? "" };
}

async function chargeUpload(env: Env, size: number): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const key = `budget:uploads:${day}`;
  const used = Number((await env.SESSIONS.get(key)) ?? "0") || 0;
  if (used + size > DAILY_UPLOAD_BUDGET) {
    throw new HttpError(429, "budget", "The demo hit today's upload budget. Try again tomorrow.");
  }
  await env.SESSIONS.put(key, String(used + size), { expirationTtl: 172_800 });
}

async function safeFanout(env: Env, roomId: string, message: ChatMessage, room: import("../shared/types").RoomSummary): Promise<void> {
  try {
    await fanout(env, roomId, message, room);
  } catch (err) {
    console.error(JSON.stringify({ event: "fanout_failed", roomId, error: String(err) }));
  }
}

export async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  if (path === "/api/health" && request.method === "GET") {
    const c = await counts(env);
    return json({ ok: true, rooms: c.rooms, messages: c.messages });
  }

  await ensureSeedFiles(env);

  if (path === "/api/session" && request.method === "POST") {
    const existing = await loadSession(env, request);
    await limitWrite(env, request, existing?.publicId);
    const body = await readJson(request);
    if (!existing) {
      if (!writesOpen(env, request)) {
        throw new HttpError(503, "turnstile_unconfigured", "Writes are off until the owner sets a Turnstile widget.");
      }
      const token = typeof body.turnstileToken === "string" ? body.turnstileToken.trim() : "";
      const ok = await verifyTurnstile(env, request, token);
      if (!ok) throw new HttpError(403, "turnstile_failed", "Complete the check, then try again.");
    }
    const record = await persistSession(env, request, sanitizeName(body.displayName));
    return withSession(record, request, json(sessionPayload(env, request, publicSession(record, true))));
  }

  if (path === "/api/session" && request.method === "GET") {
    const existing = await loadSession(env, request);
    if (existing) return withSession(existing, request, json(sessionPayload(env, request, publicSession(existing, true))));
    return json(sessionPayload(env, request, ephemeralSession()));
  }

  if (path === "/api/rooms" && request.method === "GET") {
    const rooms = await listRooms(env);
    return json({ rooms });
  }

  if (path === "/api/rooms" && request.method === "POST") {
    const session = await requirePersistedSession(env, request);
    await limitWrite(env, request, session.publicId);
    const body = await readJson(request);
    const name = typeof body.name === "string" ? body.name : "";
    const room = await ensureRoom(env, name);
    return json({ room }, 201);
  }

  const fileMatch = path.match(/^\/api\/files\/([^/]+)$/);
  if (fileMatch && request.method === "GET") {
    const row = await getAttachmentRow(env, safeDecode(fileMatch[1]!));
    if (!row) throw new HttpError(404, "not_found", "No file with that id.");
    const object = await env.FILES.get(row.r2_key);
    if (!object) throw new HttpError(404, "not_found", "The file is missing from R2.");
    return new Response(object.body, { headers: fileResponseHeaders(row) });
  }

  const roomPath = roomFromPath(path);
  if (roomPath) {
    if (roomPath.rest === "" && request.method === "GET") {
      const room = await getRoom(env, roomPath.id);
      if (!room) throw new HttpError(404, "not_found", "No room with that name.");
      const messages = await listMessages(env, room.id);
      return json({ room, messages });
    }
    if (roomPath.rest === "messages" && request.method === "GET") {
      const room = await getRoom(env, roomPath.id);
      if (!room) throw new HttpError(404, "not_found", "No room with that name.");
      const messages = await listMessages(env, room.id);
      return json({ room, messages });
    }
    if (roomPath.rest === "messages" && request.method === "POST") {
      const session = await requirePersistedSession(env, request);
      await limitWrite(env, request, session.publicId);
      const body = await readJson(request);
      const text = typeof body.body === "string" ? body.body.replace(/\s+/g, " ").trim().slice(0, MAX_BODY) : "";
      if (!text) throw new HttpError(400, "empty", "Type a message first.");
      const room = await ensureRoom(env, roomPath.id);
      const saved = await insertMessage(env, {
        roomId: room.id,
        author: session.displayName,
        authorKey: session.publicId,
        body: text,
      });
      await safeFanout(env, room.id, saved.message, saved.room);
      return withSession(session, request, json({ message: saved.message, room: saved.room }, 201));
    }
    if (roomPath.rest === "upload" && request.method === "POST") {
      const session = await requirePersistedSession(env, request);
      await limitWrite(env, request, session.publicId);
      assertContentLength(request, MAX_UPLOAD_BODY);
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new HttpError(400, "no_file", "Choose a file to upload.");
      if (file.size <= 0 || file.size > MAX_UPLOAD) throw new HttpError(413, "too_large", "Files must be between 1 byte and 1 MB.");
      const filename = file.name.replace(/[^\w .\-()[\]]+/g, "_").slice(0, 80) || "upload.bin";
      if (!ALLOWED_FILE.test(filename)) throw new HttpError(400, "bad_name", "That filename is not allowed.");
      await chargeUpload(env, file.size);
      const room = await ensureRoom(env, roomPath.id);
      const contentType = (file.type || "application/octet-stream").slice(0, 120);
      const key = `uploads/${room.id}/${crypto.randomUUID()}/${filename}`;
      await env.FILES.put(key, file.stream(), { httpMetadata: { contentType } });
      let attachment;
      try {
        attachment = await insertAttachment(env, {
          roomId: room.id,
          r2Key: key,
          filename,
          contentType,
          size: file.size,
        });
      } catch (err) {
        try {
          await env.FILES.delete(key);
        } catch {
          /* keep going */
        }
        throw err;
      }
      const captionRaw = form.get("caption");
      const caption = typeof captionRaw === "string" ? captionRaw.replace(/\s+/g, " ").trim().slice(0, MAX_BODY) : "";
      const saved = await insertMessage(env, {
        roomId: room.id,
        author: session.displayName,
        authorKey: session.publicId,
        body: caption || filename,
        attachmentId: attachment.id,
      });
      await safeFanout(env, room.id, saved.message, saved.room);
      return withSession(session, request, json({ message: saved.message, attachment, room: saved.room }, 201));
    }
    if (request.method === "GET") {
      throw new HttpError(404, "not_found", "Unknown API route.");
    }
  }

  throw new HttpError(404, "not_found", "Unknown API route.");
}
