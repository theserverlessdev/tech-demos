export type Vec2 = { x: number; z: number };

export type OrbKind = "ember" | "hot";

export type Orb = {
  id: string;
  x: number;
  z: number;
  kind: OrbKind;
};

export type Phase = "waiting" | "countdown" | "playing" | "over";

export type Player = {
  id: string;
  name: string;
  color: string;
  x: number;
  z: number;
  score: number;
};

export type ScoreRow = {
  id: string;
  name: string;
  color: string;
  score: number;
};

export type RoundState = {
  phase: Phase;
  round: number;
  endsAt: number;
  serverNow: number;
  orbs: Orb[];
  scores: ScoreRow[];
  winner: ScoreRow | null;
};

export type RoomInfo = {
  id: string;
  name: string;
};

export type PublicConfig = {
  siteKey: string | null;
  createOpen: boolean;
  maxPlayers: number;
};

export type JoinTicket = {
  room: RoomInfo;
  ticket: string;
  expiresAt: number;
};

export type ClientEvent = { type: "move"; x: number; z: number } | { type: "start" };

export type ServerEvent =
  | { type: "hello"; room: string; you: Player; players: Player[]; round: RoundState; serverNow: number }
  | { type: "join"; player: Player }
  | { type: "leave"; id: string }
  | { type: "move"; id: string; x: number; z: number }
  | { type: "presence"; players: Player[] }
  | { type: "round"; round: RoundState; players: Player[]; serverNow: number }
  | { type: "collect"; playerId: string; orbId: string; kind: OrbKind; score: number; orbs: Orb[]; scores: ScoreRow[] }
  | { type: "pong" }
  | { type: "error"; message: string };

export type Health = {
  ok: true;
  demo: "goodvibes";
  game: "ember-rush";
  hibernation: true;
};

/** Floor half-extent. Positions outside this box are clamped. */
export const ARENA = 12;
export const MAX_PLAYERS = 8;
export const ROUND_MS = 75_000;
export const COUNTDOWN_MS = 3_000;
export const ORB_COUNT = 7;
export const COLLECT_RADIUS = 0.95;
export const HOT_POINTS = 3;
export const EMBER_POINTS = 1;
/** Units per second. Client and server share this so a honest pad cannot be rejected. */
export const SPEED = 8.4;
export const MAX_SPEED = SPEED * 1.3;
export const JOIN_TICKET_TTL_MS = 120_000;
export const MAX_SOCKETS_PER_IP = 2;
export const IDLE_MS = 10 * 60 * 1000;
export const FRAME_MAX_BYTES = 512;
export const FRAME_RATE = 30;
export const FRAME_BURST = 60;

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
    .normalize("NFC")
    .replace(/[^\p{L}\p{M}\p{N} .'\-]/gu, "")
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

export function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

const PALETTE = ["#c2410c", "#e2622e", "#d97706", "#ca8a04", "#65a30d", "#0f766e", "#b45309", "#a8a29e"];

export function colorForId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 33 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

export function pointsFor(kind: OrbKind): number {
  return kind === "hot" ? HOT_POINTS : EMBER_POINTS;
}

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
