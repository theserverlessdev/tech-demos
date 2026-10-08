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
  orbs: Orb[];
  scores: ScoreRow[];
  winner: ScoreRow | null;
};

export type RoomInfo = {
  id: string;
  name: string;
};

export type ClientEvent = { type: "move"; x: number; z: number } | { type: "start" } | { type: "ping" };

export type ServerEvent =
  | { type: "hello"; room: string; you: Player; players: Player[]; round: RoundState }
  | { type: "join"; player: Player }
  | { type: "leave"; id: string }
  | { type: "move"; id: string; x: number; z: number }
  | { type: "presence"; players: Player[] }
  | { type: "round"; round: RoundState; players: Player[] }
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
