import type { Attachment, ChatMessage, RoomSummary } from "../shared/types";
import { HISTORY_LIMIT } from "../shared/types";
import { RoomSlugError, slugRoom } from "../shared/slug";
import { HttpError } from "./http";

const SEED_R2_KEY = "seed/welcome.txt";
const SEED_ATTACHMENT_ID = "att_lobby_seed";
const SEED_BODY = `EdgeChat slice
Inspired by aozorae/Edgechat (GPL-3.0) — this file is original demo text.
Durable Objects fan out live messages.
D1 keeps history.
KV stores your display name.
R2 stores this attachment.
`;

type RoomRow = {
  id: string;
  name: string;
  created_at: number;
  last_message_at: number;
  last_preview: string | null;
  message_count: number;
};

type MessageRow = {
  id: string;
  room_id: string;
  author: string;
  author_key: string;
  body: string;
  attachment_id: string | null;
  created_at: number;
  att_id: string | null;
  att_filename: string | null;
  att_content_type: string | null;
  att_size: number | null;
  att_created_at: number | null;
};

type AttachmentRow = {
  id: string;
  room_id: string;
  r2_key: string;
  filename: string;
  content_type: string;
  size: number;
  created_at: number;
};

let seedDone = false;
let healthCache: { at: number; rooms: number; messages: number } | null = null;
const HEALTH_TTL_MS = 30_000;

function previewOf(body: string): string {
  const line = body.replace(/\s+/g, " ").trim();
  return line.length > 140 ? `${line.slice(0, 137)}…` : line;
}

function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    roomId: row.room_id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
}

function toMessage(row: MessageRow): ChatMessage {
  const attachment =
    row.att_id && row.att_filename && row.att_content_type != null && row.att_size != null && row.att_created_at != null
      ? {
          id: row.att_id,
          roomId: row.room_id,
          filename: row.att_filename,
          contentType: row.att_content_type,
          size: row.att_size,
          createdAt: row.att_created_at,
        }
      : null;
  return {
    id: row.id,
    roomId: row.room_id,
    author: row.author,
    authorKey: row.author_key,
    body: row.body,
    attachment,
    createdAt: row.created_at,
  };
}

function toRoom(row: RoomRow): RoomSummary {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
    lastPreview: row.last_preview ?? "",
    messageCount: row.message_count,
  };
}

const MESSAGE_SELECT = `SELECT m.id, m.room_id, m.author, m.author_key, m.body, m.attachment_id, m.created_at,
  a.id AS att_id, a.filename AS att_filename, a.content_type AS att_content_type, a.size AS att_size, a.created_at AS att_created_at
FROM messages m
LEFT JOIN attachments a ON a.id = m.attachment_id`;

const ROOM_SELECT = `SELECT r.id, r.name, r.created_at, r.last_message_at, r.last_preview, r.message_count
FROM rooms r`;

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export function parseRoom(raw: string): { id: string; name: string } {
  try {
    return slugRoom(raw);
  } catch (err) {
    if (err instanceof RoomSlugError) throw new HttpError(400, "bad_slug", err.message);
    throw err;
  }
}

export async function ensureSeedFiles(env: Env): Promise<void> {
  if (seedDone) return;
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'seeded_r2'").first<{ value: string }>();
  if (row?.value === "1") {
    seedDone = true;
    return;
  }
  const bytes = new TextEncoder().encode(SEED_BODY);
  await env.FILES.put(SEED_R2_KEY, bytes, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  await env.DB.prepare("UPDATE attachments SET size = ? WHERE id = ?").bind(bytes.byteLength, SEED_ATTACHMENT_ID).run();
  await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('seeded_r2', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
  seedDone = true;
}

export async function ensureRoom(env: Env, raw: string): Promise<RoomSummary> {
  const { id, name } = parseRoom(raw);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO rooms (id, name, created_at, last_message_at, last_preview, message_count) VALUES (?, ?, ?, 0, '', 0) ON CONFLICT(id) DO NOTHING",
  )
    .bind(id, name, now)
    .run();
  const row = await env.DB.prepare(`${ROOM_SELECT} WHERE r.id = ?`).bind(id).first<RoomRow>();
  if (!row) throw new Error("room_missing");
  healthCache = null;
  return toRoom(row);
}

export async function listRooms(env: Env): Promise<RoomSummary[]> {
  const { results } = await env.DB.prepare(
    `${ROOM_SELECT} WHERE r.message_count > 0 OR r.id = 'lobby' ORDER BY (r.id = 'lobby') DESC, r.last_message_at DESC LIMIT 40`,
  ).all<RoomRow>();
  return (results ?? []).map(toRoom);
}

export async function getRoom(env: Env, raw: string): Promise<RoomSummary | null> {
  const { id } = parseRoom(raw);
  const row = await env.DB.prepare(`${ROOM_SELECT} WHERE r.id = ?`).bind(id).first<RoomRow>();
  return row ? toRoom(row) : null;
}

export async function listMessages(env: Env, roomId: string, limit = HISTORY_LIMIT): Promise<ChatMessage[]> {
  const { results } = await env.DB.prepare(`${MESSAGE_SELECT} WHERE m.room_id = ? ORDER BY m.created_at DESC LIMIT ?`)
    .bind(roomId, limit)
    .all<MessageRow>();
  return (results ?? []).reverse().map(toMessage);
}

export async function insertMessage(
  env: Env,
  input: { roomId: string; author: string; authorKey: string; body: string; attachmentId?: string | null },
): Promise<{ message: ChatMessage; room: RoomSummary }> {
  const id = newId("msg");
  const createdAt = Date.now();
  const preview = previewOf(input.body);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO messages (id, room_id, author, session_id, author_key, body, attachment_id, created_at) VALUES (?, ?, ?, 'redacted', ?, ?, ?, ?)",
    ).bind(id, input.roomId, input.author, input.authorKey, input.body, input.attachmentId ?? null, createdAt),
    env.DB.prepare(
      "UPDATE rooms SET last_message_at = ?, last_preview = ?, message_count = message_count + 1 WHERE id = ?",
    ).bind(createdAt, preview, input.roomId),
  ]);
  healthCache = null;
  const row = await env.DB.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).bind(id).first<MessageRow>();
  if (!row) throw new Error("message_missing");
  const room = await getRoom(env, input.roomId);
  if (!room) throw new Error("room_missing");
  return { message: toMessage(row), room };
}

export async function insertAttachment(
  env: Env,
  input: { roomId: string; r2Key: string; filename: string; contentType: string; size: number },
): Promise<Attachment> {
  const id = newId("att");
  const createdAt = Date.now();
  await env.DB.prepare(
    "INSERT INTO attachments (id, room_id, r2_key, filename, content_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, input.roomId, input.r2Key, input.filename, input.contentType, input.size, createdAt)
    .run();
  return {
    id,
    roomId: input.roomId,
    filename: input.filename,
    contentType: input.contentType,
    size: input.size,
    createdAt,
  };
}

export async function getAttachmentRow(env: Env, id: string): Promise<AttachmentRow | null> {
  return env.DB.prepare("SELECT id, room_id, r2_key, filename, content_type, size, created_at FROM attachments WHERE id = ?").bind(id).first<AttachmentRow>();
}

export function attachmentPublic(row: AttachmentRow): Attachment {
  return toAttachment(row);
}

export async function counts(env: Env): Promise<{ rooms: number; messages: number }> {
  const now = Date.now();
  if (healthCache && now - healthCache.at < HEALTH_TTL_MS) {
    return { rooms: healthCache.rooms, messages: healthCache.messages };
  }
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS rooms, COALESCE(SUM(message_count), 0) AS messages FROM rooms",
  ).first<{ rooms: number; messages: number }>();
  const next = { rooms: row?.rooms ?? 0, messages: row?.messages ?? 0 };
  healthCache = { at: now, ...next };
  return next;
}

export function invalidateHealthCache(): void {
  healthCache = null;
}

export { previewOf, SEED_ATTACHMENT_ID };
