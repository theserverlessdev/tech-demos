import { Agent } from "agents";
import { insertDecision, insertSession, purgeSession, setHumanOutcome } from "./audit";
import { conclude, propose } from "./planner";
import { parseToolCall, runTool, type ParsedCall } from "./tools";
import { toolGate, CONFIDENCE_FLOOR_DEFAULT, type ToolGateVerdict } from "./tool-gate";
import {
  TURN_LIMIT,
  type ClefModel,
  type GateCard,
  type GateDecision,
  type GateSource,
  type HumanOutcome,
  type PendingCall,
  type Probabilities,
  type SessionView,
  type TranscriptMessage,
  GATE_DECISIONS,
} from "../shared/types";

export type GateState = {
  sessionId: string;
  model: ClefModel;
  createdAt: number;
  expiresAt: number;
  turns: number;
};

export type AgentOk = { ok: true; view: SessionView };
export type AgentErr = { ok: false; status: number; code: string; message: string };
export type AgentResult = AgentOk | AgentErr;

type Flags = { forceHeuristic: boolean; forceLocalPlanner: boolean; allowHeuristic: boolean };

type MessageRow = { id: number; role: string; content: string; meta_json: string | null; created_at: number };
type PendingRow = {
  id: string;
  decision_id: string;
  message_id: number;
  tool: string;
  args_json: string;
  args_summary: string;
  user_text: string;
  expires_at: number;
};

const initial: GateState = { sessionId: "", model: "clef", createdAt: 0, expiresAt: 0, turns: 0 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isDecision(value: unknown): value is GateDecision {
  return value === "allow" || value === "deny" || value === "ask-human";
}

function isSource(value: unknown): value is GateSource {
  return value === "clef" || value === "local-heuristic" || value === "unavailable";
}

function isHuman(value: unknown): value is HumanOutcome {
  return value === "approve" || value === "deny" || value === "expired";
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function parseCard(raw: string | null): GateCard | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) return null;
    if (typeof value.decisionId !== "string" || typeof value.tool !== "string" || typeof value.argsSummary !== "string") return null;
    if (!isDecision(value.decision) || !isSource(value.source) || typeof value.model !== "string" || typeof value.reason !== "string") return null;
    if (typeof value.confidence !== "number" || typeof value.latencyMs !== "number") return null;
    if (!isRecord(value.probabilities)) return null;
    const probabilities = {} as Probabilities;
    for (const key of GATE_DECISIONS) {
      const n = value.probabilities[key];
      if (typeof n !== "number") return null;
      probabilities[key] = n;
    }
    return {
      decisionId: value.decisionId,
      tool: value.tool,
      argsSummary: value.argsSummary,
      decision: value.decision,
      probabilities,
      confidence: value.confidence,
      latencyMs: value.latencyMs,
      source: value.source,
      model: value.model,
      reason: value.reason,
      humanOutcome: isHuman(value.humanOutcome) ? value.humanOutcome : null,
    };
  } catch {
    return null;
  }
}

function numberSetting(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * One desk per anonymous session. The pending tool call lives in this DO's
 * SQLite, so Approve/Deny still works after the HTTP request that paused it
 * has returned and after the isolate hibernates.
 */
export class GateAgent extends Agent<Env, GateState> {
  initialState: GateState = initial;
  #busy = false;

  override validateStateChange(_next: GateState, source: "server" | unknown) {
    if (source !== "server") throw new Error("Session state is read-only for clients.");
  }

  override async onStart() {
    this.ensureSchema();
  }

  private ensureSchema() {
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      meta_json TEXT,
      created_at INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS pending (
      id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      tool TEXT NOT NULL,
      args_json TEXT NOT NULL,
      args_summary TEXT NOT NULL,
      user_text TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`;
  }

  private floor(): number {
    return numberSetting(this.env.CONFIDENCE_FLOOR, CONFIDENCE_FLOOR_DEFAULT);
  }

  private sessionTtl(): number {
    return numberSetting(this.env.SESSION_TTL_SECONDS, 21_600) * 1000;
  }

  private pendingTtl(): number {
    return numberSetting(this.env.PENDING_TTL_SECONDS, 600) * 1000;
  }

  private modelId(): string {
    return this.state.model === "clef-flash" ? this.env.CLEF_FLASH_MODEL : this.env.CLEF_MODEL;
  }

  private live(): boolean {
    return this.state.createdAt > 0 && this.state.expiresAt > Date.now();
  }

  private fail(status: number, code: string, message: string): AgentErr {
    return { ok: false, status, code, message };
  }

  private async arm() {
    const pending = this.pendingRow();
    const when = pending ? Math.min(pending.expires_at, this.state.expiresAt) : this.state.expiresAt;
    if (when > Date.now()) await this.ctx.storage.setAlarm(when);
  }

  private pendingRow(): PendingRow | null {
    const rows = this.sql<PendingRow>`SELECT id, decision_id, message_id, tool, args_json, args_summary, user_text, expires_at FROM pending LIMIT 1`;
    return rows[0] ?? null;
  }

  private addMessage(role: TranscriptMessage["role"], content: string, gate: GateCard | null): number {
    const meta = gate ? JSON.stringify(gate) : null;
    this.sql`INSERT INTO messages (role, content, meta_json, created_at) VALUES (${role}, ${content}, ${meta}, ${Date.now()})`;
    const row = this.sql<{ id: number }>`SELECT last_insert_rowid() AS id`;
    return Number(row[0]?.id ?? 0);
  }

  private snapshot(): SessionView {
    const rows = this.sql<MessageRow>`SELECT id, role, content, meta_json, created_at FROM (
      SELECT id, role, content, meta_json, created_at FROM messages ORDER BY id DESC LIMIT 40
    ) ORDER BY id ASC`;
    const messages: TranscriptMessage[] = [];
    for (const row of rows) {
      if (row.role !== "user" && row.role !== "assistant" && row.role !== "tool" && row.role !== "gate") continue;
      messages.push({
        id: row.id,
        role: row.role,
        content: row.content,
        at: row.created_at,
        gate: row.role === "gate" ? parseCard(row.meta_json) : null,
      });
    }
    const pending = this.pendingRow();
    const waiting: PendingCall | null = pending
      ? { id: pending.id, decisionId: pending.decision_id, tool: pending.tool, argsSummary: pending.args_summary, expiresAt: pending.expires_at }
      : null;
    return {
      id: this.state.sessionId,
      model: this.state.model,
      expiresAt: this.state.expiresAt,
      turns: this.state.turns,
      turnLimit: TURN_LIMIT,
      messages,
      pending: waiting,
    };
  }

  private async runChat(body: unknown): Promise<unknown> {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("chat_timeout")), 8_000);
    });
    return Promise.race([this.env.AI.run(this.env.CHAT_MODEL, body as never), timeout]);
  }

  private async runClef(modelId: string, body: unknown): Promise<unknown> {
    return this.env.AI.run(modelId, body as never);
  }

  async start(input: { sessionId: string; model: ClefModel }): Promise<AgentResult> {
    this.ensureSchema();
    if (this.live() && this.state.sessionId === input.sessionId) return { ok: true, view: this.snapshot() };
    if (this.state.createdAt > 0) return this.fail(410, "expired", "This session expired. Send another message to start a new one.");
    const now = Date.now();
    const expiresAt = now + this.sessionTtl();
    this.setState({ sessionId: input.sessionId, model: input.model, createdAt: now, expiresAt, turns: 0 });
    try {
      await insertSession(this.env.DB, input.sessionId, input.model, now, expiresAt);
    } catch (err) {
      this.setState(initial);
      console.error(JSON.stringify({ event: "session_insert_failed", error: err instanceof Error ? err.message : "error" }));
      return this.fail(503, "audit_unavailable", "The audit log is unavailable. Nothing was started.");
    }
    await this.arm();
    return { ok: true, view: this.snapshot() };
  }

  async view(): Promise<AgentResult> {
    this.ensureSchema();
    if (!this.live()) {
      if (this.state.createdAt > 0) await this.wipe();
      return this.fail(410, "expired", "This session expired. Send another message to start a new one.");
    }
    return { ok: true, view: this.snapshot() };
  }

  async setModel(model: ClefModel): Promise<AgentResult> {
    this.ensureSchema();
    if (!this.live()) return this.fail(410, "expired", "This session expired.");
    this.setState({ ...this.state, model });
    try {
      await insertSession(this.env.DB, this.state.sessionId, model, this.state.createdAt, this.state.expiresAt);
    } catch (err) {
      console.error(JSON.stringify({ event: "model_persist_failed", error: err instanceof Error ? err.message : "error" }));
    }
    return { ok: true, view: this.snapshot() };
  }

  async forget(): Promise<AgentResult> {
    this.ensureSchema();
    await this.wipe();
    return this.fail(410, "forgotten", "Session cleared.");
  }

  async chat(input: { text: string; flags: Flags }): Promise<AgentResult> {
    this.ensureSchema();
    if (this.#busy) return this.fail(409, "busy", "This desk is still finishing the previous turn.");
    if (!this.live()) return this.fail(410, "expired", "This session expired.");
    if (this.pendingRow()) return this.fail(409, "pending", "Approve or deny the waiting tool call first.");
    const text = input.text.trim();
    if (!text || text.length > 500) return this.fail(400, "empty", "Write a message of 1 to 500 characters.");
    if (this.state.turns >= TURN_LIMIT) return this.fail(429, "session_full", "This session reached its message limit. Start a new one.");

    this.#busy = true;
    try {
      const plan = await propose({
        userText: text,
        forceLocal: input.flags.forceLocalPlanner,
        runChat: (body) => this.runChat(body),
      });
      if (!plan.call) {
        this.addMessage("user", text, null);
        this.addMessage("assistant", plan.text, null);
        this.setState({ ...this.state, turns: this.state.turns + 1 });
        return { ok: true, view: this.snapshot() };
      }
      const parsed = parseToolCall(plan.call.name, plan.call.args);
      if ("error" in parsed) {
        this.addMessage("user", text, null);
        this.addMessage("assistant", parsed.error, null);
        this.setState({ ...this.state, turns: this.state.turns + 1 });
        return { ok: true, view: this.snapshot() };
      }
      const verdict = await this.judge(parsed, text, input.flags);
      const card = this.card(parsed, verdict);
      try {
        await insertDecision(this.env.DB, this.state.sessionId, card);
      } catch (err) {
        console.error(JSON.stringify({ event: "audit_insert_failed", error: err instanceof Error ? err.message : "error" }));
        return this.fail(503, "audit_unavailable", "The audit log did not accept this decision, so the tool did not run.");
      }
      this.addMessage("user", text, null);
      const messageId = this.addMessage("gate", card.reason, card);
      this.setState({ ...this.state, turns: this.state.turns + 1 });
      console.log(JSON.stringify({ event: "gate", tool: parsed.tool, decision: card.decision, source: card.source, latencyMs: card.latencyMs, model: card.model }));

      if (card.decision === "ask-human") {
        const expires = Date.now() + this.pendingTtl();
        const id = newId("pend");
        this.sql`INSERT INTO pending (id, decision_id, message_id, tool, args_json, args_summary, user_text, expires_at)
          VALUES (${id}, ${card.decisionId}, ${messageId}, ${parsed.tool}, ${JSON.stringify(parsed.args)}, ${parsed.summary}, ${text}, ${expires})`;
        await this.arm();
        return { ok: true, view: this.snapshot() };
      }
      if (card.decision === "deny") {
        const closing = await conclude({
          userText: text,
          tool: parsed.tool,
          result: "",
          outcome: "denied",
          forceLocal: true,
          runChat: (body) => this.runChat(body),
        });
        this.addMessage("assistant", closing.text, null);
        return { ok: true, view: this.snapshot() };
      }
      await this.finishRan(text, parsed, input.flags.forceLocalPlanner);
      return { ok: true, view: this.snapshot() };
    } finally {
      this.#busy = false;
    }
  }

  async resolve(input: { id: string; outcome: "approve" | "deny"; flags: Flags }): Promise<AgentResult> {
    this.ensureSchema();
    if (this.#busy) return this.fail(409, "busy", "This desk is still finishing the previous turn.");
    if (!this.live()) return this.fail(410, "expired", "This session expired.");
    const pending = this.pendingRow();
    if (!pending || pending.id !== input.id) return this.fail(404, "no_pending", "That tool call is no longer waiting.");

    this.#busy = true;
    try {
      let recorded = false;
      try {
        recorded = await setHumanOutcome(this.env.DB, this.state.sessionId, pending.decision_id, input.outcome);
      } catch (err) {
        console.error(JSON.stringify({ event: "audit_update_failed", error: err instanceof Error ? err.message : "error" }));
        return this.fail(503, "audit_unavailable", "The audit log did not record your decision, so the tool did not run.");
      }
      if (!recorded) {
        this.sql`DELETE FROM pending WHERE id = ${pending.id}`;
        return { ok: true, view: this.snapshot() };
      }
      this.markHuman(pending.message_id, input.outcome);
      this.sql`DELETE FROM pending WHERE id = ${pending.id}`;
      await this.arm();

      if (input.outcome === "deny") {
        const closing = await conclude({
          userText: pending.user_text,
          tool: pending.tool,
          result: "",
          outcome: "human-denied",
          forceLocal: true,
          runChat: (body) => this.runChat(body),
        });
        this.addMessage("assistant", closing.text, null);
        return { ok: true, view: this.snapshot() };
      }

      let args: Record<string, string> = {};
      try {
        const parsed = JSON.parse(pending.args_json) as unknown;
        if (isRecord(parsed)) {
          for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === "string") args[key] = value;
          }
        }
      } catch {
        args = {};
      }
      const call = parseToolCall(pending.tool, args);
      if ("error" in call) {
        this.addMessage("assistant", call.error, null);
        return { ok: true, view: this.snapshot() };
      }
      await this.finishRan(pending.user_text, call, input.flags.forceLocalPlanner);
      return { ok: true, view: this.snapshot() };
    } finally {
      this.#busy = false;
    }
  }

  override async alarm() {
    this.ensureSchema();
    const now = Date.now();
    const pending = this.pendingRow();
    if (pending && pending.expires_at <= now) {
      try {
        await setHumanOutcome(this.env.DB, this.state.sessionId, pending.decision_id, "expired");
      } catch (err) {
        console.error(JSON.stringify({ event: "expire_audit_failed", error: err instanceof Error ? err.message : "error" }));
      }
      this.markHuman(pending.message_id, "expired");
      this.sql`DELETE FROM pending WHERE id = ${pending.id}`;
      this.addMessage("assistant", `The approval window for ${pending.tool} expired. It did not run.`, null);
    }
    if (this.state.createdAt > 0 && this.state.expiresAt <= now) {
      await this.wipe();
      return;
    }
    if (this.live()) await this.arm();
  }

  private markHuman(messageId: number, outcome: HumanOutcome) {
    const rows = this.sql<MessageRow>`SELECT id, role, content, meta_json, created_at FROM messages WHERE id = ${messageId}`;
    const card = parseCard(rows[0]?.meta_json ?? null);
    if (!card) return;
    card.humanOutcome = outcome;
    const meta = JSON.stringify(card);
    this.sql`UPDATE messages SET meta_json = ${meta} WHERE id = ${messageId}`;
  }

  private async judge(call: ParsedCall, userText: string, flags: Flags): Promise<ToolGateVerdict> {
    return toolGate(
      { tool: call.tool, arguments: call.args, argsSummary: call.summary, userRequest: userText },
      {
        model: this.state.model,
        modelId: this.modelId(),
        confidenceFloor: this.floor(),
        allowHeuristic: flags.allowHeuristic,
        forceHeuristic: flags.forceHeuristic,
        run: (modelId, body) => this.runClef(modelId, body),
      },
    );
  }

  private card(call: ParsedCall, verdict: ToolGateVerdict): GateCard {
    return {
      decisionId: newId("dec"),
      tool: call.tool,
      argsSummary: call.summary,
      decision: verdict.decision,
      probabilities: verdict.probabilities,
      confidence: verdict.confidence,
      latencyMs: verdict.latencyMs,
      source: verdict.source,
      model: verdict.model,
      reason: verdict.reason,
      humanOutcome: null,
    };
  }

  private async finishRan(userText: string, call: ParsedCall, forceLocal: boolean) {
    const result = runTool(call);
    this.addMessage("tool", result, null);
    const closing = await conclude({
      userText,
      tool: call.tool,
      result,
      outcome: "ran",
      forceLocal,
      runChat: (body) => this.runChat(body),
    });
    this.addMessage("assistant", closing.text, null);
  }

  private async wipe() {
    const id = this.state.sessionId;
    this.sql`DELETE FROM messages`;
    this.sql`DELETE FROM pending`;
    this.setState(initial);
    if (!id) return;
    try {
      await purgeSession(this.env.DB, id);
    } catch (err) {
      console.error(JSON.stringify({ event: "purge_failed", error: err instanceof Error ? err.message : "error" }));
    }
  }
}
