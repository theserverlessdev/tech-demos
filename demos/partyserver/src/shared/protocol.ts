/** Public path on the hub zone. The subdomain serves the same Worker at `/`. */
export const BASE_PATH = "/demos/partyserver";

/** Kebab-case of the `BoardRoom` binding. `routePartykitRequest` matches this segment. */
export const PARTY = "board-room";

export const MAX_CONNECTIONS = 8;
export const MAX_STROKES = 240;
export const MAX_DOC_BYTES = 256 * 1024;
export const MAX_FRAME_BYTES = MAX_DOC_BYTES + 4096;
export const MAX_FRAMES_PER_SEC = 120;
export const MAX_BYTES_PER_SEC = MAX_DOC_BYTES;
export const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
export const ROOM_ID = /^[abcdefghjkmnpqrstuvwxyz23456789]{10}$/;

export const CLOSE_EXPIRED = 4001;
export const CLOSE_FULL = 4002;
export const CLOSE_UNKNOWN = 4004;
export const CLOSE_RATE = 4008;
export const CLOSE_FRAME = 4009;

/** Flat graphite/ember inks. No purple or cyan. */
export const INK = ["#c2410c", "#e7e5e4", "#d6d3d1", "#f59e0b", "#78716c"] as const;
export type Ink = (typeof INK)[number];

export const STROKE_SIZES = [3, 6, 11] as const;

export type Stroke = {
  id: string;
  color: string;
  size: number;
  points: number[];
  client: string;
};

export type PublicConfig = {
  siteKey: string | null;
  createOpen: boolean;
  maxConnections: number;
  maxStrokes: number;
  maxDocBytes: number;
  ttlMs: number;
  party: string;
};

export type RoomStatus = {
  id: string;
  createdAt: number;
  expiresAt: number;
  alarmAt: number | null;
  connections: number;
  strokes: number;
  docBytes: number;
  full: boolean;
  expired: boolean;
};

export type CreatedRoom = {
  id: string;
  expiresAt: number;
  alarmAt: number | null;
};

export type ApiError = { error: { code: string; message: string } };

const STROKE_ID = /^[a-z0-9]{6,16}$/;
const CLIENT_ID = /^[a-z0-9]{8}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

export function parseStroke(value: unknown): Stroke | null {
  if (typeof value !== "string" || value.length > 16_000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.id !== "string" || !STROKE_ID.test(rec.id)) return null;
  if (typeof rec.color !== "string" || !COLOR.test(rec.color)) return null;
  if (typeof rec.size !== "number" || !STROKE_SIZES.includes(rec.size as (typeof STROKE_SIZES)[number])) return null;
  if (typeof rec.client !== "string" || !CLIENT_ID.test(rec.client)) return null;
  if (!Array.isArray(rec.points) || rec.points.length < 2 || rec.points.length > 600 || rec.points.length % 2 !== 0) return null;
  const points: number[] = [];
  for (const point of rec.points) {
    if (typeof point !== "number" || !Number.isInteger(point) || point < 0 || point > 10_000) return null;
    points.push(point);
  }
  return { id: rec.id, color: rec.color, size: rec.size, points, client: rec.client };
}

export function isInk(value: string): value is Ink {
  return (INK as readonly string[]).includes(value);
}
