import { Agent, callable } from "agents";
import type { RunResult } from "../shared/types";
import { proposeEdit } from "./ai";
import { getTask, insertActivity } from "./db";
import type { DemoEnv } from "./env";
import { commitFiles, headCommit, readFilesAt, revokeQuiet, tokenPlaintext, withRepo } from "./repo";

export type AgentState = {
  phase: "ready" | "running" | "error";
  runs: number;
  lastCommit: string | null;
  lastError: string | null;
};

type RunInput = { visitorId: string; taskId: string; instruction: string };

/**
 * One Durable Object per task. The instance name is the task id.
 * Git bytes stay in that task's Artifacts repo; this object only remembers the run phase.
 */
export class TaskAgent extends Agent<DemoEnv, AgentState> {
  initialState: AgentState = { phase: "ready", runs: 0, lastCommit: null, lastError: null };
  #busy = false;

  @callable()
  async attach(): Promise<{ name: string }> {
    return { name: this.name };
  }

  @callable()
  async runTurn(input: RunInput): Promise<RunResult> {
    if (input.taskId !== this.name) throw new Error("This agent does not own that task.");
    if (this.#busy) throw new Error("This agent is already writing a commit.");
    this.#busy = true;
    this.setState({ ...this.state, phase: "running", lastError: null });
    try {
      const result = await this.#commit(input);
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

  async #commit(input: RunInput): Promise<RunResult> {
    const now = Date.now();
    const task = await getTask(this.env, input.visitorId, input.taskId, now);
    if (!task) throw new Error("This task is gone.");

    const current = await withRepo(this.env.ARTIFACTS, task.repoName, async (repo) => {
      const head = await headCommit(repo);
      if (!head) throw new Error("The repository has no commits yet.");
      const files = await readFilesAt(repo, head.hash);
      return { parent: head.hash, files };
    });

    const snapshot: Record<string, string> = {};
    for (const [path, content] of current.files) snapshot[path] = content;
    const edit = await proposeEdit(this.env, input.instruction, snapshot);
    if (snapshot[edit.path] === edit.content) {
      throw new Error("Workers AI returned the file unchanged, so nothing was committed.");
    }
    snapshot[edit.path] = edit.content;

    const minted = await withRepo(this.env.ARTIFACTS, task.repoName, (repo) => repo.createToken("write", 120));
    const token = tokenPlaintext(minted);
    try {
      const hash = await commitFiles({
        artifacts: this.env.ARTIFACTS,
        repoName: task.repoName,
        remote: task.remote,
        token,
        parent: current.parent,
        files: snapshot,
        message: edit.message,
      });
      await insertActivity(this.env, {
        id: crypto.randomUUID(),
        taskId: task.id,
        kind: "commit",
        commitHash: hash,
        message: edit.message,
        createdAt: Date.now(),
      });
      console.log(JSON.stringify({ event: "agent_commit", task: task.id, path: edit.path }));
      return { hash, message: edit.message, path: edit.path };
    } finally {
      await revokeQuiet(this.env.ARTIFACTS, task.repoName, token);
    }
  }
}
