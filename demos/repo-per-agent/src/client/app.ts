import type { CloneToken, CommitDetail, CommitSummary, SessionPayload, TaskDetail, TaskSummary } from "../shared/types";

type ApiError = { error?: { message?: string; code?: string } };
type TurnstileApi = {
  render: (el: HTMLElement, opts: { sitekey: string; action: string; callback: (token: string) => void; "expired-callback"?: () => void }) => string;
  reset: (id: string) => void;
};

const $ = <T extends HTMLElement>(id: string) => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
};

const apiBase = new URL("./api/", window.location.href);

let session: SessionPayload | null = null;
let selected = "";
let commits: CommitSummary[] = [];
let createToken = "";
let runToken = "";
let createWidget = "";
let runWidget = "";
let revealed = false;

function turnstile(): TurnstileApi | null {
  const api = (window as Window & { turnstile?: TurnstileApi }).turnstile;
  return api?.render ? api : null;
}

async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(new URL(path.replace(/^\//, ""), apiBase), {
    method: init?.method ?? "GET",
    credentials: "same-origin",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json()) as T & ApiError;
  if (!res.ok) throw new Error(data.error?.message || `Request failed (${res.status})`);
  return data;
}

function hint(id: string, message: string, bad = false) {
  const node = $(id);
  node.textContent = message;
  node.classList.toggle("is-bad", bad);
}

function when(unix: number): string {
  const delta = unix - Date.now();
  const hours = Math.max(0, Math.round(delta / 3_600_000));
  if (delta <= 0) return "expired";
  if (hours < 1) return "under an hour left";
  return `${hours}h left`;
}

function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

function renderTasks() {
  const list = $("tasks");
  list.replaceChildren();
  const tasks = session?.tasks ?? [];
  $("task-count").textContent = String(tasks.length);
  $("tasks-empty").hidden = tasks.length > 0;
  for (const task of tasks) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `task${task.id === selected ? " is-on" : ""}`;
    const title = document.createElement("strong");
    title.textContent = task.title;
    const meta = document.createElement("span");
    meta.textContent = when(task.expiresAt);
    button.append(title, meta);
    button.addEventListener("click", () => void openTask(task.id));
    item.append(button);
    list.append(item);
  }
}

function renderCommits() {
  const list = $("commits");
  list.replaceChildren();
  for (const commit of commits) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "commit";
    const title = document.createElement("strong");
    title.textContent = commit.message || "Commit";
    const meta = document.createElement("span");
    meta.textContent = `${shortHash(commit.hash)} · ${commit.authorName}`;
    button.append(title, meta);
    button.addEventListener("click", () => void openCommit(commit.hash, button));
    item.append(button);
    list.append(item);
  }
}

function paintDiff(detail: CommitDetail) {
  $("diff-meta").textContent = detail.files.length ? `${shortHash(detail.hash)} · ${detail.files.length} file${detail.files.length === 1 ? "" : "s"}` : "No textual changes.";
  const code = $("diff-code");
  code.replaceChildren();
  for (const file of detail.files) {
    for (const line of file.patch.split("\n")) {
      const span = document.createElement("span");
      span.textContent = `${line}\n`;
      if (line.startsWith("+") && !line.startsWith("+++")) span.className = "add";
      else if (line.startsWith("-") && !line.startsWith("---")) span.className = "del";
      code.append(span);
    }
  }
}

async function openCommit(hash: string, button: HTMLButtonElement) {
  if (!selected) return;
  for (const node of document.querySelectorAll(".commit")) node.classList.remove("is-on");
  button.classList.add("is-on");
  const detail = await call<CommitDetail>(`/tasks/${selected}/commits/${hash}`);
  paintDiff(detail);
}

async function openTask(id: string) {
  selected = id;
  location.hash = id;
  renderTasks();
  const detail = await call<TaskDetail>(`/tasks/${id}`);
  commits = detail.commits;
  $("hero").hidden = true;
  $("detail").hidden = false;
  $("detail-id").textContent = detail.task.id;
  $("detail-title").textContent = detail.task.title;
  $("detail-expires").textContent = when(detail.task.expiresAt);
  $("detail-remote").textContent = detail.task.remote;
  $("token-box").hidden = true;
  renderCommits();
  const first = document.querySelector<HTMLButtonElement>(".commit");
  if (first && commits[0]) await openCommit(commits[0].hash, first);
  else {
    $("diff-meta").textContent = "No commits yet.";
    $("diff-code").replaceChildren();
  }
  mountRun();
}

function mountWidget(el: HTMLElement, action: string, onToken: (token: string) => void): string {
  const api = turnstile();
  const siteKey = session?.siteKey;
  if (!api || !siteKey) return "";
  el.replaceChildren();
  return api.render(el, {
    sitekey: siteKey,
    action,
    callback: onToken,
    "expired-callback": () => onToken(""),
  });
}

function mountCreate() {
  createToken = "";
  createWidget = mountWidget($("create-turnstile"), "create-task", (token) => {
    createToken = token;
  });
}

function mountRun() {
  runToken = "";
  runWidget = mountWidget($("run-turnstile"), "run-agent", (token) => {
    runToken = token;
  });
}

function resetWidget(id: string, remount: () => void) {
  const api = turnstile();
  if (api && id) api.reset(id);
  else remount();
}

async function boot() {
  const saved = localStorage.getItem("rpa-theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  session = await call<SessionPayload>("/session");
  const ttlHours = Math.round((session.ttlSeconds || 0) / 3600);
  $("strip-text").textContent = `Each task gets its own git repo. This browser can hold ${session.maxTasks} live repos. They expire after ${ttlHours} hours.`;
  renderTasks();
  mountCreate();
  const hash = location.hash.replace("#", "");
  if (session.tasks.some((task: TaskSummary) => task.id === hash)) await openTask(hash);
}

$("theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("rpa-theme", next);
});

$("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = $<HTMLInputElement>("title").value.trim();
  const button = $<HTMLButtonElement>("create-btn");
  button.disabled = true;
  hint("create-hint", "Creating the repository…");
  try {
    const created = await call<TaskSummary & { id: string }>("/tasks", {
      method: "POST",
      body: { title, turnstileToken: createToken },
    });
    session = await call<SessionPayload>("/session");
    renderTasks();
    hint("create-hint", "Repository seeded.");
    $<HTMLInputElement>("title").value = "";
    await openTask(created.id);
  } catch (err) {
    hint("create-hint", err instanceof Error ? err.message : "Create failed.", true);
  } finally {
    button.disabled = false;
    createToken = "";
    resetWidget(createWidget, mountCreate);
  }
});

$("run-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selected) return;
  const instruction = $<HTMLTextAreaElement>("instruction").value.trim();
  const button = $<HTMLButtonElement>("run-btn");
  button.disabled = true;
  hint("run-hint", "The agent is asking Workers AI and pushing a commit…");
  try {
    const result = await call<{ hash: string; message: string; path: string }>(`/tasks/${selected}/run`, {
      method: "POST",
      body: { instruction, turnstileToken: runToken },
    });
    hint("run-hint", `Committed ${shortHash(result.hash)} on ${result.path}.`);
    $<HTMLTextAreaElement>("instruction").value = "";
    await openTask(selected);
  } catch (err) {
    hint("run-hint", err instanceof Error ? err.message : "Run failed.", true);
  } finally {
    button.disabled = false;
    runToken = "";
    resetWidget(runWidget, mountRun);
  }
});

$("token-btn").addEventListener("click", async () => {
  if (!selected) return;
  hint("run-hint", "Minting a read token…");
  try {
    const minted = await call<CloneToken>(`/tasks/${selected}/token`, { method: "POST", body: {} });
    const command = `git -c http.extraHeader="Authorization: Bearer ${minted.token}" clone ${minted.remote}`;
    const input = $<HTMLInputElement>("token-command");
    input.value = command;
    input.type = "password";
    revealed = false;
    $("token-reveal").textContent = "Show token";
    $("token-box").hidden = false;
    hint("run-hint", "Read token ready for 10 minutes.");
  } catch (err) {
    hint("run-hint", err instanceof Error ? err.message : "Token failed.", true);
  }
});

$("token-reveal").addEventListener("click", () => {
  const input = $<HTMLInputElement>("token-command");
  revealed = !revealed;
  input.type = revealed ? "text" : "password";
  $("token-reveal").textContent = revealed ? "Hide token" : "Show token";
});

void boot().catch((err: unknown) => {
  hint("create-hint", err instanceof Error ? err.message : "Could not load the session.", true);
});
