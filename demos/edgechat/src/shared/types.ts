export type Attachment = {
  id: string;
  roomId: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: number;
};

export type ChatMessage = {
  id: string;
  roomId: string;
  author: string;
  authorKey: string;
  body: string;
  attachment: Attachment | null;
  createdAt: number;
};

export type RoomSummary = {
  id: string;
  name: string;
  createdAt: number;
  lastMessageAt: number;
  lastPreview: string;
  messageCount: number;
};

/** Public session view. Never includes the cookie secret. */
export type Session = {
  publicId: string;
  displayName: string;
  createdAt: number;
  persisted: boolean;
};

export type Presence = {
  count: number;
  names: string[];
};

export type ServerEvent =
  | { type: "hello"; room: RoomSummary; you: Session; presence: Presence; messages: ChatMessage[] }
  | { type: "message"; message: ChatMessage; room: RoomSummary }
  | { type: "presence"; presence: Presence }
  | { type: "error"; message: string };

export type ClientEvent = { type: "send"; body: string } | { type: "ping" };

export type Health = {
  ok: true;
  rooms: number;
  messages: number;
};

export type SessionResponse = {
  session: Session;
  turnstileSiteKey: string | null;
  writesOpen: boolean;
};

export const HISTORY_LIMIT = 80;
export const MAX_BODY = 2_000;
export const MAX_UPLOAD = 1_000_000;
export const MAX_JSON_BODY = 16_000;
export const MAX_UPLOAD_BODY = 1_100_000;
export const MAX_FRAME = 4_096;
export const RETENTION_DAYS = 7;
export const KEEP_NEWEST_PER_ROOM = 500;
export const DAILY_UPLOAD_BUDGET = 50 * 1024 * 1024;
export const SOCKET_RATE = 5;
export const SOCKET_WINDOW_MS = 10_000;
export const INLINE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export function isInlineImageType(contentType: string): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (INLINE_IMAGE_TYPES as readonly string[]).includes(type);
}
