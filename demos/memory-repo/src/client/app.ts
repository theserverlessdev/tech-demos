import { escapeHtml, renderMarkdown } from "../shared/markdown";
import type { ChatMessage, ChatResult, CommitDetail, CommitSummary, DreamView, MemoryFile, SessionPayload, StatePayload } from "../shared/types";

const base = location.pathname.startsWith("/demos/memory-repo") ? "/demos/memory-repo" : "";

type ApiError = { error?: { code?: string; message?: string } };

const gate = document.querySelector<HTMLElement>("#gate")!;
const app = document.querySelector<HTMLElement>("#app")!;
const gateHint = document.querySelector<HTMLElement>("#gate-hint")!;
const openButton = document.querySelector<HTMLButtonElement>("#open-repo")!;
const turnstileHost = document.querySelector<HTMLElement>("#gate-turnstile")!;
const messagesEl = document.querySelector<HTMLElement>("#messages")!;
const composer = document.querySelector<HTMLFormElement>("#composer")!;
const messageInput = document.querySelector<HTMLTextAreaElement>("#message")!;
const sendButton = document.querySelector<HTMLButtonElement>("#send")!;
const chatHint = document.querySelector<HTMLElement>("#chat-hint")!;
const treeEl = document.querySelector<HTMLElement>("#tree")!;
const fileView = document.querySelector<HTMLElement>("#file-view")!;
const sourceToggle = document.querySelector<HTMLButtonElement>("#source-toggle")!;
const commitsEl = document.querySelector<HTMLElement>("#commits")!;
const diffMeta = document.querySelector<HTMLElement>("#diff-meta")!;
const diffCode = document.querySelector<HTMLElement>("#diff-code")!;
const dreamButton = document.querySelector<HTMLButtonElement>("#dream")!;
const dreamSteps = document.querySelector<HTMLOListElement>("#dream-steps")!;
const dreamHint = document.querySelector<HTMLElement>("#dream-hint")!;
const expiresEl = document.querySelector<HTMLElement>("#expires")!;
const stripText = document.querySelector<HTMLElement>("#strip-text")!;

let siteKey: string | null = null;
let turnstileId = "";
let turnstileToken = "";
let files: MemoryFile[] = [];
let selectedPath = "MEMORY.md";
let showSource = false;
let selectedHash = "";

function hint(el: HTMLElement, text: string, bad = false): void {
  el.textContent = text;
  el.classList.toggle("is-bad", bad && text.length > 0);
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: (T & ApiError) | null }> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}/api${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data: (T & ApiError) | null = null;
  try {
    data = text ? (JSON.parse(text) as T & ApiError) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

function showApp(ready: boolean): void {
  gate.hidden = ready;
  app.hidden = !ready;
}

function selectPane(name: string): void {
  document.querySelectorAll<HTMLElement>(".pane").forEach((pane) => {
    const on = pane.dataset.pane === name;
    pane.classList.toggle("is-active", on);
  });
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => {
    const on = tab.dataset.pane === name;
    tab.classList.toggle("is-active", on);
    tab.setAttribute("aria-selected", on ? "true" : "false");
  });
}

function renderPatch(patch: string): string {
  return patch
    .split("\n")
    .map((line) => {
      const safe = escapeHtml(line);
      if (line.startsWith("+") && !line.startsWith("+++")) return `<span class="add">${safe}</span>`;
      if (line.startsWith("-") && !line.startsWith("---")) return `<span class="del">${safe}</span>`;
      return `<span>${safe}</span>`;
    })
    .join("\n");
}

function renderMessages(messages: ChatMessage[]): void {
  messagesEl.replaceChildren();
  if (messages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Try a chip. A durable fact becomes a commit in the memory repo.";
    messagesEl.append(empty);
    return;
  }
  for (const message of messages) {
    const bubble = document.createElement("article");
    bubble.className = `bubble${message.role === "user" ? " bubble--user" : ""}`;
    const text = document.createElement("p");
    text.textContent = message.text;
    bubble.append(text);
    if (message.role === "assistant" && (message.recalled.length > 0 || message.commitHash)) {
      const meta = document.createElement("p");
      meta.className = "meta";
      const bits: string[] = [];
      if (message.recalled.length > 0) bits.push(`Recalled ${message.recalled.map((hit) => hit.path).join(", ")}`);
      if (message.commitHash) bits.push(`Commit ${message.commitHash.slice(0, 7)}${message.commitMessage ? ` · ${message.commitMessage}` : ""}`);
      meta.textContent = bits.join(" · ");
      bubble.append(meta);
    }
    messagesEl.append(bubble);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderFile(): void {
  const file = files.find((item) => item.path === selectedPath) ?? files[0];
  if (!file) {
    fileView.textContent = "No files yet.";
    return;
  }
  selectedPath = file.path;
  treeEl.querySelectorAll("button").forEach((button) => button.classList.toggle("is-active", button.dataset.path === file.path));
  if (showSource) {
    fileView.replaceChildren();
    const pre = document.createElement("pre");
    pre.className = "source";
    pre.textContent = file.body;
    fileView.append(pre);
    return;
  }
  fileView.innerHTML = renderMarkdown(file.body);
}

function renderTree(): void {
  treeEl.replaceChildren();
  for (const file of files) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.path = file.path;
    button.textContent = file.path;
    button.setAttribute("role", "treeitem");
    button.addEventListener("click", () => {
      selectedPath = file.path;
      renderFile();
    });
    treeEl.append(button);
  }
  renderFile();
}

function renderDream(dream: DreamView | null): void {
  if (!dream) {
    dreamSteps.hidden = true;
    dreamSteps.replaceChildren();
    return;
  }
  dreamSteps.hidden = false;
  dreamSteps.replaceChildren();
  for (const step of dream.steps) {
    const item = document.createElement("li");
    const strong = document.createElement("strong");
    strong.textContent = step.label;
    item.append(strong, document.createTextNode(` — ${step.detail}`));
    dreamSteps.append(item);
  }
  const summary = document.createElement("li");
  summary.textContent = dream.status === "committed" && dream.commitHash
    ? `Committed ${dream.commitHash.slice(0, 7)}. ${dream.reason}`
    : dream.reason;
  dreamSteps.append(summary);
}

function renderCommits(commits: CommitSummary[]): void {
  commitsEl.replaceChildren();
  if (commits.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No commits yet.";
    commitsEl.append(empty);
    return;
  }
  for (const commit of commits) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.classList.toggle("is-active", commit.hash === selectedHash);
    const msg = document.createElement("span");
    msg.className = "commit__msg";
    msg.textContent = commit.message || "(no message)";
    const meta = document.createElement("span");
    meta.className = "commit__meta";
    const stamp = commit.authoredAt > 1_000_000_000_000 ? commit.authoredAt : commit.authoredAt * 1000;
    const when = commit.authoredAt ? new Date(stamp).toLocaleString() : "";
    meta.textContent = `${commit.hash.slice(0, 7)} · ${commit.authorName}${when ? ` · ${when}` : ""}`;
    button.append(msg, meta);
    button.addEventListener("click", () => {
      void loadDiff(commit.hash);
    });
    item.append(button);
    commitsEl.append(item);
  }
}

function markCommit(hash: string): void {
  commitsEl.querySelectorAll("button").forEach((button) => {
    const meta = button.querySelector(".commit__meta")?.textContent ?? "";
    button.classList.toggle("is-active", meta.startsWith(hash.slice(0, 7)));
  });
}

async function loadDiff(hash: string): Promise<void> {
  selectedHash = hash;
  markCommit(hash);
  const result = await call<CommitDetail>(`/commits/${hash}`);
  if (result.status !== 200 || !result.data || result.data.error) {
    hint(dreamHint, result.data?.error?.message ?? "That diff could not be loaded.", true);
    return;
  }
  diffMeta.textContent = `${hash.slice(0, 7)} ${result.data.message}`;
  diffCode.innerHTML = result.data.files.length
    ? result.data.files.map((file) => renderPatch(file.patch)).join("\n")
    : escapeHtml("No text files changed.");
}

function applyState(state: StatePayload): void {
  files = state.files;
  renderMessages(state.messages);
  renderTree();
  renderCommits(state.commits);
  renderDream(state.dream);
  const when = new Date(state.expiresAt);
  expiresEl.textContent = `Deletes ${when.toLocaleString()}`;
  stripText.textContent = state.local
    ? `Local dev has no Artifacts login, so these commits stay in the Durable Object as git objects. They still delete 24 hours after the last message (${when.toLocaleString()}).`
    : `This browser's repo ${state.repoName} is deleted 24 hours after the last message (${when.toLocaleString()}). No account.`;
}

async function refresh(opts: { keepDiff?: boolean } = {}): Promise<void> {
  const result = await call<StatePayload>("/state");
  if (result.status !== 200 || !result.data || result.data.error || !result.data.files) {
    hint(chatHint, result.data?.error?.message ?? "The memory repo could not be loaded.", true);
    return;
  }
  const hash = opts.keepDiff ? selectedHash : "";
  applyState(result.data);
  if (hash) {
    selectedHash = hash;
    markCommit(hash);
  }
}

function mountTurnstile(): void {
  const widget = (window as unknown as { turnstile?: { render: (el: HTMLElement, opts: Record<string, unknown>) => string; reset: (id: string) => void } }).turnstile;
  if (!siteKey || !widget) return;
  if (turnstileId) return;
  turnstileId = widget.render(turnstileHost, {
    sitekey: siteKey,
    action: "create-repo",
    size: "flexible",
    theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
    callback: (token: string) => {
      turnstileToken = token;
      hint(gateHint, "");
    },
    "expired-callback": () => {
      turnstileToken = "";
    },
    "error-callback": () => {
      turnstileToken = "";
      hint(gateHint, "Turnstile could not load. Refresh and try again.", true);
    },
  });
}

async function boot(): Promise<void> {
  const session = await call<SessionPayload>("/session");
  if (!session.data) {
    hint(gateHint, "The demo could not be reached.", true);
    return;
  }
  siteKey = session.data.siteKey;
  if (session.data.ready) {
    showApp(true);
    await refresh();
    return;
  }
  showApp(false);
  if (!siteKey) {
    hint(gateHint, "The Turnstile site key is not set yet. Local .dev.vars supplies the test key.", true);
    openButton.disabled = true;
    return;
  }
  const start = () => mountTurnstile();
  if ((window as unknown as { turnstile?: unknown }).turnstile) start();
  else window.addEventListener("load", start);
  setTimeout(start, 400);
}

openButton.addEventListener("click", async () => {
  if (!turnstileToken) {
    hint(gateHint, "Complete the Turnstile check first.", true);
    return;
  }
  openButton.disabled = true;
  hint(gateHint, "Creating the memory repo…");
  const result = await call<SessionPayload>("/repo", { method: "POST", body: { turnstileToken } });
  openButton.disabled = false;
  if ((result.status !== 200 && result.status !== 201) || !result.data?.ready) {
    hint(gateHint, result.data?.error?.message ?? "The memory repo was not created.", true);
    turnstileToken = "";
    const widget = (window as unknown as { turnstile?: { reset: (id: string) => void } }).turnstile;
    if (widget && turnstileId) widget.reset(turnstileId);
    return;
  }
  hint(gateHint, "");
  showApp(true);
  await refresh();
});

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = messageInput.value.trim();
  if (!message) return;
  sendButton.disabled = true;
  hint(chatHint, "Writing…");
  const result = await call<ChatResult>("/chat", { method: "POST", body: { message } });
  sendButton.disabled = false;
  if (result.status !== 200 || !result.data || result.data.error) {
    hint(chatHint, result.data?.error?.message ?? "The message was not sent.", true);
    return;
  }
  messageInput.value = "";
  const note = result.data.committed && result.data.commitHash
    ? `Committed ${result.data.commitHash.slice(0, 7)}.`
    : result.data.fallback
      ? "Saved with the local fallback."
      : "";
  hint(chatHint, note);
  await refresh();
  if (result.data.committed) selectPane("history");
});

document.querySelectorAll<HTMLButtonElement>(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    messageInput.value = chip.dataset.seed ?? "";
    composer.requestSubmit();
  });
});

dreamButton.addEventListener("click", async () => {
  dreamButton.disabled = true;
  hint(dreamHint, "Dreaming…");
  selectPane("history");
  const result = await call<DreamView>("/dream", { method: "POST", body: {} });
  dreamButton.disabled = false;
  if (!result.data || result.data.error) {
    hint(dreamHint, result.data?.error?.message ?? "The dream failed.", true);
    return;
  }
  renderDream(result.data);
  hint(dreamHint, result.data.status === "committed" ? "Dream committed." : result.data.reason);
  await refresh({ keepDiff: true });
  if (result.data.commitHash) await loadDiff(result.data.commitHash);
});

sourceToggle.addEventListener("click", () => {
  showSource = !showSource;
  sourceToggle.setAttribute("aria-pressed", showSource ? "true" : "false");
  sourceToggle.textContent = showSource ? "Rendered" : "Source";
  renderFile();
});

fileView.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLAnchorElement)) return;
  const href = target.getAttribute("href") ?? "";
  if (!href.startsWith("#file-")) return;
  event.preventDefault();
  selectedPath = href.slice("#file-".length);
  showSource = false;
  sourceToggle.setAttribute("aria-pressed", "false");
  sourceToggle.textContent = "Source";
  renderFile();
});

document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => {
  tab.addEventListener("click", () => selectPane(tab.dataset.pane ?? "chat"));
});

const themeButton = document.querySelector<HTMLButtonElement>("#theme")!;
const stored = localStorage.getItem("memory-repo-theme");
if (stored === "light" || stored === "dark") document.documentElement.dataset.theme = stored;
themeButton.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("memory-repo-theme", next);
});

void boot();
