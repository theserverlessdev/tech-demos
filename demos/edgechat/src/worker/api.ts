import type { ChatMessage } from "../shared/types";
import {
  counts,
  ensureRoom,
  ensureSeedFiles,
  getAttachmentRow,
  insertAttachment,
  insertMessage,
  listMessages,
  listRooms,
} from "./db";
import { fanout } from "./room";
import { requireSession, sanitizeName, sessionCookie, upsertSession } from "./session";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const MAX_UPLOAD = 1_000_000;
const MAX_BODY = 2_000;
const ALLOWED_FILE = /^[\w .\-()[\]]+$/;

function json(data: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("cache-control", "no-store");
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers });
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

async function limitWrite(env: Env, request: Request): Promise<void> {
  const { success } = await env.WRITE_LIMIT.limit({ key: clientIp(request) });
  if (!success) throw new HttpError(429, "rate_limited", "Too many writes from this address. Wait a minute.");
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 16_000) throw new HttpError(413, "too_large", "The request body is too large.");
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "bad_json", "The body must be a JSON object.");
  }
}

function withSession(session: { id: string }, res: Response): Response {
  const headers = new Headers(res.headers);
  headers.append("set-cookie", sessionCookie(session.id));
  return new Response(res.body, { status: res.status, headers });
}

function roomFromPath(pathname: string): { id: string; rest: string } | null {
  const match = pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(.*))?$/);
  if (!match) return null;
  return { id: decodeURIComponent(match[1]!), rest: match[2] ?? "" };
}

export async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  await ensureSeedFiles(env);

  if (path === "/api/health" && request.method === "GET") {
    const c = await counts(env);
    return json({ ok: true, rooms: c.rooms, messages: c.messages });
  }

  if (path === "/api/session" && request.method === "POST") {
    await limitWrite(env, request);
    const body = await readJson(request);
    const session = await upsertSession(env, request, sanitizeName(body.displayName));
    return withSession(session, json({ session }));
  }

  if (path === "/api/session" && request.method === "GET") {
    const session = await requireSession(env, request);
    return withSession(session, json({ session }));
  }

  if (path === "/api/rooms" && request.method === "GET") {
    const rooms = await listRooms(env);
    return json({ rooms });
  }

  if (path === "/api/rooms" && request.method === "POST") {
    await limitWrite(env, request);
    const body = await readJson(request);
    const name = typeof body.name === "string" ? body.name : "";
    const room = await ensureRoom(env, name);
    return json({ room }, 201);
  }

  const fileMatch = path.match(/^\/api\/files\/([^/]+)$/);
  if (fileMatch && request.method === "GET") {
    const row = await getAttachmentRow(env, decodeURIComponent(fileMatch[1]!));
    if (!row) throw new HttpError(404, "not_found", "No file with that id.");
    const object = await env.FILES.get(row.r2_key);
    if (!object) throw new HttpError(404, "not_found", "The file is missing from R2.");
    const headers = new Headers();
    headers.set("content-type", row.content_type);
    headers.set("content-length", String(row.size));
    headers.set("cache-control", "private, max-age=3600");
    headers.set("content-disposition", `inline; filename="${row.filename.replaceAll('"', "")}"`);
    headers.set("x-content-type-options", "nosniff");
    return new Response(object.body, { headers });
  }

  const roomPath = roomFromPath(path);
  if (roomPath) {
    const room = await ensureRoom(env, roomPath.id);
    if (roomPath.rest === "" && request.method === "GET") {
      const messages = await listMessages(env, room.id);
      return json({ room, messages });
    }
    if (roomPath.rest === "messages" && request.method === "GET") {
      const messages = await listMessages(env, room.id);
      return json({ room, messages });
    }
    if (roomPath.rest === "messages" && request.method === "POST") {
      await limitWrite(env, request);
      const session = await requireSession(env, request);
      const body = await readJson(request);
      const text = typeof body.body === "string" ? body.body.replace(/\s+/g, " ").trim().slice(0, MAX_BODY) : "";
      if (!text) throw new HttpError(400, "empty", "Type a message first.");
      const message = await insertMessage(env, {
        roomId: room.id,
        author: session.displayName,
        sessionId: session.id,
        body: text,
      });
      await fanout(env, room.id, message);
      return withSession(session, json({ message }, 201));
    }
    if (roomPath.rest === "upload" && request.method === "POST") {
      await limitWrite(env, request);
      const session = await requireSession(env, request);
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new HttpError(400, "no_file", "Choose a file to upload.");
      if (file.size <= 0 || file.size > MAX_UPLOAD) throw new HttpError(413, "too_large", "Files must be between 1 byte and 1 MB.");
      const filename = file.name.replace(/[^\w .\-()[\]]+/g, "_").slice(0, 80) || "upload.bin";
      if (!ALLOWED_FILE.test(filename)) throw new HttpError(400, "bad_name", "That filename is not allowed.");
      const contentType = (file.type || "application/octet-stream").slice(0, 120);
      const key = `${room.id}/${crypto.randomUUID()}/${filename}`;
      await env.FILES.put(key, file.stream(), { httpMetadata: { contentType } });
      const attachment = await insertAttachment(env, {
        roomId: room.id,
        r2Key: key,
        filename,
        contentType,
        size: file.size,
      });
      const captionRaw = form.get("caption");
      const caption = typeof captionRaw === "string" ? captionRaw.replace(/\s+/g, " ").trim().slice(0, MAX_BODY) : "";
      const message: ChatMessage = await insertMessage(env, {
        roomId: room.id,
        author: session.displayName,
        sessionId: session.id,
        body: caption || filename,
        attachmentId: attachment.id,
      });
      await fanout(env, room.id, message);
      return withSession(session, json({ message, attachment }, 201));
    }
  }

  throw new HttpError(404, "not_found", "Unknown API route.");
}
