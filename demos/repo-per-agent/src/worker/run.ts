import type { RunResult } from "../shared/types";
import { proposeEdit } from "./ai";
import { claimAiCall, getTask, insertActivity } from "./db";
import type { DemoEnv } from "./env";
import { commitFiles, headCommit, readFilesAt, revokeQuiet, tokenPlaintext, withRepo } from "./repo";

export type RunInput = { visitorId: string; taskId: string; instruction: string };

export class AgentBusyError extends Error {
  readonly code = "agent_busy";
  constructor() {
    super("This agent is already writing a commit.");
  }
}

export class AgentBudgetError extends Error {
  readonly code = "ai_budget";
  constructor() {
    super("The shared Workers AI budget for today is used up. Try again tomorrow.");
  }
}

function aiCap(env: DemoEnv): number {
  const n = Number(env.AI_CALLS_PER_DAY);
  return Number.isFinite(n) && n > 0 ? n : 80;
}

/** The commit path, usable from the Durable Object or the local harness. */
export async function executeRun(env: DemoEnv, input: RunInput): Promise<RunResult> {
  const now = Date.now();
  const task = await getTask(env, input.visitorId, input.taskId, now);
  if (!task) throw new Error("This task is gone.");

  const current = await withRepo(env.ARTIFACTS, task.repoName, async (repo) => {
    const head = await headCommit(repo);
    if (!head) throw new Error("The repository has no commits yet.");
    const files = await readFilesAt(repo, head.hash);
    return { parent: head.hash, files };
  });

  if (!(await claimAiCall(env, now, aiCap(env)))) throw new AgentBudgetError();

  const snapshot: Record<string, string> = {};
  for (const [path, content] of current.files) snapshot[path] = content;
  const edit = await proposeEdit(env, input.instruction, snapshot);
  if (snapshot[edit.path] === edit.content) {
    throw new Error("Workers AI returned the file unchanged, so nothing was committed.");
  }
  snapshot[edit.path] = edit.content;

  const minted = await withRepo(env.ARTIFACTS, task.repoName, (repo) => repo.createToken("write", 120));
  const token = tokenPlaintext(minted);
  try {
    const hash = await commitFiles({
      artifacts: env.ARTIFACTS,
      repoName: task.repoName,
      remote: task.remote,
      token,
      parent: current.parent,
      files: snapshot,
      message: edit.message,
    });
    await insertActivity(env, {
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
    await revokeQuiet(env.ARTIFACTS, task.repoName, token);
  }
}
