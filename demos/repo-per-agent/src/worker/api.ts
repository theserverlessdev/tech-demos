import { getAgentByName } from "agents";
import { z } from "zod";
import type { CommitDetail, RunResult, TaskDetail } from "../shared/types";
import { TaskAgent } from "./agent";
import { countLiveTasks, deleteTaskRows, getTask, insertActivity, insertTask, listActivity, listExpired, listTasks } from "./db";
import { changedFiles } from "./diff";
import type { DemoEnv } from "./env";
import { seedFiles } from "./files";
import { asCommits, commitFiles, headCommit, readFilesAt, revokeQuiet, toSummary, tokenPlaintext, withRepo } from "./repo";
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

function json(data: unknown, status = 200, extra?: Headers): Response {
  const headers = extra ?? new Headers();
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status, headers });
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || "local";
}

function numbers(env: DemoEnv): { ttl: number; maxTasks: number } {
  const ttl = Number(env.TASK_TTL_SECONDS);
  const maxTasks = Number(env.MAX_TASKS_PER_VISITOR);
  return {
    ttl: Number.isFinite(ttl) && ttl > 0 ? ttl : 21_600,
    maxTasks: Number.isFinite(maxTasks) && maxTasks > 0 ? maxTasks : 3,
  };
}

function readVisitor(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) {
      const value = decodeURIComponent(rest.join("="));
      return VISITOR.test(value) ? value : null;
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
  const text = await request.text();
  if (text.length > 8_000) throw new HttpError(413, "too_large", "The request body is too large.");
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
  const id = decodeURIComponent(match[1] ?? "");
  if (!TASK_ID.test(id)) return null;
  return { id, rest: match[2] ?? "" };
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
  if (request.method === "GET" && path === "/api/health") return health(env);
  if (request.method === "GET" && path === "/api/session") return session(env, visitorId);
  if (request.method === "POST" && path === "/api/tasks") return createTask(request, env, visitorId);

  const taskPath = taskIdFrom(path);
  if (!taskPath) throw new HttpError(404, "not_found", "Unknown API path.");

  if (request.method === "GET" && taskPath.rest === "") return taskDetail(env, visitorId, taskPath.id);
  const commit = taskPath.rest.match(/^commits\/([0-9a-f]{40})$/);
  if (request.method === "GET" && commit?.[1]) return commitDetail(env, visitorId, taskPath.id, commit[1]);
  if (request.method === "POST" && taskPath.rest === "run") return runTask(request, env, visitorId, taskPath.id);
  if (request.method === "POST" && taskPath.rest === "token") return mintToken(request, env, visitorId, taskPath.id);
  throw new HttpError(404, "not_found", "Unknown API path.");
}

async function health(env: DemoEnv): Promise<Response> {
  await env.DB.prepare("SELECT 1 AS ok").first();
  let artifacts = "ok";
  try {
    await env.ARTIFACTS.list({ limit: 1 });
  } catch (err) {
    artifacts = "error";
    console.error(JSON.stringify({ event: "artifacts_health_failed", error: String(err).slice(0, 200) }));
  }
  return json({ ok: artifacts === "ok", artifacts, turnstile: turnstileConfigured(env) });
}

async function session(env: DemoEnv, visitorId: string): Promise<Response> {
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

  const { ttl, maxTasks } = numbers(env);
  const now = Date.now();
  if ((await countLiveTasks(env, visitorId, now)) >= maxTasks) {
    throw new HttpError(429, "repo_cap", `This browser already has ${maxTasks} live repos. Wait for one to expire.`);
  }

  const id = `task-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let seedToken = "";
  let inserted = false;
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
    const expiresAt = now + ttl * 1000;
    await insertTask(env, { id, visitorId, repoName: id, title: title.data, remote, createdAt: now, expiresAt });
    inserted = true;
    await insertActivity(env, {
      id: crypto.randomUUID(),
      taskId: id,
      kind: "created",
      commitHash: hash,
      message: "Repository created",
      createdAt: now,
    });
    await wakeAgent(env, id);
    console.log(JSON.stringify({ event: "task_created", task: id }));
    return json({ id, title: title.data, remote, createdAt: now, expiresAt, seed: hash }, 201);
  } catch (err) {
    if (created) {
      try {
        await env.ARTIFACTS.delete(id);
      } catch {
        // Deleting a repo we failed to seed is best-effort. The binding may be the failure.
      }
    }
    if (inserted) {
      try {
        await deleteTaskRows(env, id);
      } catch {
        // The row is expired by the cron if this delete fails.
      }
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

function taskAgent(env: DemoEnv, id: string) {
  return getAgentByName<DemoEnv, TaskAgent>(env.TaskAgent, id);
}

async function wakeAgent(env: DemoEnv, id: string): Promise<void> {
  try {
    const agent = await taskAgent(env, id);
    await agent.attach();
  } catch (err) {
    console.error(JSON.stringify({ event: "agent_wake_failed", task: id, error: String(err).slice(0, 200) }));
  }
}

async function taskDetail(env: DemoEnv, visitorId: string, id: string): Promise<Response> {
  const task = await requireTask(env, visitorId, id);
  const [activity, commits] = await Promise.all([
    listActivity(env, id),
    withRepo(env.ARTIFACTS, task.repoName, async (repo) => asCommits(await repo.log({ ref: "main", limit: 20 })).map(toSummary)),
  ]);
  const body: TaskDetail = {
    task: { id: task.id, title: task.title, remote: task.remote, createdAt: task.createdAt, expiresAt: task.expiresAt },
    commits,
    activity,
  };
  return json(body);
}

async function commitDetail(env: DemoEnv, visitorId: string, id: string, hash: string): Promise<Response> {
  const task = await requireTask(env, visitorId, id);
  const detail = await withRepo(env.ARTIFACTS, task.repoName, async (repo) => {
    const history = asCommits(await repo.log({ ref: "main", limit: 20 }));
    const commit = history.find((item) => item.hash === hash) ?? asCommits([await repo.readCommit(hash)])[0];
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

  const agent = await taskAgent(env, id);
  try {
    const result = await agent.runTurn({ visitorId, taskId: id, instruction: instruction.data });
    return json(result satisfies RunResult);
  } catch (err) {
    const message = err instanceof Error ? err.message : "The agent run failed.";
    console.error(JSON.stringify({ event: "agent_run_failed", task: id, error: message.slice(0, 240) }));
    throw new HttpError(502, "agent_failed", message.slice(0, 240));
  }
}

async function mintToken(request: Request, env: DemoEnv, visitorId: string, id: string): Promise<Response> {
  assertSameOrigin(request);
  await limit(env.TOKEN_LIMIT, request);
  const task = await requireTask(env, visitorId, id);
  const minted = await withRepo(env.ARTIFACTS, task.repoName, async (repo) => {
    await headCommit(repo);
    return repo.createToken("read", 600);
  });
  const token = tokenPlaintext(minted);
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
    expiresAt: minted.expiresAt ?? new Date(Date.now() + 600_000).toISOString(),
    ttlSeconds: 600,
  });
}

export async function cleanupExpired(env: DemoEnv): Promise<{ deleted: number }> {
  const expired = await listExpired(env, Date.now(), 20);
  let deleted = 0;
  for (const task of expired) {
    try {
      await env.ARTIFACTS.delete(task.repoName);
    } catch (err) {
      const text = String(err);
      if (!/not found|NOT_FOUND/i.test(text)) {
        console.error(JSON.stringify({ event: "cleanup_failed", task: task.id, error: text.slice(0, 200) }));
        continue;
      }
    }
    await deleteTaskRows(env, task.id);
    deleted++;
  }
  return { deleted };
}
