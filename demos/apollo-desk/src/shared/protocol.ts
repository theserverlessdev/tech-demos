/**
 * The desk ↔ brain wire contract. The names and fields follow upstream Apollo
 * (`apps/agent/src/protocol/schema.ts`). The Worker checks inbound frames with Zod. The browser desk
 * imports only these types.
 */

export type UiStateName = "idle" | "listening" | "thinking" | "confirm" | "speaking" | "dashboard";
export type FaceEmotion = "neutral" | "curious" | "focused" | "questioning" | "talking";
export type SpeechModeId = "default" | "nerd" | "playful" | "warm";
export type Gesture = "tap" | "double_tap" | "swipe_left" | "swipe_right";

export type SpeechMode = { id: SpeechModeId; name: string; prompt: string; accentColor: string };

/** Upstream `persona/catalog.ts`, with the prompts in English. The accent colours are the upstream values. */
export const SPEECH_MODES: SpeechMode[] = [
  { id: "default", name: "default", prompt: "Clear and useful. One to three spoken sentences. No jokes and no jargon.", accentColor: "#FFFFFF" },
  { id: "nerd", name: "nerd", prompt: "Precise and technical. Assume the user writes code. Add one exact detail when it helps.", accentColor: "#F5C518" },
  { id: "playful", name: "playful", prompt: "Light and teasing, with a small joke when it fits. Never mean. Stay useful.", accentColor: "#C45C26" },
  { id: "warm", name: "warm", prompt: "Warm and close. You can ask how the user feels. Stay useful and do not act as a therapist.", accentColor: "#B56B7A" },
];

export function speechMode(id: string): SpeechMode {
  return SPEECH_MODES.find((m) => m.id === id) ?? SPEECH_MODES[0]!;
}

export function cycleSpeechMode(id: string, direction: 1 | -1): SpeechMode {
  const i = SPEECH_MODES.findIndex((m) => m.id === speechMode(id).id);
  return SPEECH_MODES[(i + direction + SPEECH_MODES.length) % SPEECH_MODES.length]!;
}

/** Upstream `persona/face.ts`. */
export const STATE_EMOTION: Record<UiStateName, FaceEmotion> = {
  idle: "neutral",
  listening: "curious",
  thinking: "focused",
  confirm: "questioning",
  speaking: "talking",
  dashboard: "neutral",
};

/** Desk → brain JSON frames. PCM audio (16 kHz, mono, s16le) goes up in binary frames between hold_start and hold_end. */
export type DeskMessage =
  | { type: "hello"; deviceId: string; firmwareVersion?: string; ts: number }
  | { type: "hold_start"; ts: number }
  | { type: "hold_end"; ts: number }
  | { type: "listen_cancel"; ts: number }
  | { type: "text_input"; text: string; ts: number }
  | { type: "gesture"; gesture: Gesture; ts: number }
  | { type: "confirm"; ok: boolean; ts: number }
  | { type: "abort"; ts: number }
  | { type: "mcp"; payload: JsonRpcResponse; ts: number };

export type DashboardPayload = {
  clock: { timezone: string; isoNow: string };
  weather: WeatherReport | null;
};

export type WeatherReport = {
  locationLabel: string;
  temperatureC: number;
  conditionLabel: string;
  highC?: number;
  lowC?: number;
  windKph?: number;
  updatedAt: string;
};

/** Brain → desk JSON frames. TTS audio comes down in binary frames between tts_start and tts_end. */
export type BrainMessage =
  | { type: "ui_state"; state: UiStateName; speechMode: SpeechModeId; emotion: FaceEmotion; accentColor: string; caption?: string }
  | { type: "confirm_request"; id: string; summary: string; expiresAt: number }
  | { type: "confirm_close"; id: string; reason: "accepted" | "declined" | "expired" }
  | { type: "tts_start"; format: "wav"; bytes: number; sequence: number }
  | { type: "tts_end"; sequence: number }
  | { type: "tts_aborted" }
  | { type: "timer"; id: string; label: string; endsAt: number; durationSeconds: number }
  | { type: "timer_clear"; id: string }
  | { type: "turn_end"; expectsReply: boolean }
  | { type: "error"; code: string; message: string }
  | { type: "dashboard"; clock: DashboardPayload["clock"]; weather: WeatherReport | null }
  | { type: "reminder"; message: string }
  | { type: "play_effect"; name: "ding" | "chime" | "error" }
  | { type: "mcp"; payload: JsonRpcRequest }
  /** Demo addition. Upstream consoles read this data over RPC. The browser shows it in the trace panel. */
  | { type: "trace"; entry: TraceEntry };

export type TraceEntry =
  | { kind: "heard"; text: string; seconds: number }
  | { kind: "recall"; facts: { fact: string; score: number; via: "vector" | "keyword" }[] }
  | { kind: "tool"; name: string; safety: "safe" | "unsafe"; args: string; ok: boolean; result: string; ms: number }
  | { kind: "model"; model: string; tokensIn: number; tokensOut: number; usd: number; ms: number; round: number }
  | { kind: "tts"; model: string; chars: number; bytes: number; ms: number; segments: number; failed: number }
  | { kind: "thread"; thread: number; reason: string };

export type JsonRpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: Record<string, unknown> };
export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: { content?: { type: "text"; text: string }[]; isError?: boolean; [key: string]: unknown };
  error?: { code: number; message: string };
};

/** Agent state. The Agents SDK saves it in SQLite and syncs it to every connected desk. */
export type DeskState = {
  speechMode: SpeechModeId;
  location: { label: string; latitude: number; longitude: number; timezone: string } | null;
  thread: number;
  turns: number;
  lastTurnAt: number;
  device: { volume: number; brightness: number; firmwareVersion: string };
};

export type FactRow = { id: number; fact: string; dims: number; created_at: number };
export type ListItemRow = { id: number; list: string; item: string; created_at: number };
export type MessageRow = { id: number; thread: number; role: "user" | "assistant"; content: string; created_at: number };
export type ScheduleRow = { id: string; kind: string; label: string; time: number };

export type Inspection = {
  desk: string;
  facts: FactRow[];
  list: ListItemRow[];
  messages: MessageRow[];
  schedules: ScheduleRow[];
  pendingConfirm: { id: string; summary: string; expiresAt: number } | null;
  budget: { spent: number; budget: number };
  tables: { name: string; rows: number }[];
};

export type RecallHit = { fact: string; score: number; via: "vector" | "keyword" };

/**
 * Cosine line for automatic recall on each turn. In tests with bge-small-en-v1.5, related facts scored 0.50 to 0.65
 * and unrelated facts scored 0.41 or lower.
 */
export const RECALL_MIN_SCORE = 0.48;
/** The recall_memory tool is an explicit search, so it keeps weaker matches. */
export const RECALL_TOOL_MIN_SCORE = 0.3;
