export type Vec2 = { x: number; z: number };

export type Player = {
  id: string;
  name: string;
  color: string;
  x: number;
  z: number;
};

export type RoomInfo = {
  id: string;
  name: string;
};

export type ClientEvent = { type: "move"; x: number; z: number } | { type: "ping" };

export type ServerEvent =
  | { type: "hello"; room: string; you: Player; players: Player[] }
  | { type: "join"; player: Player }
  | { type: "leave"; id: string }
  | { type: "move"; id: string; x: number; z: number }
  | { type: "presence"; players: Player[] }
  | { type: "pong" }
  | { type: "error"; message: string };

export type Health = {
  ok: true;
  demo: "goodvibes";
  hibernation: true;
};

/** Floor half-extent. Positions outside this box are clamped. */
export const ARENA = 12;

export const MAX_PLAYERS = 16;

export function slugifyRoom(raw: string): string {
  const slug = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "lobby";
}

export function sanitizeName(raw: unknown): string {
  const text = String(raw ?? "")
    .replace(/[^\w .'\-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
  return text || "Guest";
}

export function clampPos(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(-ARENA, Math.min(ARENA, v));
}

const PALETTE = ["#c2410c", "#e2622e", "#d97706", "#ca8a04", "#65a30d", "#0f766e", "#b45309", "#a8a29e"];

export function colorForId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 33 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}
