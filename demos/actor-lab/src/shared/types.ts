export const RACE_MIN = 2;
export const RACE_MAX = 6;
export const MESSAGE_MAX = 500;
export const SCRATCH_MAX = 280;
export const ROOM_MESSAGES = 40;
export const ROOM_SOCKETS = 8;
export const NAME_MAX = 24;
export const AI_UNLOCK_MS = 10 * 60 * 1000;
export const ACTOR_TTL_MS = 6 * 60 * 60 * 1000;
export const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type RaceMode = "serialized" | "interleaved";
export type AwaitSource = "workers-ai" | "fallback-delay" | "mixed" | "none";
export type MemoryLabel = "fresh" | "woke" | "reloaded";

export type RaceEvent = {
  racer: number;
  phase: "read" | "await-start" | "await-end" | "write";
  counter: number;
  at: number;
  source: string;
};

export type ArmResult = {
  runId: string;
  mode: RaceMode;
  expected: number;
};

export type StepResult = {
  racer: number;
  observed: number;
  wrote: number;
  source: "workers-ai" | "fallback-delay";
};

export type RaceResult = {
  runId: string;
  mode: RaceMode;
  expected: number;
  actual: number;
  lost: number;
  overlapped: boolean;
  awaitSource: AwaitSource;
  events: RaceEvent[];
  summary: string;
};

export type ChatMessage = {
  id: string;
  at: number;
  name: string;
  role: "human" | "actor";
  text: string;
  source: "" | "workers-ai" | "fallback";
};

export type RoomView = {
  ready: boolean;
  messages: ChatMessage[];
  scratch: string;
  peers: number;
  aiUntil: number;
  memory: MemoryLabel;
  touchedAt: number;
  expiresAt: number;
  createdAt: number;
};

export type RoomResponse = RoomView & { code: string };

export type SayResult = {
  human: ChatMessage;
  actor: ChatMessage | null;
  room: RoomView;
};

export type ServerEvent =
  | { type: "hello"; you: string; peers: number; room: RoomView }
  | { type: "said"; human: ChatMessage; actor: ChatMessage | null; peers: number; room: RoomView }
  | { type: "scratch"; text: string }
  | { type: "peers"; peers: number }
  | { type: "evicted"; room: RoomView }
  | { type: "error"; code: string; message: string };

export type LabConfig = {
  ok: true;
  model: string;
  ai: "ready" | "off";
  siteKey: string | null;
  limits: {
    raceMin: number;
    raceMax: number;
    messageMax: number;
    scratchMax: number;
    roomMessages: number;
    sockets: number;
    unlockMs: number;
    ttlMs: number;
  };
};

export type ApiErrorBody = { error: { code: string; message: string } };
