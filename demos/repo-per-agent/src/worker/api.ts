import { z } from "zod";
import type { CommitDetail, RunResult, TaskDetail } from "../shared/types";
import { AgentBudgetError, AgentBusyError, executeRun } from "./run";
import { readCommitCache, writeCommitCache } from "./cache";
import {
  bumpCleanup,
  countAllLiveTasks,
  deleteTaskRows,
  getTask,
  insertActivity,
  listActivity,
  listCommitSummaries,
  listExpired,
  listTasks,
  reserveTask,
  updateTaskRemote,
} from "./db";
import { changedFiles } from "./diff";
import type { DemoEnv } from "./env";
import { seedFiles } from "./files";
import { asCommits, commitFiles, readFilesAt, revokeQuiet, tokenExpiresAt, tokenPlaintext, withRepo } from "./repo";
import { turnstileConfigured, verifyTurnstile } from "./turnstile";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const TitleSchema = z.string().trim().min(1).max(80);
const InstructionSchema = z.string().trim().min(1).max(500);
const TurnstileSchema = z.string().trim().min(1).max(2048);
const TASK_ID = /^task-[a-f0-9]{16}$/;

const COOKIE = "rpa_vid";
const VISITOR = /^[a-f0-9]{32}$/;
const BODY_LIMIT = 8_000;

function json(data: unknown, status = 200, extra?: Headers): Response {
  const headers = extra ?? new Headers();
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status, headers });
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || "local";
}

function numbers(env: DemoEnv): { ttl: number; maxTasks: number; maxLive: number } {
  const ttl = Number(env.TASK_TTL_SECONDS);
  const maxTasks = Number(env.MAX_TASKS_PER_VISITOR);
  const maxLive = Number(env.MAX_LIVE_REPOS);
  return {
    ttl: Number.isFinite(ttl) && ttl > 0 ? ttl : 21_600,
    maxTasks: Number.isFinite(maxTasks) && maxTasks > 0 ? maxTasks : 3,
    maxLive: Number.isFinite(maxLive) && maxLive > 0 ? maxLive : 300,
  };
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function readVisitor(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) {
      const value = safeDecode(rest.join("="));
      return value && VISITOR.test(value) ? value : null;
    }
  }
  return null;
}

function cookiePath(url: URL): string {
  return url.pathname.startsWith("/demos/repo-per-agent") ? "/demos/repo-per-agent" : "/";
}

function visitorCookie(url: URL, visitorId: string): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${visitorId}; HttpOnly; SameSite=Lax; Path=${cookiePath(url)}; Max-Age=604800${secure}`;
}

function ensureVisitor(request: Request): { id: string; fresh: boolean } {
  const existing = readVisitor(request);
  if (existing) return { id: existing, fresh: false };
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return { id: [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""), fresh: true };
}

function withVisitor(request: Request, response: Response, visitor: { id: string; fresh: boolean }): Response {
  if (!visitor.fresh) return response;
  const headers = new Headers(response.headers);
  headers.append("set-cookie", visitorCookie(new URL(request.url), visitor.id));
  return new Response(response.body, { status: response.status, headers });
}

function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  if (origin !== new URL(request.url).origin) throw new HttpError(403, "origin", "Origin not allowed.");
}

async function limit(binding: RateLimit, request: Request): Promise<void> {
  const { success } = await binding.limit({ key: clientIp(request) });
  if (!success) throw new HttpError(429, "rate_limited", "Too many requests from this address. Wait a minute.");
}

async function readBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > BODY_LIMIT) {
    throw new HttpError(413, "too_large", "The request body is too large.");
  }
  const text = await request.text();
  if (text.length > BODY_LIMIT) throw new HttpError(413, "too_large", "The request body is too large.");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "bad_json", "The request body must be JSON.");
  }
}

function field(body: unknown, key: string): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  return (body as Record<string, unknown>)[key];
}

async function requireTurnstile(env: DemoEnv, request: Request, token: unknown, action: string): Promise<void> {
  if (!turnstileConfigured(env)) {
    throw new HttpError(503, "turnstile_unconfigured", "Turnstile is not configured. Set TURNSTILE_SECRET.");
  }
  const parsed = TurnstileSchema.safeParse(token);
  if (!parsed.success) throw new HttpError(400, "turnstile_required", "Complete the Turnstile check first.");
  const ok = await verifyTurnstile(env, parsed.data, clientIp(request), action);
  if (!ok) throw new HttpError(403, "turnstile_failed", "Turnstile did not pass. Try the check again.");
}

function taskIdFrom(path: string): { id: string; rest: string } | null {
  const match = path.match(/^\/api\/tasks\/([^/]+)(?:\/(.*))?$/);
  if (!match) return null;
  const raw = safeDecode(match[1] ?? "");
  if (!raw || !TASK_ID.test(raw)) return null;
  return { id: raw, rest: match[2] ?? "" };
}

async function requireTask(env: DemoEnv, visitorId: string, id: string) {
  const task = await getTask(env, visitorId, id, Date.now());
  if (!task) throw new HttpError(404, "not_found", "No task with that id for this browser.");
  return task;
}

export async function handleApi(request: Request, env: DemoEnv, path: string): Promise<Response> {
  const visitor = ensureVisitor(request);
  const response = await route(request, env, path, visitor.id);
  return withVisitor(request, response, visitor);
}

async function route(request: Request, env: DemoEnv, path: string, visitorId: string): Promise<Response> {
  if (request.method === "GET" && path === "/api/health") return health(request, env);
  if (request.method === "GET" && path === "/api/session") return session(request, env, visitorId);
  if (request.method === "POST" && path === "/api/dev/purge") return purgeVisitor(request, env, visitorId);
  if (request.method === "POST" && path === "/api/tasks") return createTask(request, env, visitorId);

  const taskPath = taskIdFrom(path);
  if (!taskPath) throw new HttpError(404, "not_found", "Unknown API path.");

  if (request.method === "GET" && taskPath.rest === "") return taskDetail(request, env, visitorId, taskPath.id);
  const commit = taskPath.rest.match(/^commits\/([0-9a-f]{40})$/);
  if (request.method === "GET" && commit?.[1]) return commitDetail(request, env, visitorId, taskPath.id, commit[1]);
  if (request.method === "POST" && taskPath.rest === "run") return runTask(request, env, visitorId, taskPath.id);
  if (request.method === "POST" && taskPath.rest === "token") return mintToken(request, env, visitorId, taskPath.id);
  throw new HttpError(404, "not_found", "Unknown API path.");
}

async function health(request: Request, env: DemoEnv): Promise<Response> {
  await limit(env.READ_LIMIT, request);
  await env.DB.prepare("SELECT 1 AS ok").first();
  return json({ ok: true });
}

async function session(request: Request, env: DemoEnv, visitorId: string): Promise<Response> {
  await limit(env.READ_LIMIT, request);
  const { ttl, maxTasks } = numbers(env);
  const tasks = await listTasks(env, visitorId, Date.now());
  return json({
    siteKey: env.TURNSTILE_SITE_KEY || null,
    ttlSeconds: ttl,
    maxTasks,
    tasks,
  });
}

async function createTask(request: Request, env: DemoEnv, visitorId: string): Promise<Response> {
  assertSameOrigin(request);
  await limit(env.CREATE_LIMIT, request);
  const body = await readBody(request);
  await requireTurnstile(env, request, field(body, "turnstileToken"), "create-task");
  const title = TitleSchema.safeParse(field(body, "title"));
  if (!title.success) throw new HttpError(400, "bad_title", "Give the task a title, up to 80 characters.");

  const { ttl, maxTasks, maxLive } = numbers(env);
  const now = Date.now();
  const id = `task-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const reserved = await reserveTask(
    env,
    { id, visitorId, repoName: id, title: title.data, remote: "", createdAt: now, expiresAt: now + ttl * 1000 },
    maxTasks,
    maxLive,
  );
  if (!reserved) {
    if ((await countAllLiveTasks(env, now)) >= maxLive) {
      throw new HttpError(429, "repo_cap", "The demo is at its live-repo ceiling. Wait for a task to expire.");
    }
    throw new HttpError(429, "repo_cap", `This browser already has ${maxTasks} live repos. Wait for one to expire.`);
  }

  let seedToken = "";
  let created = false;
  try {
    const repo = await env.ARTIFACTS.create(id, {
      description: "tech-demos repo-per-agent task",
      setDefaultBranch: "main",
    });
    created = true;
    const remote = repo.remote;
    if (!remote) throw new HttpError(502, "artifacts", "Artifacts did not return a remote.");
    seedToken = tokenPlaintext(repo.token);
    const hash = await commitFiles({
      artifacts: env.ARTIFACTS,
      repoName: id,
      remote,
      token: seedToken,
      parent: null,
      files: seedFiles(title.data),
      message: "Seed the task repository",
    });
    await updateTaskRemote(env, id, remote);
    await insertActivity(env, {
      id: crypto.randomUUID(),
      taskId: id,
      kind: "created",
      commitHash: hash,
      message: "Seed the task repository",
      createdAt: now,
    });
    console.log(JSON.stringify({ event: "task_created", task: id }));
    return json({ id, title: title.data, remote, createdAt: now, expiresAt: now + ttl * 1000, seed: hash }, 201);
  } catch (err) {
    if (created) {
      try {
        await env.ARTIFACTS.delete(id);
      } catch {
        // Deleting a repo we failed to seed is best-effort. The binding may be the failure.
      }
    }
    try {
      await deleteTaskRows(env, id);
    } catch {
      // The reserved row is expired by the cron if this delete fails.
    }
    if (err instanceof HttpError) throw err;
    const text = String(err);
    console.error(JSON.stringify({ event: "task_create_failed", task: id, error: text.slice(0, 240) }));
    const message = text.includes("needs to be run remotely")
      ? "Artifacts only runs against the remote binding. Log in with wrangler so local dev can reach it."
      : "Could not seed the Artifacts repository.";
    throw new HttpError(503, "artifacts", message);
  } finally {
    if (seedToken) await revokeQuiet(env.ARTIFACTS, id, seedToken);
  }
}

function isLocalDev(env: DemoEnv): boolean {
  return env.DIRECT_RUN === "1" || env.ENVIRONMENT === "local";
}

async function taskAgent(env: DemoEnv, id: string) {
  const { getAgentByName } = await import("agents");
  const { TaskAgent } = await import("./agent");
  return getAgentByName<DemoEnv, InstanceType<typeof TaskAgent>>(env.TaskAgent, id);
}

async function purgeVisitor(request: Request, env: DemoEnv, visitorId: string): Promise<Response> {
  if (!isLocalDev(env)) throw new HttpError(404, "not_found", "Unknown API path.");
  await limit(env.CREATE_LIMIT, request);
  await env.DB.prepare("UPDATE tasks SET expires_at = 0 WHERE visitor_id = ?").bind(visitorId).run();
  const result = await cleanupExpired(env);
  return json(result);
}

async function taskDetail(request: Request, env: DemoEnv, visitorId: string, id: string): Promise<Response> {
  await limit(env.READ_LIMIT, request);
  const task = await requireTask(env, visitorId, id);
  const [activity, commits] = await Promise.all([listActivity(env, id), listCommitSummaries(env, id)]);
  const runs = activity.filter((row) => row.kind === "commit").length;
  const body: TaskDetail = {
    task: { id: task.id, title: task.title, remote: task.remote, createdAt: task.createdAt, expiresAt: task.expiresAt },
    commits,
    activity,
    agent: { runs, phase: "ready" },
  };
  return json(body);
}

async function commitDetail(request: Request, env: DemoEnv, visitorId: string, id: string, hash: string): Promise<Response> {
  await limit(env.READ_LIMIT, request);
  const task = await requireTask(env, visitorId, id);
  const cached = await readCommitCache(task.repoName, hash);
  if (cached) return json(cached);

  const detail = await withRepo(env.ARTIFACTS, task.repoName, async (repo) => {
    const commit = asCommits([await repo.readCommit(hash)])[0];
    if (!commit || commit.hash !== hash) return null;
    const after = await readFilesAt(repo, hash);
    const parent = commit.parents[0] ?? null;
    const before = parent ? await readFilesAt(repo, parent) : new Map<string, string>();
    return { commit, before, after, parent };
  });
  if (!detail) throw new HttpError(404, "not_found", "That commit is not on main.");
  const body: CommitDetail = {
    hash,
    message: detail.commit.message,
    parent: detail.parent,
    files: changedFiles(detail.before, detail.after),
  };
  await writeCommitCache(task.repoName, hash, body);
  return json(body);
}

async function runTask(request: Request, env: DemoEnv, visitorId: string, id: string): Promise<Response> {
  assertSameOrigin(request);
  await limit(env.RUN_LIMIT, request);
  await requireTask(env, visitorId, id);
  const body = await readBody(request);
  await requireTurnstile(env, request, field(body, "turnstileToken"), "run-agent");
  const instruction = InstructionSchema.safeParse(field(body, "instruction"));
  if (!instruction.success) throw new HttpError(400, "bad_instruction", "Tell the agent what to change, up to 500 characters.");

  const input = { visitorId, taskId: id, instruction: instruction.data };
  try {
    const result = env.DIRECT_RUN === "1" ? await executeRun(env, input) : await (await taskAgent(env, id)).runTurn(input);
    return json(result satisfies RunResult);
  } catch (err) {
    throw httpFromRunError(id, err);
  }
}

export function httpFromRunError(taskId: string, err: unknown): HttpError {
  if (err instanceof AgentBusyError) return new HttpError(409, "agent_busy", err.message);
  if (err instanceof AgentBudgetError) return new HttpError(429, "ai_budget", err.message);
  const message = err instanceof Error ? err.message : "The agent run failed.";
  console.error(JSON.stringify({ event: "agent_run_failed", task: taskId, error: message.slice(0, 240) }));
  return new HttpError(502, "agent_failed", message.slice(0, 240));
}

async function mintToken(request: Request, env: DemoEnv, visitorId: string, id: string): Promise<Response> {
  assertSameOrigin(request);
  await limit(env.TOKEN_LIMIT, request);
  const task = await requireTask(env, visitorId, id);
  const minted = await withRepo(env.ARTIFACTS, task.repoName, (repo) => repo.createToken("read", 600));
  const token = tokenPlaintext(minted);
  const fallback = minted.expiresAt ?? new Date(Date.now() + 600_000).toISOString();
  const expiry = tokenExpiresAt(token, fallback);
  await insertActivity(env, {
    id: crypto.randomUUID(),
    taskId: id,
    kind: "token",
    commitHash: null,
    message: "Read-only clone token minted for 10 minutes",
    createdAt: Date.now(),
  });
  return json({
    remote: task.remote,
    token,
    expiresAt: expiry.expiresAt,
    ttlSeconds: expiry.ttlSeconds || 600,
  });
}

async function purgeAgent(env: DemoEnv, id: string): Promise<void> {
  if (env.DIRECT_RUN === "1" || !env.TaskAgent) return;
  try {
    const agent = await taskAgent(env, id);
    await agent.purge();
  } catch (err) {
    console.error(JSON.stringify({ event: "agent_purge_failed", task: id, error: String(err).slice(0, 200) }));
  }
}

const CLEANUP_BUDGET_MS = 20_000;

export async function cleanupExpired(env: DemoEnv): Promise<{ deleted: number; failed: number }> {
  const started = Date.now();
  let deleted = 0;
  let failed = 0;
  while (Date.now() - started < CLEANUP_BUDGET_MS) {
    const expired = await listExpired(env, Date.now(), 20);
    if (expired.length === 0) break;
    for (const task of expired) {
      if (Date.now() - started >= CLEANUP_BUDGET_MS) break;
      try {
        await env.ARTIFACTS.delete(task.repoName);
      } catch (err) {
        const text = String(err);
        if (!/not found|NOT_FOUND/i.test(text)) {
          console.error(JSON.stringify({ event: "cleanup_failed", task: task.id, error: text.slice(0, 200) }));
          await bumpCleanup(env, task.id, task.attempts, Date.now());
          failed++;
          continue;
        }
      }
      await purgeAgent(env, task.id);
      await deleteTaskRows(env, task.id);
      deleted++;
    }
    if (expired.length < 20) break;
  }
  return { deleted, failed };
}
