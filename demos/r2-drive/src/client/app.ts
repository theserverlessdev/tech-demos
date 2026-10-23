import type { Caps, LogEvent, MintedDrive, PublicLock, SessionView } from "../shared/types";

type Config = {
  siteKey: string;
  mintEnabled: boolean;
  aup: string;
  caps: Caps;
};

type Entry = { href: string; name: string; collection: boolean; size: number };

declare global {
  interface Window {
    __turnstileReady?: Promise<void>;
    turnstile?: {
      render: (el: HTMLElement, opts: { sitekey: string; callback: (token: string) => void }) => string;
    };
  }
}

const state: {
  config: Config | null;
  drive: MintedDrive | null;
  cwd: string;
  mintToken: string;
  reportToken: string;
  socket: WebSocket | null;
} = { config: null, drive: null, cwd: "", mintToken: "", reportToken: "", socket: null };

const $ = <T extends HTMLElement>(id: string) => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
};

function basePath(): string {
  const path = location.pathname;
  const marker = "/demos/r2-drive";
  if (path === marker || path.startsWith(`${marker}/`)) return marker;
  return "";
}

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(`${basePath()}${path}`, init);
  const body = (await response.json()) as T;
  return { status: response.status, body };
}

function note(id: string, message: string, kind: "ok" | "bad" | "" = "") {
  const node = $(id);
  node.textContent = message;
  node.dataset.kind = kind;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function davRoot(): string {
  return `${location.origin}${basePath()}/dav/${state.drive?.driveId ?? ""}`;
}

async function loadConfig() {
  const { body } = await api<Config>("/api/config");
  state.config = body;
  $("aup-text").textContent = body.aup;
  const strip = $("strip");
  strip.textContent = body.mintEnabled
    ? `Minting is on. ${formatBytes(body.caps.maxFileBytes)} per file, ${formatBytes(body.caps.maxDriveBytes)} per drive, ${body.caps.maxFiles} files, one hour.`
    : "Minting is off.";
  $<HTMLButtonElement>("mint-button").disabled = !body.mintEnabled;
  await renderTurnstile("turnstile", body.siteKey, (token) => {
    state.mintToken = token;
  });
  await renderTurnstile("report-turnstile", body.siteKey, (token) => {
    state.reportToken = token;
  });
}

async function renderTurnstile(id: string, siteKey: string, onToken: (token: string) => void) {
  if (!siteKey) return;
  await window.__turnstileReady;
  const widget = window.turnstile;
  const host = $(id);
  if (!widget || host.childElementCount > 0) return;
  widget.render(host, { sitekey: siteKey, callback: onToken });
}

async function mint(event: SubmitEvent) {
  event.preventDefault();
  const email = $<HTMLInputElement>("email").value;
  const aup = $<HTMLInputElement>("aup").checked;
  if (!aup) {
    note("mint-note", "Accept the notice to continue.", "bad");
    return;
  }
  note("mint-note", "Sending the link…");
  const { status, body } = await api<{ error?: { message: string } }>("/api/mint", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, aup: true, turnstileToken: state.mintToken }),
  });
  if (status !== 200) {
    note("mint-note", body.error?.message ?? "The link could not be sent.", "bad");
    return;
  }
  note("mint-note", "Check your inbox. The link works once.", "ok");
  await probeDevbox();
}

async function probeDevbox() {
  const response = await fetch(`${basePath()}/api/dev/outbox`);
  $<HTMLElement>("devbox").hidden = response.status !== 200;
}

async function useDevbox() {
  const response = await fetch(`${basePath()}/api/dev/outbox`);
  if (!response.ok) return;
  const body = (await response.json()) as { token: string | null };
  if (body.token) await verify(body.token);
}

async function verify(token: string) {
  note("mint-note", "Opening the drive…");
  const { status, body } = await api<MintedDrive & { error?: { message: string } }>("/api/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (status !== 200) {
    note("mint-note", body.error?.message ?? "That link is invalid or expired.", "bad");
    return;
  }
  sessionStorage.setItem("r2drive-password", JSON.stringify({ driveId: body.driveId, password: body.password, mountPath: body.mountPath, expiresAt: body.expiresAt }));
  state.drive = body;
  note("mint-note", "Drive ready.", "ok");
  showDrive(body.password);
}

function savedPassword(driveId: string): string {
  const raw = sessionStorage.getItem("r2drive-password");
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { driveId?: string; password?: string };
    return parsed.driveId === driveId ? parsed.password ?? "" : "";
  } catch {
    return "";
  }
}

async function restoreSession() {
  const response = await fetch(`${basePath()}/api/session`);
  if (!response.ok) return;
  const session = (await response.json()) as SessionView;
  const password = savedPassword(session.driveId);
  state.drive = {
    driveId: session.driveId,
    username: session.driveId,
    password,
    expiresAt: session.expiresAt,
    mountPath: `${basePath()}/dav/${session.driveId}/`,
    caps: session.caps,
  };
  showDrive(password);
}

function showDrive(password: string) {
  if (!state.drive) return;
  $<HTMLElement>("drive-panel").hidden = false;
  $("drive-id").textContent = state.drive.driveId;
  $("expires").textContent = `Expires ${new Date(state.drive.expiresAt).toLocaleString()}. Files are readable only with this credential.`;
  const secret = $<HTMLElement>("secret");
  secret.hidden = password.length === 0;
  $<HTMLInputElement>("password").value = password;
  $<HTMLInputElement>("report-drive").value = state.drive.driveId;
  renderSnippets(password);
  void refresh();
  connectLog();
}

function renderSnippets(password: string) {
  const root = davRoot();
  const id = state.drive?.driveId ?? "";
  const pass = password || "<password shown once>";
  const blocks = [
    ["macOS Finder", `Server address:\n${root}/\nUsername: ${id}\nPassword: ${pass}`],
    ["Windows Explorer", `net use * ${root}/ /user:${id} ${pass}`],
    ["rclone", `[r2drive]\ntype = webdav\nurl = ${root}/\nvendor = other\nuser = ${id}\npass = ${pass}`],
    ["Obsidian Remotely Save", `WebDAV URL: ${root}/\nUsername: ${id}\nPassword: ${pass}`],
  ];
  $("snippets").replaceChildren(
    ...blocks.map(([title, text]) => {
      const wrap = document.createElement("details");
      wrap.open = true;
      const summary = document.createElement("summary");
      summary.textContent = title ?? "";
      const pre = document.createElement("pre");
      pre.textContent = text ?? "";
      wrap.append(summary, pre);
      return wrap;
    }),
  );
}

async function dav(method: string, key: string, init: RequestInit = {}) {
  const path = key ? `/${key.split("/").map(encodeURIComponent).join("/")}` : "/";
  return fetch(`${davRoot()}${path}`, { ...init, method });
}

async function refresh() {
  if (!state.drive) return;
  const response = await dav("PROPFIND", state.cwd, { headers: { Depth: "1" } });
  const xml = new DOMParser().parseFromString(await response.text(), "application/xml");
  const entries: Entry[] = [];
  for (const node of xml.getElementsByTagNameNS("DAV:", "response")) {
    const href = node.getElementsByTagNameNS("DAV:", "href")[0]?.textContent ?? "";
    const name = decodeURIComponent(href.replace(/\/$/, "").split("/").pop() ?? "");
    const collection = node.getElementsByTagNameNS("DAV:", "collection").length > 0;
    const size = Number(node.getElementsByTagNameNS("DAV:", "getcontentlength")[0]?.textContent ?? "0");
    const current = state.cwd ? `${state.cwd}/` : "";
    if (!name || href.endsWith(`${basePath()}/dav/${state.drive.driveId}/${current}`)) continue;
    if (collection && name === state.cwd.split("/").pop()) continue;
    entries.push({ href, name, collection, size });
  }
  const list = $("files");
  list.replaceChildren(
    ...entries.map((entry) => {
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.className = "file-name";
      label.textContent = entry.collection ? `${entry.name}/` : `${entry.name} · ${formatBytes(entry.size)}`;
      const actions = document.createElement("span");
      actions.className = "file-actions";
      if (entry.collection) actions.append(action("Open", () => openFolder(entry.name)));
      else actions.append(action("Preview", () => preview(entry.name)));
      actions.append(action("Rename", () => rename(entry)), action("Delete", () => remove(entry)));
      item.append(label, actions);
      return item;
    }),
  );
  $("empty").hidden = entries.length > 0;
  $("cwd").textContent = `/${state.cwd}`;
  const session = await api<SessionView>("/api/session");
  if (session.status === 200) {
    const count = session.body.fileCount;
    $("usage").textContent = `${formatBytes(session.body.bytesUsed)} · ${count} ${count === 1 ? "file" : "files"}`;
  }
  await refreshLocks();
}

function action(label: string, run: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "btn";
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", run);
  return button;
}

function childKey(name: string): string {
  return state.cwd ? `${state.cwd}/${name}` : name;
}

function openFolder(name: string) {
  state.cwd = childKey(name);
  void refresh();
}

async function preview(name: string) {
  const response = await dav("GET", childKey(name));
  const type = response.headers.get("content-type") ?? "";
  const frame = $<HTMLIFrameElement>("preview-frame");
  const pre = $("preview");
  if (type.includes("pdf")) {
    const blob = new Blob([await response.arrayBuffer()], { type: "application/pdf" });
    frame.hidden = false;
    pre.hidden = true;
    frame.src = URL.createObjectURL(blob);
    return;
  }
  frame.hidden = true;
  pre.hidden = false;
  pre.textContent = await response.text();
}

async function rename(entry: Entry) {
  const next = prompt("New name", entry.name);
  if (!next || next === entry.name || next.includes("/") || next.includes("..")) return;
  const destination = `${davRoot()}/${childKey(next).split("/").map(encodeURIComponent).join("/")}`;
  await dav("MOVE", childKey(entry.name), { headers: { Destination: destination, Overwrite: "T" } });
  await refresh();
}

async function remove(entry: Entry) {
  await dav("DELETE", childKey(entry.name));
  await refresh();
}

async function createFolder(event: SubmitEvent) {
  event.preventDefault();
  const name = $<HTMLInputElement>("folder-name").value.trim();
  if (!name || name.includes("/") || name.includes("..")) return;
  await dav("MKCOL", childKey(name));
  $<HTMLFormElement>("mkdir-form").reset();
  await refresh();
}

async function upload(event: SubmitEvent) {
  event.preventDefault();
  const input = $<HTMLInputElement>("file");
  for (const file of input.files ?? []) {
    const response = await dav("PUT", childKey(file.name), { body: await file.arrayBuffer() });
    if (!response.ok) {
      note("strip", `${file.name} was rejected (${response.status}).`, "bad");
    }
  }
  $<HTMLFormElement>("upload-form").reset();
  await refresh();
}

async function refreshLocks() {
  const { status, body } = await api<{ locks: PublicLock[] }>("/api/locks");
  const list = $("locks");
  if (status !== 200) {
    list.replaceChildren();
    return;
  }
  list.replaceChildren(
    ...body.locks.map((lock) => {
      const item = document.createElement("li");
      item.textContent = `${lock.path || "/"} · ${lock.owner ?? "no owner"} · ${lock.scope} · depth ${lock.depth} · ${lock.timeout}`;
      return item;
    }),
  );
  if (body.locks.length === 0) {
    const item = document.createElement("li");
    item.textContent = "No active locks.";
    list.append(item);
  }
}

function connectLog() {
  state.socket?.close();
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${proto}//${location.host}${basePath()}/api/live`);
  state.socket = socket;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { type?: string; events?: LogEvent[]; event?: LogEvent; locks?: PublicLock[] };
    if (message.events) renderLog(message.events);
    if (message.event) appendLog(message.event);
    if (message.locks) void refreshLocks();
  });
}

function renderLog(events: LogEvent[]) {
  $("log").replaceChildren();
  for (const event of events) appendLog(event);
}

function appendLog(event: LogEvent) {
  const item = document.createElement("li");
  item.textContent = `${new Date(event.at).toLocaleTimeString()} ${event.method} ${event.path} ${event.status}`;
  $("log").prepend(item);
}

async function loadLitmus() {
  const { body } = await api<{ ran: boolean; note: string; suites: { name: string; passed: number; failed: number }[] }>("/api/litmus");
  $("litmus-note").textContent = body.note;
  $("litmus-suites").replaceChildren(
    ...body.suites.map((suite) => {
      const item = document.createElement("li");
      item.textContent = `${suite.name}: ${suite.passed} passed, ${suite.failed} failed`;
      return item;
    }),
  );
}

async function report(event: SubmitEvent) {
  event.preventDefault();
  const reason = $<HTMLTextAreaElement>("report-reason").value;
  const driveId = $<HTMLInputElement>("report-drive").value;
  const contact = $<HTMLInputElement>("report-contact").value;
  const { status, body } = await api<{ frozen?: boolean; error?: { message: string } }>("/api/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason, driveId, contact, turnstileToken: state.reportToken }),
  });
  if (status !== 202) {
    note("report-note", body.error?.message ?? "The report could not be sent.", "bad");
    return;
  }
  note("report-note", body.frozen ? "Reported. That drive is frozen." : "Reported. Thank you.", "ok");
}

function wire() {
  $<HTMLFormElement>("mint-form").addEventListener("submit", (event) => void mint(event));
  $<HTMLButtonElement>("open-devbox").addEventListener("click", () => void useDevbox());
  $<HTMLButtonElement>("refresh").addEventListener("click", () => void refresh());
  $<HTMLButtonElement>("up").addEventListener("click", () => {
    state.cwd = state.cwd.includes("/") ? state.cwd.slice(0, state.cwd.lastIndexOf("/")) : "";
    void refresh();
  });
  $<HTMLFormElement>("mkdir-form").addEventListener("submit", (event) => void createFolder(event));
  $<HTMLFormElement>("upload-form").addEventListener("submit", (event) => void upload(event));
  $<HTMLFormElement>("report-form").addEventListener("submit", (event) => void report(event));
  $<HTMLButtonElement>("theme").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("r2drive-theme", next);
  });
}

async function main() {
  wire();
  await loadConfig();
  await loadLitmus();
  await probeDevbox();
  const token = new URLSearchParams(location.search).get("verify");
  if (token) {
    history.replaceState({}, "", `${location.pathname}${location.hash}`);
    await verify(token);
    return;
  }
  await restoreSession();
}

void main();
