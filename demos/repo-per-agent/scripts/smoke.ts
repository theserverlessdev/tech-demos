// Smoke: bun run scripts/smoke.ts [baseUrl]
import { makeBlob } from "../src/worker/git";
import type { CloneToken, CommitDetail, RunResult, SessionPayload, TaskDetail } from "../src/shared/types";

const base = (process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const DUMMY = "XXXX.DUMMY.TOKEN.XXXX";

let failures = 0;
function check(label: string, ok: unknown, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

const blob = await makeBlob("hello\n");
check("blob hash matches git hash-object", blob.sha === "ce013625030ba8dba906f756967f9e9ca394464a", blob.sha);

type Jar = { cookie: string };
const jar: Jar = { cookie: "" };

async function call<T>(path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = {};
  const cookie = init.cookie ?? jar.cookie;
  if (cookie) headers.cookie = cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}/api${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    const pair = setCookie.split(";")[0];
    if (pair) jar.cookie = pair;
  }
  const text = await res.text();
  let data: (T & { error?: { code?: string; message?: string } }) | null = null;
  try {
    data = JSON.parse(text) as T & { error?: { code?: string; message?: string } };
  } catch {
    data = null;
  }
  return { status: res.status, data, text };
}

console.log(`Target: ${base}`);

const health = await call<{ ok: boolean; artifacts: string; turnstile: boolean }>("/health");
check("health reaches D1 and Artifacts", health.status === 200 && health.data?.ok === true && health.data.artifacts === "ok", health.data);
check("turnstile secret is configured for this process", health.data?.turnstile === true, health.data);

const session = await call<SessionPayload>("/session");
check("session sets a visitor cookie and a site key", session.status === 200 && Boolean(jar.cookie) && Boolean(session.data?.siteKey), {
  cookie: Boolean(jar.cookie),
  siteKey: session.data?.siteKey,
});

const rejected = await call("/tasks", { method: "POST", body: { title: "no check" } });
check("missing turnstile token is rejected", rejected.status === 400 && rejected.data?.error?.code === "turnstile_required", rejected.data);

const created = await call<{ id: string; remote: string; seed: string }>("/tasks", {
  method: "POST",
  body: { title: "Smoke greeting", turnstileToken: DUMMY },
});
check("create seeds an Artifacts repo", created.status === 201 && created.data?.id.startsWith("task-") && created.data.remote.includes("artifacts.cloudflare.net"), {
  status: created.status,
  id: created.data?.id,
  remote: created.data?.remote,
  error: created.data?.error,
});

const taskId = created.data?.id;
if (!taskId) {
  console.error(`\n${failures} check(s) failed. Create did not return a task.`);
  process.exit(1);
}

const detail = await call<TaskDetail>(`/tasks/${taskId}`);
check("commit log contains the seed", detail.status === 200 && (detail.data?.commits.length ?? 0) >= 1 && detail.data?.commits.some((commit) => commit.message.includes("Seed")), {
  status: detail.status,
  commits: detail.data?.commits.map((commit) => commit.message),
});

const seed = detail.data?.commits.find((commit) => commit.message.includes("Seed"));
if (seed) {
  const diff = await call<CommitDetail>(`/tasks/${taskId}/commits/${seed.hash}`);
  const readme = diff.data?.files.find((file) => file.path === "README.md");
  check("seed diff shows README.md added", diff.status === 200 && readme?.status === "added" && readme.patch.includes("Smoke greeting"), {
    status: diff.status,
    paths: diff.data?.files.map((file) => file.path),
  });
}

const stranger = await call<TaskDetail>(`/tasks/${taskId}`, { cookie: "rpa_vid=0123456789abcdef0123456789abcdef" });
check("another visitor cannot read the task", stranger.status === 404, stranger.status);

const run = await call<RunResult>(`/tasks/${taskId}/run`, {
  method: "POST",
  body: {
    instruction: "Add a reverse function to src/task.ts that returns the characters of the input backwards. Mention the function in NOTES.md is not required. Only change src/task.ts.",
    turnstileToken: DUMMY,
  },
});
check("agent run pushes a Workers AI commit", run.status === 200 && /^[0-9a-f]{40}$/.test(run.data?.hash ?? "") && run.data?.path === "src/task.ts", run.data);

if (run.data?.hash) {
  const again = await call<TaskDetail>(`/tasks/${taskId}`);
  const diff = await call<CommitDetail>(`/tasks/${taskId}/commits/${run.data.hash}`);
  const file = diff.data?.files.find((item) => item.path === "src/task.ts");
  check("run commit is on main and changes src/task.ts", again.data?.commits.some((commit) => commit.hash === run.data?.hash) && file?.status === "modified", {
    messages: again.data?.commits.map((commit) => commit.message),
    status: file?.status,
  });
}

const token = await call<CloneToken>(`/tasks/${taskId}/token`, { method: "POST", body: {} });
check("read token is art_ scoped and the remote matches", token.status === 200 && token.data?.token.startsWith("art_") && token.data.remote === created.data?.remote && token.data.ttlSeconds === 600, {
  status: token.status,
  prefix: token.data?.token.slice(0, 6),
  ttl: token.data?.ttlSeconds,
});

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
