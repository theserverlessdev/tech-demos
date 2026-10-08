import { awaitModel } from "./ai";
import { Actor } from "./actor";
import type { AwaitSource, RaceEvent, RaceMode, RaceResult, StepResult } from "../shared/types";
import { ACTOR_TTL_MS } from "../shared/types";

type RaceState = {
  counter: number;
  runId: string;
  mode: RaceMode;
  expected: number;
  budget: number;
  touchedAt: number;
};

export type RpcOk<T> = { ok: true; data: T };
export type RpcFail = { ok: false; status: number; code: string; message: string };
export type RpcResult<T> = RpcOk<T> | RpcFail;

function fail(status: number, code: string, message: string): RpcFail {
  return { ok: false, status, code, message };
}

type ArmInput = { runId: string; mode: RaceMode; expected: number };
type StepInput = { runId: string; racer: number };

function overlaps(events: RaceEvent[]): boolean {
  const open = new Map<number, number>();
  const spans: { start: number; end: number }[] = [];
  for (const event of events) {
    if (event.phase === "await-start") open.set(event.racer, event.at);
    if (event.phase === "await-end") {
      const start = open.get(event.racer);
      if (start !== undefined) spans.push({ start, end: event.at });
    }
  }
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i]!;
      const b = spans[j]!;
      if (a.start < b.end && b.start < a.end) return true;
    }
  }
  return false;
}

function awaitSource(events: RaceEvent[]): AwaitSource {
  const sources = new Set(events.filter((event) => event.phase === "await-end").map((event) => event.source));
  if (sources.size === 0) return "none";
  if (sources.size > 1) return "mixed";
  const only = [...sources][0];
  return only === "workers-ai" || only === "fallback-delay" ? only : "mixed";
}

function summarize(mode: RaceMode, expected: number, actual: number, overlapped: boolean): string {
  const lost = expected - actual;
  if (mode === "serialized" && lost === 0) {
    return `Mailbox held each update until the previous write finished, including the Workers AI wait. The counter reached ${expected}.`;
  }
  if (mode === "interleaved" && lost > 0) {
    const noun = lost === 1 ? "update" : "updates";
    return `${lost} ${noun} read the counter, waited on Workers AI while the input gate was open, and wrote a stale value.`;
  }
  if (mode === "interleaved" && lost === 0) {
    return overlapped
      ? "The waits overlapped, and this time every write still landed. Fire again if you want a lost update — an open input gate allows one, it does not guarantee the timing."
      : "The waits did not overlap this time, so no update was lost. Fire again — an open input gate allows overlap, it does not guarantee it.";
  }
  return `The counter ended at ${actual} instead of ${expected}.`;
}

export class RaceActor extends Actor<RaceState> {
  /** Sync duplicate guard. SQL from another in-flight request may still be uncommitted. */
  private seen = new Set<string>();

  protected initial(): RaceState {
    return { counter: 0, runId: "", mode: "interleaved", expected: 0, budget: 0, touchedAt: 0 };
  }

  protected override migrate(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS race_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      racer INTEGER NOT NULL,
      phase TEXT NOT NULL,
      counter INTEGER NOT NULL,
      at_ms INTEGER NOT NULL,
      source TEXT NOT NULL
    )`);
  }

  protected override afterLoad(): void {
    if (typeof this.state.counter !== "number" || !Number.isFinite(this.state.counter)) this.state.counter = 0;
    if (this.state.mode !== "serialized" && this.state.mode !== "interleaved") this.state.mode = "interleaved";
    if (typeof this.state.runId !== "string") this.state.runId = "";
    if (typeof this.state.expected !== "number") this.state.expected = 0;
    if (typeof this.state.budget !== "number") this.state.budget = 0;
    if (typeof this.state.touchedAt !== "number") this.state.touchedAt = 0;
  }

  protected override touchedAt(): number {
    return this.state.touchedAt;
  }

  protected override clearExtra(): void {
    this.ctx.storage.sql.exec("DELETE FROM race_event");
    this.seen.clear();
  }

  async arm(input: ArmInput): Promise<RpcResult<{ runId: string; mode: RaceMode; expected: number }>> {
    return this.mailbox(async () => {
      this.seen.clear();
      this.state.counter = 0;
      this.state.runId = input.runId;
      this.state.mode = input.mode;
      this.state.expected = input.expected;
      this.state.budget = input.expected;
      this.state.touchedAt = Date.now();
      this.ctx.storage.sql.exec("DELETE FROM race_event");
      await this.ctx.storage.setAlarm(Date.now() + ACTOR_TTL_MS);
      // Confirm the reset before any step handler reads the counter.
      await this.ctx.storage.sync();
      return { ok: true as const, data: { runId: input.runId, mode: input.mode, expected: input.expected } };
    });
  }

  async step(input: StepInput): Promise<RpcResult<StepResult>> {
    const run = () => this.#apply(input);
    if (this.state.mode === "serialized" && this.state.runId === input.runId) return this.mailbox(run);
    return run();
  }

  async result(runId: string): Promise<RpcResult<RaceResult>> {
    if (!runId || runId !== this.state.runId) return fail(404, "unknown_run", "That run is not on this actor.");
    const events = this.#events(runId);
    const actual = this.state.counter;
    const expected = this.state.expected;
    const overlapped = overlaps(events);
    const source = awaitSource(events);
    const body: RaceResult = {
      runId,
      mode: this.state.mode,
      expected,
      actual,
      lost: Math.max(0, expected - actual),
      overlapped,
      awaitSource: source,
      events,
      summary: summarize(this.state.mode, expected, actual, overlapped),
    };
    console.log(JSON.stringify({ event: "race_result", mode: body.mode, expected, actual, lost: body.lost, overlapped, awaitSource: source }));
    return { ok: true, data: body };
  }

  async #apply(input: StepInput): Promise<RpcResult<StepResult>> {
    if (input.runId !== this.state.runId) return fail(409, "stale_run", "That run is no longer armed.");
    if (!Number.isInteger(input.racer) || input.racer < 0 || input.racer >= this.state.expected) {
      return fail(400, "invalid", "That racer is outside this run.");
    }
    const key = `${input.runId}:${input.racer}`;
    if (this.seen.has(key) || this.#already(input.runId, input.racer)) {
      return fail(409, "duplicate", "That racer already ran.");
    }
    // Budget decrement stays in the synchronous prefix so interleaved handlers
    // cannot all read the same remaining count. The counter read below is the
    // one that races: the write happens after the model await.
    if (this.state.budget <= 0) return fail(409, "budget", "This run has no waits left.");
    this.state.budget -= 1;
    this.seen.add(key);

    const observed = this.state.counter;
    this.#record(input.runId, input.racer, "read", observed, "");
    this.#record(input.runId, input.racer, "await-start", observed, "");
    const source = await awaitModel(this.env);
    if (this.state.runId !== input.runId) return fail(409, "stale_run", "That run is no longer armed.");
    this.#record(input.runId, input.racer, "await-end", observed, source);
    const wrote = observed + 1;
    this.state.counter = wrote;
    this.state.touchedAt = Date.now();
    this.#record(input.runId, input.racer, "write", wrote, source);
    // Mailbox releases when this function returns. Sync first so a newer
    // handler's commit cannot be overwritten by this handler's older value.
    await this.ctx.storage.sync();
    return { ok: true, data: { racer: input.racer, observed, wrote, source } };
  }

  #already(runId: string, racer: number): boolean {
    const rows = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM race_event WHERE run_id = ? AND racer = ? AND phase = 'read'", runId, racer)
      .toArray();
    return (rows[0]?.n ?? 0) > 0;
  }

  #record(runId: string, racer: number, phase: RaceEvent["phase"], counter: number, source: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO race_event (run_id, racer, phase, counter, at_ms, source) VALUES (?, ?, ?, ?, ?, ?)",
      runId,
      racer,
      phase,
      counter,
      Date.now(),
      source,
    );
  }

  #events(runId: string): RaceEvent[] {
    return this.ctx.storage.sql
      .exec<{ racer: number; phase: string; counter: number; at_ms: number; source: string }>(
        "SELECT racer, phase, counter, at_ms, source FROM race_event WHERE run_id = ? ORDER BY id ASC",
        runId,
      )
      .toArray()
      .filter((row): row is { racer: number; phase: RaceEvent["phase"]; counter: number; at_ms: number; source: string } => {
        return row.phase === "read" || row.phase === "await-start" || row.phase === "await-end" || row.phase === "write";
      })
      .map((row) => ({
        racer: row.racer,
        phase: row.phase,
        counter: row.counter,
        at: row.at_ms,
        source: row.source,
      }));
  }
}
