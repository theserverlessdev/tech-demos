import { Agent, callable } from "agents";
import type { RunResult } from "../shared/types";
import type { DemoEnv } from "./env";
import { AgentBusyError, executeRun, type RunInput } from "./run";

export type AgentState = {
  phase: "ready" | "running" | "error";
  runs: number;
  lastCommit: string | null;
  lastError: string | null;
};

export { AgentBusyError, AgentBudgetError, executeRun, type RunInput } from "./run";

/**
 * One Durable Object per task. The instance name is the task id.
 * Git bytes stay in that task's Artifacts repo. This object serializes runs and remembers phase.
 */
export class TaskAgent extends Agent<DemoEnv, AgentState> {
  initialState: AgentState = { phase: "ready", runs: 0, lastCommit: null, lastError: null };
  #busy = false;

  @callable()
  async runTurn(input: RunInput): Promise<RunResult> {
    if (input.taskId !== this.name) throw new Error("This agent does not own that task.");
    if (this.#busy) throw new AgentBusyError();
    this.#busy = true;
    this.setState({ ...this.state, phase: "running", lastError: null });
    try {
      const result = await executeRun(this.env, input);
      this.setState({ phase: "ready", runs: this.state.runs + 1, lastCommit: result.hash, lastError: null });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : "The agent run failed.";
      this.setState({ ...this.state, phase: "error", lastError: message.slice(0, 240) });
      throw err instanceof Error ? err : new Error(message);
    } finally {
      this.#busy = false;
    }
  }

  @callable()
  async snapshot(): Promise<AgentState> {
    return this.state;
  }

  /** Drop SQLite storage for this instance. Worker RPC only — not exposed to clients. */
  async purge(): Promise<void> {
    const destroy = (this as unknown as { destroy?: () => Promise<void> }).destroy;
    if (typeof destroy === "function") {
      await destroy.call(this);
      return;
    }
    await this.ctx.storage.deleteAll();
  }
}
