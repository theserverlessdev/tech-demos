import { Agent, callable, getCurrentAgent, type Connection, type ConnectionContext, type WSMessage } from "agents";
import { z } from "zod";
import {
  cycleSpeechMode,
  RECALL_MIN_SCORE,
  speechMode,
  STATE_EMOTION,
  type BrainMessage,
  type DeskState,
  type Inspection,
  type JsonRpcResponse,
  type RecallHit,
  type TraceEntry,
  type UiStateName,
  type WeatherReport,
} from "../shared/protocol";
import { cosine, embed, fromBlob, keywords, toBlob } from "./memory";
import { BudgetError, llmCost, LLM_ROUND_RESERVE_USD, meter, metered } from "./meter";
import { getTool, MODEL_TOOLS, type DeskHost } from "./tools";
import { MAX_AUDIO_BYTES, MIN_AUDIO_BYTES, pcmToWav, synthesize, transcribe, TTS_FRAME_BYTES } from "./voice";
import { currentWeather } from "./weather";

/** Upstream `runDeskTurn` allows three tool rounds before the final answer. */
const MAX_TOOL_ROUNDS = 3;
/** Upstream starts a new thread after 30 minutes of silence. */
const THREAD_IDLE_MS = 30 * 60 * 1000;
const HISTORY_MESSAGES = 12;
const MAX_FACTS = 200;
const MAX_LIST_ITEMS = 100;
const CONFIRM_TTL_SECONDS = 30;
const MCP_TIMEOUT_MS = 5000;

const ts = z.number();
const DeskMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), deviceId: z.string().max(64), firmwareVersion: z.string().max(32).optional(), ts }),
  z.object({ type: z.literal("hold_start"), ts }),
  z.object({ type: z.literal("hold_end"), ts }),
  z.object({ type: z.literal("listen_cancel"), ts }),
  z.object({ type: z.literal("text_input"), text: z.string().trim().min(1).max(500), ts }),
  z.object({ type: z.literal("gesture"), gesture: z.enum(["tap", "double_tap", "swipe_left", "swipe_right"]), ts }),
  z.object({ type: z.literal("confirm"), ok: z.boolean(), ts }),
  z.object({ type: z.literal("abort"), ts }),
  z.object({
    type: z.literal("mcp"),
    payload: z.object({ jsonrpc: z.literal("2.0"), id: z.number().int(), result: z.any().optional(), error: z.any().optional() }),
    ts,
  }),
]);

type ConnState = { ip: string };
type ReminderPayload = { kind: "timer" | "reminder"; label: string; durationSeconds: number };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string | Record<string, unknown> } };
type ChatOutput = {
  choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }[];
  response?: string;
  tool_calls?: { id?: string; name?: string; arguments?: unknown; function?: { name: string; arguments: unknown } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

class DeskError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** glm-5.3-flash can write its reasoning before a bare `</think>`, even with thinking off. Keep only the answer. */
function stripThinking(text: string): string {
  const end = text.lastIndexOf("</think>");
  const answer = end >= 0 ? text.slice(end + "</think>".length) : text;
  return answer.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
}

function normalizeOutput(out: ChatOutput): { content: string; calls: ToolCall[] } {
  const message = out.choices?.[0]?.message;
  if (message) return { content: stripThinking(message.content ?? ""), calls: message.tool_calls ?? [] };
  const calls = (out.tool_calls ?? []).map((c, i) => {
    const raw = c.function?.arguments ?? c.arguments ?? {};
    return { id: c.id ?? `call_${i}`, type: "function" as const, function: { name: c.function?.name ?? c.name ?? "", arguments: typeof raw === "string" ? raw : JSON.stringify(raw) } };
  });
  return { content: stripThinking(out.response ?? ""), calls };
}

/** Sentences, merged into segments of 120 characters or fewer. */
function speechSegments(text: string): string[] {
  const sentences = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  for (const sentence of sentences) {
    const last = out[out.length - 1];
    if (last && last.length + sentence.length + 1 <= 120) out[out.length - 1] = `${last} ${sentence}`;
    else if (sentence) out.push(sentence);
  }
  return out.slice(0, 6);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * The desk brain. One instance for each desk ID, with its own SQLite database. Upstream names this class
 * `Apollo` too (`apps/agent/src/agents/apollo.ts`).
 */
export class Apollo extends Agent<Env, DeskState> implements DeskHost {
  initialState: DeskState = {
    speechMode: "default",
    location: null,
    thread: 1,
    turns: 0,
    lastTurnAt: 0,
    device: { volume: 70, brightness: 80, firmwareVersion: "sim" },
  };

  // Memory that lives only while the Durable Object is awake. A turn or a hold keeps it awake.
  #audio: { connectionId: string; chunks: Uint8Array[]; bytes: number } | null = null;
  #busy = false;
  #aborted = false;
  #ui: UiStateName = "idle";
  #ttsSequence = 0;
  #turnConnectionId: string | null = null;
  #mcpId = 0;
  #mcpWaiters = new Map<number, { resolve: (r: JsonRpcResponse) => void; timer: ReturnType<typeof setTimeout> }>();
  #weather: WeatherReport | null = null;
  #idleWaiters: (() => void)[] = [];
  /** True when the desk pressed Yes or No while the brain still worked on the turn that asked. */
  #confirmQueued = false;

  #release() {
    this.#busy = false;
    for (const wake of this.#idleWaiters.splice(0)) wake();
  }

  /** Resolves when the current turn ends. A Yes pressed during the spoken reply waits here. */
  #whenIdle(): Promise<void> {
    return this.#busy ? new Promise((resolve) => this.#idleWaiters.push(resolve)) : Promise.resolve();
  }

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, thread INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, fact TEXT NOT NULL UNIQUE, embedding BLOB NOT NULL, dims INTEGER NOT NULL, created_at INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS list_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, list TEXT NOT NULL, item TEXT NOT NULL, created_at INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS pending_confirmations (
      id TEXT PRIMARY KEY, tool TEXT NOT NULL, args TEXT NOT NULL, summary TEXT NOT NULL, expires_at INTEGER NOT NULL, schedule_id TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS pending_device_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL, created_at INTEGER NOT NULL)`;
  }

  /** Only the server writes state. A visitor cannot push a state change from the browser. */
  validateStateChange(_next: DeskState, source: Connection | "server") {
    if (source !== "server") throw new Error("Desk state is read-only for clients.");
  }

  onConnect(connection: Connection<ConnState>, ctx: ConnectionContext) {
    connection.setState({ ip: ctx.request.headers.get("cf-connecting-ip") ?? "local" });
  }

  onClose(connection: Connection) {
    if (this.#audio?.connectionId === connection.id) this.#audio = null;
  }

  // ------------------------------------------------------------------ wire

  #send(msg: BrainMessage, connection?: Connection) {
    const text = JSON.stringify(msg);
    if (connection) connection.send(text);
    else this.broadcast(text);
  }

  #trace(entry: TraceEntry) {
    this.#send({ type: "trace", entry });
  }

  #setUi(state: UiStateName, caption?: string) {
    this.#ui = state;
    const mode = speechMode(this.state.speechMode);
    this.#send({ type: "ui_state", state, speechMode: mode.id, emotion: STATE_EMOTION[state], accentColor: mode.accentColor, caption });
  }

  async onMessage(connection: Connection<ConnState>, message: WSMessage) {
    if (typeof message !== "string") {
      const audio = this.#audio;
      if (!audio || audio.connectionId !== connection.id) return;
      const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
      if (audio.bytes + bytes.byteLength > MAX_AUDIO_BYTES) return;
      audio.chunks.push(bytes.slice());
      audio.bytes += bytes.byteLength;
      return;
    }

    let parsed: z.infer<typeof DeskMessageSchema>;
    try {
      const result = DeskMessageSchema.safeParse(JSON.parse(message));
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "invalid frame");
      parsed = result.data;
    } catch (err) {
      this.#send({ type: "error", code: "bad_frame", message: err instanceof Error ? err.message : "Invalid frame." }, connection);
      return;
    }

    switch (parsed.type) {
      case "hello":
        return this.#hello(connection, parsed.firmwareVersion);
      case "hold_start":
        if (this.#busy) return this.#send({ type: "error", code: "busy", message: "The desk is still on the last turn." }, connection);
        this.#audio = { connectionId: connection.id, chunks: [], bytes: 0 };
        return this.#setUi("listening", "Listening…");
      case "listen_cancel":
        this.#audio = null;
        return this.#setUi("idle");
      case "hold_end":
        return this.#voiceTurn(connection);
      case "text_input":
        return this.#turn(connection, parsed.text);
      case "gesture":
        return this.#gesture(parsed.gesture);
      case "confirm":
        return this.#confirm(connection, parsed.ok);
      case "abort":
        this.#aborted = true;
        this.#send({ type: "tts_aborted" });
        return this.#setUi("idle");
      case "mcp": {
        const waiter = this.#mcpWaiters.get(parsed.payload.id);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.#mcpWaiters.delete(parsed.payload.id);
          waiter.resolve(parsed.payload as JsonRpcResponse);
        }
        return;
      }
    }
  }

  async #hello(connection: Connection, firmwareVersion?: string) {
    if (firmwareVersion && firmwareVersion !== this.state.device.firmwareVersion) {
      this.setState({ ...this.state, device: { ...this.state.device, firmwareVersion } });
    }
    const mode = speechMode(this.state.speechMode);
    this.#send({ type: "ui_state", state: this.#busy ? this.#ui : "idle", speechMode: mode.id, emotion: STATE_EMOTION[this.#busy ? this.#ui : "idle"], accentColor: mode.accentColor }, connection);

    for (const s of await this.listSchedules()) {
      const p = s.payload as ReminderPayload;
      if (s.callback === "deliverReminder" && p?.kind === "timer") {
        this.#send({ type: "timer", id: s.id, label: p.label, endsAt: s.time * 1000, durationSeconds: p.durationSeconds }, connection);
      }
    }
    const pending = this.#pendingConfirm();
    if (pending) this.#send({ type: "confirm_request", id: pending.id, summary: pending.summary, expiresAt: pending.expiresAt }, connection);

    const queued = this.sql<{ id: number; message: string }>`SELECT id, message FROM pending_device_messages ORDER BY id`;
    if (queued.length) {
      this.sql`DELETE FROM pending_device_messages`;
      this.#send({ type: "play_effect", name: "chime" }, connection);
      for (const q of queued) this.#send({ type: "reminder", message: `Missed while you were away: ${q.message}` }, connection);
    }
  }

  // ------------------------------------------------------------------ turns

  async #guard(connection: Connection<ConnState>) {
    const ip = connection.state?.ip ?? "local";
    const { success } = await this.env.TURN_LIMIT.limit({ key: ip });
    if (!success) throw new DeskError("rate_limited", "Slow down a little. The demo allows 10 turns each minute.");
  }

  async #voiceTurn(connection: Connection<ConnState>) {
    const audio = this.#audio;
    this.#audio = null;
    if (!audio || audio.connectionId !== connection.id) return;
    if (audio.bytes < MIN_AUDIO_BYTES) {
      this.#send({ type: "error", code: "too_short", message: "Hold the button while you speak." }, connection);
      return this.#setUi("idle");
    }
    if (this.#busy) return;
    this.#busy = true;
    let text = "";
    try {
      await this.#guard(connection);
      this.#setUi("thinking", "Transcribing…");
      const heard = await transcribe(this.env, pcmToWav(audio.chunks));
      text = heard.text;
      this.#trace({ kind: "heard", text, seconds: Math.round(heard.seconds * 10) / 10 });
      if (!text) {
        await this.#speak("I did not catch that. Try again?");
        this.#send({ type: "turn_end", expectsReply: true });
      }
    } catch (err) {
      this.#fail(err);
    } finally {
      this.#release();
    }
    // The rate limit already counted this hold, so the text turn skips it.
    if (text) await this.#turn(connection, text, { skipGuard: true });
  }

  async #turn(connection: Connection<ConnState>, text: string, opts: { skipGuard?: boolean } = {}) {
    if (this.#busy) return this.#send({ type: "error", code: "busy", message: "The desk is still on the last turn." }, connection);
    this.#busy = true;
    this.#aborted = false;
    this.#turnConnectionId = connection.id;
    try {
      if (!opts.skipGuard) await this.#guard(connection);
      const now = Date.now();
      if (this.state.lastTurnAt && now - this.state.lastTurnAt > THREAD_IDLE_MS) {
        this.setState({ ...this.state, thread: this.state.thread + 1 });
        this.#trace({ kind: "thread", thread: this.state.thread, reason: "30 minutes of silence" });
      }
      this.sql`INSERT INTO messages (thread, role, content, created_at) VALUES (${this.state.thread}, 'user', ${text}, ${now})`;
      this.#setUi("thinking", "Thinking…");

      const hits = await this.recall(text, 4);
      this.#trace({ kind: "recall", facts: hits });

      const history = this.sql<{ role: string; content: string }>`
        SELECT role, content FROM (SELECT id, role, content FROM messages WHERE thread = ${this.state.thread} ORDER BY id DESC LIMIT ${HISTORY_MESSAGES})
        ORDER BY id`;
      const messages: Record<string, unknown>[] = [{ role: "system", content: this.#systemPrompt(hits) }, ...history];

      let reply = "";
      for (let round = 1; round <= MAX_TOOL_ROUNDS + 1; round++) {
        const withTools = round <= MAX_TOOL_ROUNDS;
        const started = Date.now();
        const out = await metered(
          this.env,
          LLM_ROUND_RESERVE_USD,
          () =>
            this.env.AI.run(this.env.AI_MODEL, {
              messages,
              ...(withTools ? { tools: MODEL_TOOLS } : {}),
              max_tokens: 700,
              temperature: 0.4,
              chat_template_kwargs: { enable_thinking: false },
            } as never) as Promise<ChatOutput>,
          (o) => llmCost(o.usage).usd,
        );
        const cost = llmCost(out.usage);
        this.#trace({ kind: "model", model: this.env.AI_MODEL, tokensIn: cost.tokensIn, tokensOut: cost.tokensOut, usd: cost.usd, ms: Date.now() - started, round });

        const { content, calls } = normalizeOutput(out);
        if (!calls.length || !withTools) {
          reply = content;
          break;
        }
        const parsedCalls = calls.map((call) => {
          const raw = call.function.arguments;
          try {
            return { call, args: (typeof raw === "string" ? (raw.trim() ? JSON.parse(raw) : {}) : raw) as Record<string, unknown> };
          } catch {
            return { call, args: null };
          }
        });
        // Invalid JSON in the history makes the next model call fail, so the history keeps only valid arguments.
        messages.push({
          role: "assistant",
          content: content || "",
          tool_calls: parsedCalls.map(({ call, args }) => ({ ...call, function: { name: call.function.name, arguments: JSON.stringify(args ?? {}) } })),
        });
        for (const { call, args } of parsedCalls) {
          const result = args ? await this.#runTool(call.function.name, args) : { error: "The tool arguments were not valid JSON." };
          messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: clip(JSON.stringify(result ?? null), 4000) });
        }
        if (this.#aborted) break;
      }

      if (this.#aborted) {
        this.#send({ type: "turn_end", expectsReply: false });
        return;
      }
      reply = reply.trim() || "Done.";
      this.sql`INSERT INTO messages (thread, role, content, created_at) VALUES (${this.state.thread}, 'assistant', ${reply}, ${Date.now()})`;
      this.setState({ ...this.state, turns: this.state.turns + 1, lastTurnAt: Date.now() });
      // The desk already answered the confirmation, so the request to press Yes is out of date. Skip its audio.
      if (this.#confirmQueued) this.#setUi("speaking", reply);
      else await this.#speak(reply);
      this.#send({ type: "turn_end", expectsReply: /\?\s*$/.test(reply) });
    } catch (err) {
      this.#fail(err);
    } finally {
      this.#release();
      this.#turnConnectionId = null;
    }
  }

  #fail(err: unknown) {
    const code = err instanceof DeskError ? err.code : err instanceof BudgetError ? "budget" : "turn_failed";
    const message = err instanceof Error ? err.message : String(err);
    console.error("turn failed", code, message);
    this.#send({ type: "play_effect", name: "error" });
    this.#send({ type: "error", code, message });
    this.#setUi("idle");
    this.#send({ type: "turn_end", expectsReply: false });
  }

  /** Upstream `tools/router.ts`: check arguments, run safe tools, and hold unsafe tools for a Yes on the desk. */
  async #runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const def = getTool(name);
    const started = Date.now();
    if (!def) {
      this.#trace({ kind: "tool", name, safety: "safe", args: clip(JSON.stringify(args), 200), ok: false, result: "unknown tool", ms: 0 });
      return { error: `Unknown tool ${name}.` };
    }
    const parsed = def.schema.safeParse(args);
    if (!parsed.success) {
      const error = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      this.#trace({ kind: "tool", name, safety: def.safety, args: clip(JSON.stringify(args), 200), ok: false, result: error, ms: 0 });
      return { error };
    }
    this.#setUi("thinking", def.caption);

    if (def.safety === "unsafe") {
      const summary = def.confirmSummary?.(parsed.data) ?? `Run ${name}?`;
      const id = crypto.randomUUID();
      const expiresAt = Date.now() + CONFIRM_TTL_SECONDS * 1000;
      for (const old of this.sql<{ id: string; schedule_id: string }>`SELECT id, schedule_id FROM pending_confirmations`) {
        await this.cancelSchedule(old.schedule_id);
        this.#send({ type: "confirm_close", id: old.id, reason: "expired" });
      }
      this.sql`DELETE FROM pending_confirmations`;
      const schedule = await this.schedule(CONFIRM_TTL_SECONDS, "expireConfirm", { id });
      this.sql`INSERT INTO pending_confirmations (id, tool, args, summary, expires_at, schedule_id)
        VALUES (${id}, ${name}, ${JSON.stringify(parsed.data)}, ${summary}, ${expiresAt}, ${schedule.id})`;
      this.#send({ type: "play_effect", name: "chime" });
      this.#send({ type: "confirm_request", id, summary, expiresAt });
      this.#trace({ kind: "tool", name, safety: "unsafe", args: clip(JSON.stringify(parsed.data), 200), ok: true, result: "needs_confirm", ms: 0 });
      return { status: "needs_confirm", summary, instruction: "Nothing ran yet. Ask the user to press Yes or No on the desk within 30 seconds." };
    }

    try {
      const result = await def.handler(parsed.data, this);
      this.#trace({ kind: "tool", name, safety: "safe", args: clip(JSON.stringify(parsed.data), 200), ok: true, result: clip(JSON.stringify(result ?? null), 240), ms: Date.now() - started });
      return result;
    } catch (err) {
      if (err instanceof BudgetError) throw err;
      const error = err instanceof Error ? err.message : String(err);
      this.#trace({ kind: "tool", name, safety: "safe", args: clip(JSON.stringify(parsed.data), 200), ok: false, result: error, ms: Date.now() - started });
      return { error };
    }
  }

  #systemPrompt(hits: RecallHit[]): string {
    const mode = speechMode(this.state.speechMode);
    const tz = this.state.location?.timezone ?? "UTC";
    const now = new Date();
    const local = now.toLocaleString("en-GB", { timeZone: tz, weekday: "long", hour: "2-digit", minute: "2-digit", day: "numeric", month: "long" });
    const factCount = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM memories`[0]?.n ?? 0;
    const lists = this.sql<{ list: string; n: number }>`SELECT list, COUNT(*) AS n FROM list_items GROUP BY list ORDER BY list LIMIT 10`;
    const remembered = hits.length ? hits.map((h) => `- ${h.fact} (${h.via} ${h.score.toFixed(2)})`).join("\n") : "- nothing matches this turn";

    return `You are Apollo, the brain of a small desk companion. The desk has a round screen, a speaker, and a microphone. Here the desk is a browser simulation on theserverless.dev. Every reply is spoken aloud.

Speech mode "${mode.id}": ${mode.prompt}

Rules:
- Reply in one to three short spoken sentences, under 280 characters. No markdown, no lists, no emoji.
- Use tools for weather, memory, timers, reminders, lists, speech mode, and the desk hardware. Call tools at once. Do not describe a plan.
- When the user tells you a lasting fact or preference about themselves, call remember_fact.
- When the user asks what you know or remember, use the memory below or call recall_memory.
- When the user asks you to forget, erase, wipe, or delete their data, call forget_everything. The desk then shows Yes and No. Never say that data is gone unless a tool result says so.
- Never invent a tool result. If a tool returns an error, say so in plain words.
- If you need one more detail, ask one short question that ends with a question mark.

Now: ${now.toISOString()} (UTC). Local time: ${local} (${tz}).
Saved location: ${this.state.location?.label ?? "none"}.
Desk: volume ${this.state.device.volume}, brightness ${this.state.device.brightness}.
Conversation thread: ${this.state.thread}.
Stored facts: ${factCount}. Lists: ${lists.length ? lists.map((l) => `${l.list} (${l.n})`).join(", ") : "none"}.

Memory recall for this turn:
${remembered}`;
  }

  /**
   * Upstream splits a reply into short segments and sends each one as its own tts_start → audio → tts_end run.
   * Short segments also help here: MeloTTS fails more often on long text, and each segment retries alone.
   */
  async #speak(text: string, state: UiStateName = "speaking") {
    this.#setUi(state, text);
    if (this.state.device.volume <= 0) return;
    const started = Date.now();
    let bytes = 0;
    let sent = 0;
    const segments = speechSegments(text);
    for (const segment of segments) {
      if (this.#aborted) return;
      try {
        const wav = await this.retry(() => synthesize(this.env, segment), { maxAttempts: 3, baseDelayMs: 150 });
        if (!wav || this.#aborted) continue;
        const sequence = ++this.#ttsSequence;
        this.#send({ type: "tts_start", format: "wav", bytes: wav.byteLength, sequence });
        for (let i = 0; i < wav.byteLength; i += TTS_FRAME_BYTES) this.broadcast(wav.subarray(i, i + TTS_FRAME_BYTES));
        this.#send({ type: "tts_end", sequence });
        bytes += wav.byteLength;
        sent++;
      } catch (err) {
        if (err instanceof BudgetError) throw err;
        // The caption already shows the reply, so a failed segment must not end the turn.
        console.error("tts segment failed", err);
      }
    }
    this.#trace({ kind: "tts", model: this.env.TTS_MODEL, chars: text.length, bytes, ms: Date.now() - started, segments: sent, failed: segments.length - sent });
  }

  // ------------------------------------------------------------------ gestures and confirmations

  async #gesture(gesture: "tap" | "double_tap" | "swipe_left" | "swipe_right") {
    if (gesture === "swipe_left" || gesture === "swipe_right") {
      const next = cycleSpeechMode(this.state.speechMode, gesture === "swipe_right" ? 1 : -1);
      this.setState({ ...this.state, speechMode: next.id });
      this.#send({ type: "play_effect", name: "ding" });
      return this.#setUi("idle", `Mode: ${next.name}`);
    }
    if (gesture === "double_tap") {
      this.#aborted = true;
      this.#send({ type: "tts_aborted" });
      return this.#setUi("idle");
    }
    if (this.#busy) return;
    if (this.#ui === "dashboard") return this.#setUi("idle");
    const loc = this.state.location;
    if (loc && (!this.#weather || Date.now() - Date.parse(this.#weather.updatedAt) > 10 * 60 * 1000)) {
      try {
        this.#weather = await currentWeather(loc);
      } catch (err) {
        console.error("weather refresh failed", err);
      }
    }
    this.#send({ type: "dashboard", clock: { timezone: loc?.timezone ?? "UTC", isoNow: new Date().toISOString() }, weather: loc ? this.#weather : null });
    this.#setUi("dashboard");
  }

  #pendingConfirm() {
    const row = this.sql<{ id: string; tool: string; args: string; summary: string; expires_at: number; schedule_id: string }>`
      SELECT * FROM pending_confirmations ORDER BY expires_at DESC LIMIT 1`[0];
    return row ? { id: row.id, tool: row.tool, args: row.args, summary: row.summary, expiresAt: row.expires_at, scheduleId: row.schedule_id } : null;
  }

  async #confirm(connection: Connection<ConnState>, ok: boolean) {
    this.#confirmQueued = this.#busy;
    await this.#whenIdle();
    this.#confirmQueued = false;
    const pending = this.#pendingConfirm();
    if (!pending || this.#busy) return;
    this.#busy = true;
    try {
      this.sql`DELETE FROM pending_confirmations WHERE id = ${pending.id}`;
      await this.cancelSchedule(pending.scheduleId);
      this.#send({ type: "confirm_close", id: pending.id, reason: ok ? "accepted" : "declined" });
      let line = "Okay. I kept everything.";
      if (ok) {
        const def = getTool(pending.tool);
        const started = Date.now();
        const result = def ? await def.handler(JSON.parse(pending.args), this) : { error: "unknown tool" };
        this.#trace({ kind: "tool", name: pending.tool, safety: "unsafe", args: "(confirmed on desk)", ok: true, result: clip(JSON.stringify(result), 240), ms: Date.now() - started });
        line = "Done. I forgot everything. It is a fresh start.";
      }
      this.sql`INSERT INTO messages (thread, role, content, created_at) VALUES (${this.state.thread}, 'assistant', ${line}, ${Date.now()})`;
      await this.#speak(line);
      this.#send({ type: "turn_end", expectsReply: false });
    } catch (err) {
      this.#fail(err);
    } finally {
      this.#release();
    }
  }

  /** Schedule callback. Upstream `expireConfirm`. */
  async expireConfirm(payload: { id: string }) {
    const deleted = this.sql<{ id: string }>`DELETE FROM pending_confirmations WHERE id = ${payload.id} RETURNING id`;
    if (!deleted.length) return;
    this.#send({ type: "confirm_close", id: payload.id, reason: "expired" });
    if (!this.#busy) this.#setUi("idle", "The request expired.");
  }

  /** Schedule callback. Upstream `deliverReminder`. Timers and reminders share it. */
  async deliverReminder(payload: ReminderPayload, schedule: { id: string }) {
    const message =
      payload.kind === "timer" ? (payload.label && payload.label !== "Timer" ? `Your ${payload.label} timer is done.` : "Your timer is done.") : payload.label;
    if (payload.kind === "timer") this.#send({ type: "timer_clear", id: schedule.id });
    if ([...this.getConnections()].length === 0) {
      this.sql`INSERT INTO pending_device_messages (message, created_at) VALUES (${message}, ${Date.now()})`;
      return;
    }
    this.#send({ type: "play_effect", name: "chime" });
    this.#send({ type: "reminder", message });
    // The schedule fires once. If a turn is running, speak the reminder when that turn ends.
    await this.#whenIdle();
    if (this.#busy) return;
    this.#busy = true;
    try {
      await this.#speak(message);
      this.#send({ type: "turn_end", expectsReply: false });
    } catch (err) {
      console.error("reminder speech failed", err);
    } finally {
      this.#release();
    }
  }

  // ------------------------------------------------------------------ DeskHost (tool effects)

  patchState(patch: Partial<DeskState>) {
    this.setState({ ...this.state, ...patch });
  }

  setWeather(report: WeatherReport) {
    this.#weather = report;
  }

  async rememberFact(fact: string) {
    const existing = this.sql<{ id: number; dims: number }>`SELECT id, dims FROM memories WHERE lower(fact) = lower(${fact})`[0];
    if (existing) return { id: existing.id, dims: existing.dims, duplicate: true };
    const count = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM memories`[0]?.n ?? 0;
    if (count >= MAX_FACTS) this.sql`DELETE FROM memories WHERE id = (SELECT MIN(id) FROM memories)`;
    const [vector] = await embed(this.env, [fact]);
    if (!vector) throw new Error("The embedding model returned no vector.");
    const row = this.ctx.storage.sql
      .exec<{ id: number }>("INSERT INTO memories (fact, embedding, dims, created_at) VALUES (?, ?, ?, ?) RETURNING id", fact, toBlob(vector), vector.length, Date.now())
      .one();
    return { id: row.id, dims: vector.length, duplicate: false };
  }

  async recall(query: string, limit: number, minScore = RECALL_MIN_SCORE): Promise<RecallHit[]> {
    const rows = this.ctx.storage.sql.exec<{ fact: string; embedding: ArrayBuffer }>("SELECT fact, embedding FROM memories").toArray();
    if (!rows.length) return [];
    const [q] = await embed(this.env, [query]);
    const vector = q
      ? rows
          .map((r) => ({ fact: r.fact, score: cosine(q, fromBlob(r.embedding)), via: "vector" as const }))
          .filter((h) => h.score >= minScore)
          .sort((a, b) => b.score - a.score)
      : [];
    const words = keywords(query);
    const keyword = rows
      .filter((r) => !vector.some((v) => v.fact === r.fact))
      .map((r) => ({ fact: r.fact, hits: words.filter((w) => r.fact.toLowerCase().includes(w)).length }))
      .filter((r) => r.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .map((r) => ({ fact: r.fact, score: r.hits / Math.max(1, words.length), via: "keyword" as const }));
    return [...vector.slice(0, limit), ...keyword].slice(0, limit);
  }

  forgetEverything() {
    const count = (table: string) => this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
    const result = { facts: count("memories"), items: count("list_items"), messages: count("messages") };
    this.sql`DELETE FROM memories`;
    this.sql`DELETE FROM list_items`;
    this.sql`DELETE FROM messages`;
    this.setState({ ...this.state, thread: this.state.thread + 1, lastTurnAt: 0 });
    return result;
  }

  addListItem(list: string, item: string) {
    const name = list.toLowerCase();
    const count = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM list_items`[0]?.n ?? 0;
    if (count >= MAX_LIST_ITEMS) throw new Error(`This desk holds ${MAX_LIST_ITEMS} list items at most.`);
    this.sql`INSERT INTO list_items (list, item, created_at) VALUES (${name}, ${item}, ${Date.now()})`;
    return { list: name, count: this.readList(name).length };
  }

  readList(list: string) {
    return this.sql<{ item: string }>`SELECT item FROM list_items WHERE list = ${list.toLowerCase()} ORDER BY id`.map((r) => r.item);
  }

  removeListItem(list: string, item: string) {
    const removed = this.sql<{ id: number }>`
      DELETE FROM list_items WHERE id = (SELECT id FROM list_items WHERE list = ${list.toLowerCase()} AND lower(item) = lower(${item}) LIMIT 1) RETURNING id`;
    return removed.length > 0;
  }

  async scheduleReminder(kind: "timer" | "reminder", label: string, delaySeconds: number) {
    const schedule = await this.schedule<ReminderPayload>(delaySeconds, "deliverReminder", { kind, label, durationSeconds: delaySeconds });
    if (kind === "timer") this.#send({ type: "timer", id: schedule.id, label, endsAt: schedule.time * 1000, durationSeconds: delaySeconds });
    return { id: schedule.id, firesAt: new Date(schedule.time * 1000).toISOString() };
  }

  async listReminders() {
    const now = Date.now() / 1000;
    return (await this.listSchedules())
      .filter((s) => s.callback === "deliverReminder")
      .map((s) => {
        const p = s.payload as ReminderPayload;
        return { id: s.id, kind: p.kind, label: p.label, inSeconds: Math.max(0, Math.round(s.time - now)) };
      });
  }

  async cancelReminder(id: string) {
    const s = (await this.listSchedules()).find((x) => x.id === id && x.callback === "deliverReminder");
    if (!s) return false;
    const ok = await this.cancelSchedule(id);
    if (ok) this.#send({ type: "timer_clear", id });
    return ok;
  }

  /** Upstream `mcp/bridge.ts`: JSON-RPC over the device socket, integer ids, and a 5 s timeout. */
  async deviceTool(name: string, args: Record<string, unknown>) {
    const connections = [...this.getConnections()];
    const target = connections.find((c) => c.id === this.#turnConnectionId) ?? connections[0];
    if (!target) throw new Error("No desk is connected.");
    const id = ++this.#mcpId;
    const response = await new Promise<JsonRpcResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.#mcpWaiters.delete(id);
        resolve({ jsonrpc: "2.0", id, error: { code: -32000, message: "The desk did not answer in 5 seconds." } });
      }, MCP_TIMEOUT_MS);
      this.#mcpWaiters.set(id, { resolve, timer });
      this.#send({ type: "mcp", payload: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } } }, target);
    });
    if (response.error) throw new Error(response.error.message);
    const text = response.result?.content?.map((c) => c.text).join("\n") ?? "";
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // Plain text result.
    }
    if (response.result?.isError) throw new Error(typeof data === "string" ? data : JSON.stringify(data));
    const d = data as { volume?: number; brightness?: number };
    if (typeof d?.volume === "number" || typeof d?.brightness === "number") {
      this.setState({
        ...this.state,
        device: { ...this.state.device, volume: d.volume ?? this.state.device.volume, brightness: d.brightness ?? this.state.device.brightness },
      });
    }
    return data;
  }

  // ------------------------------------------------------------------ console RPC

  /** The console panel reads the desk's SQLite through this callable. */
  @callable()
  async inspect(): Promise<Inspection> {
    const facts = this.sql<{ id: number; fact: string; dims: number; created_at: number }>`
      SELECT id, fact, dims, created_at FROM memories ORDER BY id DESC LIMIT 50`;
    const list = this.sql<{ id: number; list: string; item: string; created_at: number }>`
      SELECT id, list, item, created_at FROM list_items ORDER BY list, id LIMIT 100`;
    const messages = this.sql<{ id: number; thread: number; role: "user" | "assistant"; content: string; created_at: number }>`
      SELECT * FROM (SELECT id, thread, role, content, created_at FROM messages ORDER BY id DESC LIMIT 40) ORDER BY id`;
    const schedules = (await this.listSchedules()).map((s) => {
      const p = s.payload as Partial<ReminderPayload> & { id?: string };
      return { id: s.id, kind: s.callback === "deliverReminder" ? (p.kind ?? "reminder") : s.callback, label: p.label ?? p.id ?? "", time: s.time * 1000 };
    });
    const pending = this.#pendingConfirm();
    const tables = this.ctx.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name")
      .toArray()
      .map(({ name }) => ({ name, rows: this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).one().n }));
    const { spent, budget } = await meter(this.env).status();
    return {
      desk: this.name,
      facts,
      list,
      messages,
      schedules,
      pendingConfirm: pending ? { id: pending.id, summary: pending.summary, expiresAt: pending.expiresAt } : null,
      budget: { spent, budget },
      tables,
    };
  }

  /** Scores every stored fact against a query, so the console can show how vector recall ranks them. */
  @callable()
  async probeMemory(query: string): Promise<RecallHit[]> {
    const q = String(query ?? "").trim().slice(0, 200);
    if (q.length < 2) return [];
    const { connection } = getCurrentAgent();
    if (connection) await this.#guard(connection as Connection<ConnState>);
    return this.recall(q, 8, -1);
  }
}
