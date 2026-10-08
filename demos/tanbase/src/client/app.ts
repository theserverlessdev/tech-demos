import { COLUMNS, SPLIT_STEPS, type BoardMeta, type BoardSnapshot, type ColumnId, type ServerEvent, type SessionPayload, type SplitRun, type Task } from "../shared/types";

const COLUMN_LABEL: Record<ColumnId, string> = { todo: "To do", doing: "Doing", done: "Done" };
const STEP_LABEL: Record<string, string> = {
  "load task": "Load the task",
  "ask workers ai": "Ask Workers AI",
  "write subtasks": "Write the subtasks",
};

type TurnstileApi = {
  render: (el: HTMLElement, opts: { sitekey: string; action?: string; theme?: "dark" | "light" }) => string;
  getResponse: (widgetId?: string) => string | undefined;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

function requireEl(id: string): HTMLElement {
  const node = document.querySelector(id);
  if (!(node instanceof HTMLElement)) throw new Error(`missing ${id}`);
  return node;
}

const rootEl = requireEl("#app");
const stripText = requireEl("#strip-text");
const stripDot = requireEl("#strip-dot");

let siteKey = "";
let boards: BoardMeta[] = [];
let board: BoardSnapshot | null = null;
let selectedId: string | null = null;
let peers = 0;
let connected = false;
let socket: WebSocket | null = null;
let reconnectAt = 0;
let splitTimer = 0;
let watching: string | null = null;
let editing = false;
let createWidget: string | null = null;
let actionWidget: string | null = null;
let dragId: string | null = null;

function root(): string {
  const marker = "/demos/tanbase";
  const at = location.pathname.indexOf(marker);
  return at === -1 ? "" : location.pathname.slice(0, at + marker.length);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | null> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

async function api<T>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<{ ok: boolean; status: number; data: T | null; error: string }> {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`${root()}${path}`, { method: init.method ?? "GET", headers, body, credentials: "same-origin" });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const message = parsed && typeof parsed === "object" && parsed !== null && "error" in parsed
    ? String((parsed as { error?: { message?: string } }).error?.message ?? "Request failed.")
    : "";
  return { ok: res.ok, status: res.status, data: res.ok ? (parsed as T) : null, error: res.ok ? "" : message || "Request failed." };
}

function setStrip(text: string): void {
  stripText.textContent = text;
  stripDot.classList.toggle("is-live", connected && Boolean(board));
}

function setHint(text: string): void {
  const hint = document.querySelector("#hint");
  if (hint) hint.textContent = text;
}

function liveLine(): string {
  if (!board) return "A board is yours for 7 days, then the cron deletes it and its files.";
  if (!connected) return "Reconnecting to the board…";
  const views = peers === 1 ? "1 view" : `${peers} views`;
  return `${views} live. Open this board in another tab and the cards move together.`;
}

function whenTurnstile(run: () => void): void {
  if (window.turnstile) {
    run();
    return;
  }
  const timer = window.setInterval(() => {
    if (!window.turnstile) return;
    window.clearInterval(timer);
    run();
  }, 200);
}

function mountWidget(node: HTMLElement, action: string): string | null {
  if (!window.turnstile || !siteKey || node.dataset.widget) return node.dataset.widget ?? null;
  const widget = window.turnstile.render(node, {
    sitekey: siteKey,
    action,
    theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
  });
  node.dataset.widget = widget;
  return widget;
}

function tokenOf(widget: string | null): string {
  if (!widget || !window.turnstile) return "";
  return window.turnstile.getResponse(widget) ?? "";
}

function resetWidget(widget: string | null): void {
  if (widget) window.turnstile?.reset(widget);
}

function formatDue(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function dateInput(ms: number | null): string {
  if (!ms) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

function expiryLine(ms: number): string {
  const days = Math.max(0, Math.round((ms - Date.now()) / 86_400_000));
  if (days <= 0) return "Expires today";
  return days === 1 ? "Expires in 1 day" : `Expires in ${days} days`;
}

function taskById(id: string | null): Task | null {
  return board?.tasks.find((task) => task.id === id) ?? null;
}

function applySnapshot(snapshot: BoardSnapshot, rebuildDrawer = false): void {
  board = snapshot;
  const meta: BoardMeta = { id: snapshot.id, title: snapshot.title, createdAt: snapshot.createdAt, expiresAt: snapshot.expiresAt };
  boards = [meta, ...boards.filter((item) => item.id !== meta.id)];
  if (selectedId && !snapshot.tasks.some((task) => task.id === selectedId)) selectedId = null;
  renderWorkspace(rebuildDrawer);
  setStrip(liveLine());
}

async function refreshBoards(): Promise<void> {
  const session = await api<SessionPayload>("/api/session");
  if (!session.data) return;
  siteKey = session.data.siteKey;
  boards = session.data.boards;
}

async function openBoard(id: string): Promise<void> {
  const res = await api<BoardSnapshot>(`/api/boards/${id}`);
  if (!res.data) {
    setStrip(res.error);
    renderEmpty();
    return;
  }
  sessionStorage.setItem("tanbase-board", id);
  editing = false;
  selectedId = null;
  applySnapshot(res.data, true);
  connect();
}

function connect(): void {
  if (!board) return;
  window.clearTimeout(reconnectAt);
  socket?.close();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}${root()}/api/boards/${board.id}/live`);
  socket = ws;
  const boardId = board.id;
  ws.addEventListener("open", () => {
    if (socket !== ws) return;
    connected = true;
    setStrip(liveLine());
  });
  ws.addEventListener("close", () => {
    if (socket !== ws) return;
    connected = false;
    setStrip(liveLine());
    reconnectAt = window.setTimeout(() => {
      if (board?.id === boardId) connect();
    }, 1200);
  });
  ws.addEventListener("message", (event) => {
    if (socket !== ws) return;
    let message: ServerEvent;
    try {
      message = JSON.parse(String(event.data)) as ServerEvent;
    } catch {
      return;
    }
    if (message.type === "snapshot") {
      peers = message.peers;
      applySnapshot(message.board);
    } else if (message.type === "peers") {
      peers = message.peers;
      setStrip(liveLine());
    } else if (message.type === "expired") {
      connected = false;
      board = null;
      setStrip("That board has expired.");
      void refreshBoards().then(() => renderEmpty());
    } else {
      setHint(message.message);
    }
  });
}

async function createBoard(title: string, widget: string | null): Promise<void> {
  const turnstileToken = tokenOf(widget);
  if (!turnstileToken) {
    setHint("Complete the Turnstile check, then create the board.");
    return;
  }
  const res = await api<{ board: BoardMeta }>("/api/boards", { method: "POST", body: { title, turnstileToken } });
  resetWidget(widget);
  if (!res.data) {
    setHint(res.error);
    setStrip(res.error);
    return;
  }
  boards = [res.data.board, ...boards.filter((item) => item.id !== res.data?.board.id)];
  await openBoard(res.data.board.id);
}

async function saveTask(task: Task, patch: { title?: string; description?: string; dueAt?: string | null; column?: ColumnId }): Promise<void> {
  if (!board) return;
  const res = await api<BoardSnapshot>(`/api/boards/${board.id}/tasks/${task.id}`, { method: "PATCH", body: patch });
  editing = false;
  if (!res.data) {
    setHint(res.error);
    return;
  }
  setHint("");
  applySnapshot(res.data, true);
}

async function moveTask(taskId: string, column: ColumnId, index: number): Promise<void> {
  if (!board) return;
  const res = await api<BoardSnapshot>(`/api/boards/${board.id}/tasks/${taskId}`, { method: "PATCH", body: { column, index } });
  if (!res.data) {
    setHint(res.error);
    return;
  }
  applySnapshot(res.data);
}

async function addTask(title: string): Promise<void> {
  if (!board) return;
  const res = await api<BoardSnapshot>(`/api/boards/${board.id}/tasks`, { method: "POST", body: { title, column: "todo" } });
  if (!res.data) {
    setHint(res.error);
    return;
  }
  const created = res.data.tasks.find((task) => task.title === title && !board?.tasks.some((prev) => prev.id === task.id));
  if (created) selectedId = created.id;
  editing = false;
  applySnapshot(res.data, true);
}

function cardNode(task: Task): HTMLElement {
  const parent = task.parentId ? taskById(task.parentId) : null;
  const files = board?.attachments.filter((file) => file.taskId === task.id).length ?? 0;
  const overdue = task.overdue || (task.dueAt !== null && task.dueAt < Date.now() && task.column !== "done");
  const button = el("article", { class: `card${task.id === selectedId ? " is-selected" : ""}`, draggable: "true", tabindex: "0", role: "button" },
    el("h3", {}, task.title),
    task.description ? el("p", {}, task.description) : "",
    el("div", { class: "card__meta" },
      task.dueAt ? el("span", { class: overdue ? "chip chip-warn" : "chip" }, overdue ? `Overdue · ${formatDue(task.dueAt)}` : `Due ${formatDue(task.dueAt)}`) : "",
      parent ? el("span", { class: "chip chip-ember" }, `Subtask of ${parent.title}`) : "",
      files ? el("span", { class: "chip" }, files === 1 ? "1 file" : `${files} files`) : "",
    ),
  );
  button.addEventListener("dragstart", (event) => {
    dragId = task.id;
    button.classList.add("is-dragging");
    event.dataTransfer?.setData("text/plain", task.id);
  });
  button.addEventListener("dragend", () => {
    button.classList.remove("is-dragging");
    dragId = null;
  });
  const open = () => {
    selectedId = task.id;
    editing = false;
    renderWorkspace(true);
  };
  button.addEventListener("click", open);
  button.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });
  return button;
}

function fillColumns(): void {
  if (!board) return;
  for (const column of COLUMNS) {
    const list = document.querySelector(`[data-list="${column}"]`);
    const count = document.querySelector(`[data-count="${column}"]`);
    if (!(list instanceof HTMLElement) || !(count instanceof HTMLElement)) continue;
    const tasks = board.tasks.filter((task) => task.column === column).sort((a, b) => a.position - b.position);
    count.textContent = String(tasks.length);
    list.replaceChildren(...(tasks.length ? tasks.map((task) => el("li", {}, cardNode(task))) : [el("li", { class: "drop-hint" }, "Drop a card here")]));
  }
}

function renderSteps(): void {
  const list = document.querySelector("#steps");
  const note = document.querySelector("#split-note");
  if (!(list instanceof HTMLElement) || !(note instanceof HTMLElement) || !board || !selectedId) return;
  const run = [...board.splits].reverse().find((item) => item.taskId === selectedId) ?? null;
  const done = new Set(run?.steps.map((step) => step.name) ?? []);
  const active = run && run.status !== "complete" && run.status !== "errored"
    ? SPLIT_STEPS.find((name) => !done.has(name))
    : undefined;
  list.replaceChildren(...SPLIT_STEPS.map((name) => {
    const state = done.has(name) ? "is-done" : name === active ? "is-run" : "";
    return el("li", { class: state }, STEP_LABEL[name] ?? name);
  }));
  if (!run) note.textContent = "Split asks Workers AI for 3–6 subtasks. The three workflow steps show up here.";
  else if (run.status === "errored") note.textContent = run.error || "The split failed.";
  else if (run.source === "workers-ai") note.textContent = "Subtasks came from Workers AI.";
  else if (run.source === "fallback") note.textContent = "The model output was unusable, so the workflow wrote fallback subtasks.";
  else note.textContent = "Workflow is running.";
}

function renderDrawer(force: boolean): void {
  const drawer = document.querySelector("#drawer");
  if (!(drawer instanceof HTMLElement) || !board) return;
  const task = taskById(selectedId);
  if (!task) {
    editing = false;
    drawer.replaceChildren(el("h2", {}, "Card"), el("p", { class: "lede" }, "Select a card to edit it, attach a file, or split it into subtasks."));
    return;
  }
  if (editing && !force) {
    renderSteps();
    return;
  }
  const title = el("input", { id: "card-title", value: task.title, maxlength: "120" }) as HTMLInputElement;
  const description = el("textarea", { id: "card-description" }) as HTMLTextAreaElement;
  description.value = task.description;
  const due = el("input", { id: "card-due", type: "date", value: dateInput(task.dueAt) }) as HTMLInputElement;
  const column = el("select", { id: "card-column" }, ...COLUMNS.map((id) => el("option", { value: id, selected: id === task.column ? "selected" : null }, COLUMN_LABEL[id]))) as HTMLSelectElement;
  const mark = () => { editing = true; };
  title.addEventListener("input", mark);
  description.addEventListener("input", mark);
  due.addEventListener("input", mark);
  column.addEventListener("change", mark);

  const files = board.attachments.filter((file) => file.taskId === task.id);
  const reminders = board.reminders.filter((item) => item.taskId === task.id);
  const turnstile = el("div", { class: "turnstile", id: "action-turnstile" });

  drawer.replaceChildren(
    el("h2", {}, "Card"),
    el("label", { class: "field" }, "Title", title),
    el("label", { class: "field" }, "Description", description),
    el("label", { class: "field" }, "Due date", due),
    el("label", { class: "field" }, "Column", column),
    el("div", { class: "row" },
      el("button", { class: "btn-primary", id: "save-card", type: "button" }, "Save"),
      el("button", { class: "btn-danger btn-ghost", id: "delete-card", type: "button" }, "Delete"),
    ),
    reminders.length ? el("p", { class: "lede" }, reminders[reminders.length - 1]?.message ?? "") : "",
    el("h2", {}, "Files"),
    el("ul", { class: "files" }, ...files.map((file) => el("li", {}, el("a", { href: `${root()}/api/boards/${board?.id}/attachments/${file.id}` }, file.filename)))),
    el("form", { id: "upload-form", class: "field" },
      el("span", {}, "Attach a PNG, JPEG, WEBP, GIF, PDF, or text file up to 256 KB"),
      el("input", { id: "file", type: "file" }),
      turnstile,
      el("button", { class: "btn", type: "submit" }, "Upload"),
    ),
    el("h2", {}, "Split into subtasks"),
    el("p", { class: "lede", id: "split-note" }, ""),
    el("ol", { class: "steps", id: "steps" }),
    el("button", { class: "btn", id: "split", type: "button" }, "Split with Workers AI"),
    el("p", { class: "hint", id: "hint" }, ""),
  );
  drawer.querySelector("#save-card")?.addEventListener("click", () => {
    void saveTask(task, {
      title: title.value,
      description: description.value,
      dueAt: due.value || null,
      column: column.value as ColumnId,
    });
  });
  drawer.querySelector("#delete-card")?.addEventListener("click", () => {
    if (!board) return;
    void api<BoardSnapshot>(`/api/boards/${board.id}/tasks/${task.id}`, { method: "DELETE" }).then((res) => {
      if (!res.data) setHint(res.error);
      else {
        selectedId = null;
        applySnapshot(res.data, true);
      }
    });
  });
  drawer.querySelector("#upload-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void uploadFile(task.id);
  });
  drawer.querySelector("#split")?.addEventListener("click", () => { void splitTask(task.id); });
  whenTurnstile(() => { actionWidget = mountWidget(turnstile, "board-write"); });
  renderSteps();
}

async function uploadFile(taskId: string): Promise<void> {
  if (!board) return;
  const input = document.querySelector("#file");
  const file = input instanceof HTMLInputElement ? input.files?.[0] : undefined;
  if (!file) {
    setHint("Choose a file first.");
    return;
  }
  const turnstileToken = tokenOf(actionWidget);
  if (!turnstileToken) {
    setHint("Complete the Turnstile check, then upload.");
    return;
  }
  const form = new FormData();
  form.set("file", file);
  form.set("turnstileToken", turnstileToken);
  const res = await api<BoardSnapshot>(`/api/boards/${board.id}/tasks/${taskId}/attachments`, { method: "POST", form });
  resetWidget(actionWidget);
  if (!res.data) {
    setHint(res.error);
    return;
  }
  setHint("");
  editing = false;
  applySnapshot(res.data, true);
}

async function splitTask(taskId: string): Promise<void> {
  if (!board) return;
  const turnstileToken = tokenOf(actionWidget);
  if (!turnstileToken) {
    setHint("Complete the Turnstile check, then split.");
    return;
  }
  const res = await api<{ split: SplitRun }>(`/api/boards/${board.id}/tasks/${taskId}/split`, { method: "POST", body: { turnstileToken } });
  resetWidget(actionWidget);
  if (!res.data) {
    setHint(res.error);
    return;
  }
  watching = res.data.split.id;
  board.splits = [...board.splits.filter((item) => item.id !== res.data?.split.id), res.data.split];
  renderSteps();
  pollSplit();
}

function pollSplit(): void {
  window.clearTimeout(splitTimer);
  if (!watching || !board) return;
  const boardId = board.id;
  const splitId = watching;
  splitTimer = window.setTimeout(() => {
    void (async () => {
      const res = await api<{ split: SplitRun }>(`/api/boards/${boardId}/splits/${splitId}`);
      if (!board || board.id !== boardId) return;
      if (res.data) {
        board.splits = [...board.splits.filter((item) => item.id !== res.data?.split.id), res.data.split];
        renderSteps();
        if (res.data.split.status === "complete" || res.data.split.status === "errored") {
          watching = null;
          const again = await api<BoardSnapshot>(`/api/boards/${boardId}`);
          if (again.data) applySnapshot(again.data, true);
          return;
        }
      }
      pollSplit();
    })();
  }, 700);
}

function bindDrops(): void {
  for (const column of COLUMNS) {
    const section = document.querySelector(`[data-column="${column}"]`);
    if (!(section instanceof HTMLElement) || section.dataset.bound) continue;
    section.dataset.bound = "1";
    section.addEventListener("dragover", (event) => {
      event.preventDefault();
      section.classList.add("is-over");
    });
    section.addEventListener("dragleave", () => section.classList.remove("is-over"));
    section.addEventListener("drop", (event) => {
      event.preventDefault();
      section.classList.remove("is-over");
      const taskId = dragId || event.dataTransfer?.getData("text/plain");
      if (!taskId || !board) return;
      const cards = [...section.querySelectorAll(".card")].filter((card) => card.getAttribute("draggable") === "true" && card !== document.querySelector(".is-dragging"));
      let index = cards.length;
      for (let i = 0; i < cards.length; i++) {
        const box = cards[i]?.getBoundingClientRect();
        if (box && event.clientY < box.top + box.height / 2) {
          index = i;
          break;
        }
      }
      void moveTask(taskId, column, index);
    });
  }
}

function renderWorkspace(rebuildDrawer: boolean): void {
  if (!board) return;
  let workspace = document.querySelector("#workspace");
  if (!(workspace instanceof HTMLElement)) {
    createWidget = null;
    actionWidget = null;
    workspace = el("div", { class: "workspace", id: "workspace" });
    const bar = el("div", { class: "board-bar" });
    const switcher = el("select", { id: "switcher" }) as HTMLSelectElement;
    const title = el("input", { class: "title-input", id: "board-title", maxlength: "120" }) as HTMLInputElement;
    bar.append(
      el("label", {}, "Board", switcher),
      el("label", {}, "Name", title),
      el("button", { class: "btn", id: "new-board", type: "button" }, "New board"),
      el("button", { class: "btn btn-ghost", id: "delete-board", type: "button" }, "Delete"),
      el("span", { class: "expiry", id: "expiry" }, ""),
    );
    const columns = el("div", { class: "columns" });
    for (const column of COLUMNS) {
      const section = el("section", { class: "column", "data-column": column });
      section.append(el("header", {}, el("h2", {}, COLUMN_LABEL[column]), el("span", { class: "count", "data-count": column }, "0")));
      if (column === "todo") {
        const form = el("form", { class: "adder", id: "adder" },
          el("input", { id: "new-task", placeholder: "Add a card", maxlength: "120", "aria-label": "New card title" }),
          el("button", { class: "btn-primary", type: "submit" }, "Add"),
        );
        section.append(form);
      }
      section.append(el("ul", { class: "cards", "data-list": column }));
      columns.append(section);
    }
    const layout = el("div", { class: "layout" }, columns, el("aside", { class: "drawer", id: "drawer" }));
    const dialog = el("dialog", { id: "create-dialog" },
      el("form", { id: "create-form", class: "empty" },
        el("h2", {}, "New board"),
        el("label", { class: "field" }, "Name", el("input", { id: "create-title", value: "Launch checklist", maxlength: "120", required: "required" })),
        el("div", { class: "turnstile", id: "dialog-turnstile" }),
        el("div", { class: "row" },
          el("button", { class: "btn-primary", type: "submit" }, "Create board"),
          el("button", { class: "btn btn-ghost", id: "create-cancel", type: "button" }, "Cancel"),
        ),
        el("p", { class: "hint", id: "create-hint" }, ""),
      ),
    );
    workspace.append(bar, layout, dialog);
    rootEl.replaceChildren(workspace);
    switcher.addEventListener("change", () => { void openBoard(switcher.value); });
    title.addEventListener("change", () => {
      if (!board) return;
      void api<BoardSnapshot>(`/api/boards/${board.id}`, { method: "PATCH", body: { title: title.value } }).then((res) => {
        if (!res.data) setHint(res.error);
        else applySnapshot(res.data);
      });
    });
    workspace.querySelector("#new-board")?.addEventListener("click", () => {
      const dialogEl = document.querySelector("#create-dialog");
      if (dialogEl instanceof HTMLDialogElement) {
        dialogEl.showModal();
        whenTurnstile(() => {
          const node = document.querySelector("#dialog-turnstile");
          if (node instanceof HTMLElement) createWidget = mountWidget(node, "create-board");
        });
      }
    });
    workspace.querySelector("#create-cancel")?.addEventListener("click", () => {
      const dialogEl = document.querySelector("#create-dialog");
      if (dialogEl instanceof HTMLDialogElement) dialogEl.close();
    });
    workspace.querySelector("#create-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = document.querySelector("#create-title");
      const titleValue = input instanceof HTMLInputElement ? input.value : "";
      void createBoard(titleValue, createWidget);
    });
    workspace.querySelector("#delete-board")?.addEventListener("click", () => {
      if (!board || !confirm("Delete this board and its files?")) return;
      void api(`/api/boards/${board.id}`, { method: "DELETE" }).then(async (res) => {
        if (!res.ok) setHint(res.error);
        else {
          boards = boards.filter((item) => item.id !== board?.id);
          board = null;
          socket?.close();
          await refreshBoards();
          const next = boards[0];
          if (next) await openBoard(next.id);
          else renderEmpty();
        }
      });
    });
    workspace.querySelector("#adder")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = document.querySelector("#new-task");
      if (!(input instanceof HTMLInputElement)) return;
      const titleValue = input.value.trim();
      if (!titleValue) return;
      input.value = "";
      void addTask(titleValue);
    });
    bindDrops();
  }

  const switcher = document.querySelector("#switcher");
  if (switcher instanceof HTMLSelectElement && document.activeElement !== switcher) {
    switcher.replaceChildren(...boards.map((item) => el("option", { value: item.id, selected: item.id === board?.id ? "selected" : null }, item.title)));
  }
  const title = document.querySelector("#board-title");
  if (title instanceof HTMLInputElement && document.activeElement !== title) title.value = board.title;
  const expiry = document.querySelector("#expiry");
  if (expiry) expiry.textContent = expiryLine(board.expiresAt);
  fillColumns();
  renderDrawer(rebuildDrawer);
}

function renderEmpty(): void {
  socket?.close();
  socket = null;
  connected = false;
  createWidget = null;
  const form = el("form", { class: "empty", id: "empty-form" },
    el("p", { class: "lede" }, "Anonymous board"),
    el("h2", {}, "Start a board"),
    el("p", { class: "lede" }, "Cards live in D1. A Board Durable Object keeps every open tab in sync. The board expires after 7 days."),
    el("label", { class: "field" }, "Name", el("input", { id: "empty-title", value: "Launch checklist", maxlength: "120", required: "required" })),
    el("div", { class: "turnstile", id: "empty-turnstile" }),
    el("button", { class: "btn-primary", type: "submit" }, "Create board"),
    el("p", { class: "hint", id: "hint" }, ""),
  );
  rootEl.replaceChildren(form);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.querySelector("#empty-title");
    const title = input instanceof HTMLInputElement ? input.value : "";
    void createBoard(title, createWidget);
  });
  whenTurnstile(() => {
    const node = document.querySelector("#empty-turnstile");
    if (node instanceof HTMLElement) createWidget = mountWidget(node, "create-board");
  });
  setStrip(liveLine());
}

document.querySelector("#theme")?.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("tanbase-theme", next);
});

void (async () => {
  const session = await api<SessionPayload>("/api/session");
  if (!session.data) {
    setStrip(session.error);
    renderEmpty();
    return;
  }
  siteKey = session.data.siteKey;
  boards = session.data.boards;
  const saved = sessionStorage.getItem("tanbase-board");
  const pick = boards.find((item) => item.id === saved) ?? boards[0];
  if (pick) await openBoard(pick.id);
  else renderEmpty();
})();
