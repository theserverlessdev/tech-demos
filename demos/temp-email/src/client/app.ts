import type { AppConfig, CreatedInbox, InboxInfo, MessageFull, MessageList, MessageSummary, MintedKey } from "../shared/types";

// ------------------------------------------------------------------ storage

type StoredInbox = { address: string; token: string; createdAt: number; expiresAt: number };

const STORE_KEY = "temp-email:inboxes:v1";
const ACTIVE_KEY = "temp-email:active:v1";
const POLL_MS = 5000;

function loadInboxes(): StoredInbox[] {
  try {
    const list = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as StoredInbox[];
    // Keep expired inboxes for one hour, so the visitor sees why an address stopped.
    return list.filter((i) => i && typeof i.token === "string" && i.expiresAt > Date.now() - 3_600_000);
  } catch {
    return [];
  }
}

function saveInboxes(): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(state.inboxes));
  if (state.active) localStorage.setItem(ACTIVE_KEY, state.active.address);
  else localStorage.removeItem(ACTIVE_KEY);
}

// ------------------------------------------------------------------ API

class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function api<T>(path: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiFailure(0, "network", "The network request failed. Check the connection.");
  }
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!res.ok) throw new ApiFailure(res.status, data?.error?.code ?? "http", data?.error?.message ?? `HTTP ${res.status}`);
  return data as T;
}

const inboxPath = (inbox: StoredInbox) => `/inboxes/${encodeURIComponent(inbox.address)}`;

// ------------------------------------------------------------------ state

const state = {
  config: null as AppConfig | null,
  inboxes: loadInboxes(),
  active: null as StoredInbox | null,
  messages: [] as MessageSummary[],
  cursor: 0,
  selected: null as MessageFull | null,
  tab: "html" as "html" | "text" | "details",
  remote: false,
  pollTimer: 0,
  pollCount: 0,
  polling: false,
  gone: false,
  mintedKey: null as string | null,
  turnstileId: null as string | null,
};

// ------------------------------------------------------------------ DOM

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  layout: $("layout"),
  mx: $("mx"),
  mxText: $("mx-text"),
  addressCard: $("address-card"),
  address: $<HTMLOutputElement>("address"),
  copy: $<HTMLButtonElement>("copy"),
  expiry: $("expiry"),
  expiryFill: $("expiry-fill"),
  expiryText: $("expiry-text"),
  newRandom: $<HTMLButtonElement>("new-random"),
  extend: $<HTMLButtonElement>("extend"),
  deleteInbox: $<HTMLButtonElement>("delete-inbox"),
  customForm: $<HTMLFormElement>("custom-form"),
  customName: $<HTMLInputElement>("custom-name"),
  customDomain: $("custom-domain"),
  hint: $("hint"),
  sample: $<HTMLButtonElement>("send-sample"),
  inboxList: $<HTMLUListElement>("inbox-list"),
  inboxListEmpty: $("inbox-list-empty"),
  agentSnippet: $("agent-snippet"),
  notices: $("notices"),
  mintCard: $("mint-card"),
  mintForm: $<HTMLFormElement>("mint-form"),
  mintIntro: $("mint-intro"),
  mintOff: $("mint-off"),
  mintResult: $("mint-result"),
  mintedKey: $<HTMLOutputElement>("minted-key"),
  mintQuota: $("mint-quota"),
  mintHint: $("mint-hint"),
  mintSubmit: $<HTMLButtonElement>("mint-submit"),
  agentName: $<HTMLInputElement>("agent-name"),
  turnstile: $("turnstile"),
  copyKey: $<HTMLButtonElement>("copy-key"),
  revokeKey: $<HTMLButtonElement>("revoke-key"),
  list: document.querySelector<HTMLElement>(".list")!,
  count: $("count"),
  live: $("live"),
  liveText: $("live-text"),
  messages: $<HTMLOListElement>("messages"),
  listEmpty: $("list-empty"),
  emptyTitle: $("empty-title"),
  emptyBody: $("empty-body"),
  viewerEmpty: $("viewer-empty"),
  mail: $("mail"),
  back: $<HTMLButtonElement>("back"),
  subject: $("mail-subject"),
  from: $("mail-from"),
  to: $("mail-to"),
  date: $("mail-date"),
  chips: $("mail-chips"),
  codes: $("mail-codes"),
  codesList: $("codes-list"),
  deleteMessage: $<HTMLButtonElement>("delete-message"),
  remote: $<HTMLInputElement>("remote"),
  remoteWrap: $("remote-wrap"),
  frame: $<HTMLIFrameElement>("html-frame"),
  htmlEmpty: $("html-empty"),
  textBody: $("text-body"),
  links: $<HTMLUListElement>("links"),
  attachments: $<HTMLUListElement>("attachments"),
  headers: $("headers"),
  theme: $<HTMLButtonElement>("theme"),
};

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...children: (Node | string)[]) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

let hintTimer = 0;

/** A success hint clears after 6 seconds. An error stays until the next action. */
function setHint(text: string, tone: "error" | "ok" | "" = ""): void {
  clearTimeout(hintTimer);
  el.hint.textContent = text;
  el.hint.dataset.tone = tone;
  if (tone === "ok") hintTimer = window.setTimeout(() => setHint(""), 6000);
}

function busy<T>(button: HTMLButtonElement, work: () => Promise<T>): Promise<T | undefined> {
  button.disabled = true;
  return work()
    .catch((err: unknown) => {
      setHint(err instanceof Error ? err.message : String(err), "error");
      return undefined;
    })
    .finally(() => {
      renderAddress();
    });
}

// ------------------------------------------------------------------ formatting

function formatLeft(ms: number): string {
  if (ms <= 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(hours ? 2 : 1, "0");
  return hours ? `${hours}:${mm}:${String(seconds).padStart(2, "0")}` : `${mm}:${String(seconds).padStart(2, "0")}`;
}

function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 45_000) return "now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function senderLabel(m: MessageSummary): string {
  return m.from.name || m.from.address || m.envelopeFrom;
}

// ------------------------------------------------------------------ render: MX and address

function renderMx(): void {
  const config = state.config;
  if (!config) return;
  el.customDomain.textContent = config.domain;
  if (config.mx.live) {
    el.mx.dataset.state = "live";
    el.mxText.replaceChildren("Inbound mail is live. Send mail to any address you create here.");
  } else {
    el.mx.dataset.state = "pending";
    el.mxText.replaceChildren(
      "MX for ",
      h("code", { textContent: config.domain }),
      " is not live yet, so real mail cannot arrive. Use Send sample to test the parser and storage.",
    );
  }
}

function renderAddress(): void {
  const inbox = state.active;
  const expired = !!inbox && (inbox.expiresAt <= Date.now() || state.gone);
  el.addressCard.dataset.state = inbox ? (expired ? "expired" : "active") : "empty";
  if (inbox) {
    const [local, domain] = inbox.address.split("@");
    el.address.replaceChildren(local, h("span", { className: "at", textContent: `@${domain}` }));
  } else {
    el.address.textContent = "No inbox yet";
  }
  el.copy.disabled = !inbox || expired;
  el.extend.disabled = !inbox || expired;
  el.deleteInbox.disabled = !inbox;
  el.sample.disabled = !inbox || expired;
  el.newRandom.disabled = false;
  el.expiry.hidden = !inbox;
  tickExpiry();
  renderInboxList();
  renderSnippet();
}

function tickExpiry(): void {
  const inbox = state.active;
  if (!inbox) return;
  const left = inbox.expiresAt - Date.now();
  const window = (state.config?.webTtlMinutes ?? 60) * 60_000;
  el.expiryText.textContent = left > 0 && !state.gone ? formatLeft(left) : "expired, 0:00";
  el.expiryFill.style.width = `${Math.max(0, Math.min(1, left / window)) * 100}%`;
  el.expiry.dataset.low = String(left < 5 * 60_000);
  if (left <= 0 && !state.gone) {
    state.gone = true;
    stopPolling();
    renderAddress();
    renderList();
  }
}

function renderInboxList(): void {
  el.inboxList.replaceChildren(
    ...state.inboxes.map((inbox) => {
      const left = inbox.expiresAt - Date.now();
      const button = h(
        "button",
        { type: "button", title: inbox.address },
        h("span", { className: "name", textContent: inbox.address.split("@")[0] }),
        h("span", { className: left > 0 ? "left" : "left expired", textContent: left > 0 ? formatLeft(left) : "expired" }),
      );
      button.setAttribute("aria-current", String(state.active?.address === inbox.address));
      button.addEventListener("click", () => activate(inbox));
      return h("li", {}, button);
    }),
  );
  el.inboxListEmpty.hidden = state.inboxes.length > 0;
}

function renderSnippet(): void {
  const origin = location.origin;
  const address = state.active?.address ?? `name@${state.config?.domain ?? "email.lomvic.com"}`;
  el.agentSnippet.textContent = [
    `# KEY is the per-agent key minted in the UI (shown once).`,
    `curl -s -X POST ${origin}/api/v1/inboxes \\`,
    `  -H "Authorization: Bearer $KEY" \\`,
    `  -H "content-type: application/json" \\`,
    `  -d '{"ttlMinutes": 30}'`,
    ``,
    `# Wait up to 25 s for the next message`,
    `curl -s "${origin}/api/v1/inboxes/${address}/wait?after=0&timeout=25" \\`,
    `  -H "Authorization: Bearer $KEY" | jq '.messages[0].codes'`,
  ].join("\n");
}

// ------------------------------------------------------------------ render: list and viewer

function renderList(fresh: Set<string> = new Set()): void {
  el.count.textContent = String(state.messages.length);
  el.messages.replaceChildren(
    ...state.messages.map((m) => {
      const tags = h("div", { className: "msg__tags" });
      if (m.via !== "smtp") tags.append(h("span", { className: "chip", textContent: m.via }));
      for (const code of m.codes.slice(0, 2)) tags.append(h("span", { className: "chip chip-ember", textContent: code }));
      if (m.attachmentCount) tags.append(h("span", { className: "chip", textContent: `${m.attachmentCount} attachment${m.attachmentCount > 1 ? "s" : ""}` }));
      const button = h(
        "button",
        { type: "button", className: "msg" },
        h("span", { className: "msg__top" }, h("span", { className: "msg__from", textContent: senderLabel(m) }), h("time", { className: "msg__time", textContent: formatTime(m.receivedAt) })),
        h("span", { className: "msg__subject", textContent: m.subject }),
        h("span", { className: "msg__snippet", textContent: m.snippet }),
      );
      if (tags.childElementCount) button.append(tags);
      button.setAttribute("aria-current", String(state.selected?.id === m.id));
      if (fresh.has(m.id)) button.dataset.new = "true";
      button.addEventListener("click", () => void openMessage(m.id));
      return h("li", {}, button);
    }),
  );

  const empty = state.messages.length === 0;
  el.listEmpty.hidden = !empty;
  el.list.dataset.waiting = String(empty && !!state.active && !state.gone);
  if (!state.active) {
    el.emptyTitle.textContent = "Create an address to start";
    el.emptyBody.textContent = "New mail shows here within a few seconds.";
  } else if (state.gone) {
    el.emptyTitle.textContent = "This inbox has expired";
    el.emptyBody.textContent = "The server deleted it and its messages. Create a new address.";
  } else {
    el.emptyTitle.textContent = "Waiting for mail";
    el.emptyBody.textContent = state.config?.mx.live
      ? `Send a message to ${state.active.address}.`
      : "Real mail cannot arrive until MX is live. Press Send sample to see the flow.";
  }
}

const SAFE_LINK = /^(https?:|mailto:)/i;

/**
 * Cleans untrusted mail HTML before it goes into the frame. DOMParser builds an inert document: no script
 * runs and no image loads. Links keep only http, https, and mailto, because the frame lets a clicked link
 * open a normal tab, and a data: or javascript: URL must never reach that tab.
 */
function cleanMailHtml(html: string): { head: string; body: string } {
  // A <base> tag in the mail trips the page base-uri policy during parsing, so it goes before the parse.
  const doc = new DOMParser().parseFromString(html.replace(/<base\b[^>]*>/gi, ""), "text/html");
  doc.querySelectorAll("script, noscript, meta, base, link, iframe, frame, frameset, object, embed, form").forEach((n) => n.remove());
  for (const node of doc.querySelectorAll<HTMLElement>("*")) {
    for (const attr of [...node.attributes]) {
      if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
    }
  }
  for (const link of doc.querySelectorAll<HTMLAnchorElement | HTMLAreaElement>("a, area")) {
    const href = link.getAttribute("href")?.trim() ?? "";
    if (href && !SAFE_LINK.test(href)) link.removeAttribute("href");
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }
  // Styles in the mail head move into our head. Styles in the body stay where they are.
  const headStyles = [...doc.head.querySelectorAll("style")].map((n) => n.outerHTML).join("");
  return { head: headStyles, body: doc.body.innerHTML };
}

/**
 * The HTML part renders in a sandboxed srcdoc frame: no scripts, an opaque origin, and a CSP that blocks
 * remote loads until the visitor allows them. Our head comes first, and the cleaner removes every meta tag
 * from the mail, so the mail cannot loosen the policy.
 */
function frameDocument(html: string, remote: boolean): string {
  const img = remote ? "data: cid: https: http:" : "data: cid:";
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src ${img}; font-src data:${remote ? " https:" : ""}`;
  const mail = cleanMailHtml(html);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>body{margin:0;padding:16px;font-family:system-ui,sans-serif;color:#17171a;background:#fff;word-wrap:break-word}img{max-width:100%;height:auto}</style>${mail.head}</head><body>${mail.body}</body></html>`;
}

function renderViewer(): void {
  const m = state.selected;
  el.viewerEmpty.hidden = !!m;
  el.mail.hidden = !m;
  if (!m) {
    el.layout.dataset.view = "list";
    return;
  }
  el.subject.textContent = m.subject;
  el.from.textContent = m.from.address ? (m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address) : m.envelopeFrom;
  el.to.textContent = m.to ?? state.active?.address ?? "";
  el.date.textContent = new Date(m.receivedAt).toLocaleString();

  el.chips.replaceChildren(
    h("span", { className: m.via === "smtp" ? "chip chip-ok" : "chip", textContent: m.via === "smtp" ? "smtp" : `${m.via} delivery` }),
    h("span", { className: "chip", textContent: formatBytes(m.rawSize) }),
    ...(m.truncated ? [h("span", { className: "chip chip-ember", textContent: "body cut to limit" })] : []),
  );

  el.codes.hidden = m.codes.length === 0;
  el.codesList.replaceChildren(
    ...m.codes.map((code) => {
      const b = h("button", { type: "button", className: "code-btn", textContent: code, title: "Copy the code" });
      b.addEventListener("click", () => {
        void navigator.clipboard.writeText(code).then(() => {
          b.dataset.copied = "true";
          setTimeout(() => delete b.dataset.copied, 1200);
        });
      });
      return b;
    }),
  );

  if (!m.html && state.tab === "html") state.tab = "text";
  renderTab();

  el.links.replaceChildren(
    ...(m.links.length
      ? m.links.map((url) => h("li", {}, h("a", { href: url, textContent: url, target: "_blank", rel: "noopener noreferrer" })))
      : [h("li", { className: "none", textContent: "No links." })]),
  );
  el.attachments.replaceChildren(
    ...(m.attachments.length
      ? m.attachments.map((a) =>
          h("li", {}, h("span", { textContent: a.filename ?? "(no name)" }), h("span", { className: "size", textContent: `${a.mimeType} · ${formatBytes(a.size)}` })),
        )
      : [h("li", { className: "none", textContent: "No attachments." })]),
  );
  const rows: [string, string | null][] = [
    ["envelope from", m.envelopeFrom],
    ["message-id", m.messageId],
    ["date", m.date],
    ["delivered via", m.via],
    ["raw size", `${m.rawSize} bytes`],
    ["message id", m.id],
  ];
  el.headers.replaceChildren(...rows.filter(([, v]) => v).flatMap(([k, v]) => [h("dt", { textContent: k }), h("dd", { textContent: v! })]));
}

function renderTab(): void {
  const m = state.selected;
  if (!m) return;
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === state.tab));
  }
  for (const pane of document.querySelectorAll<HTMLElement>(".pane")) pane.hidden = pane.dataset.pane !== state.tab;
  el.remoteWrap.hidden = state.tab !== "html" || !m.html;
  if (state.tab === "html") {
    el.frame.hidden = !m.html;
    el.htmlEmpty.hidden = !!m.html;
    el.frame.srcdoc = m.html ? frameDocument(m.html, state.remote) : "";
  } else if (state.tab === "text") {
    el.textBody.textContent = m.text ?? "This message has no text part.";
  }
}

type TurnstileApi = {
  render: (container: string | HTMLElement, options: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  getResponse: (id?: string) => string;
  remove: (id?: string) => void;
};

function turnstileApi(): TurnstileApi | undefined {
  return (window as unknown as { turnstile?: TurnstileApi }).turnstile;
}

async function whenTurnstile(): Promise<TurnstileApi> {
  for (let i = 0; i < 50; i++) {
    const api = turnstileApi();
    if (api) return api;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Turnstile failed to load.");
}

async function renderTurnstile(): Promise<void> {
  const siteKey = state.config?.mint.turnstileSiteKey;
  if (!siteKey || !state.config?.mint.enabled) return;
  const api = await whenTurnstile();
  if (state.turnstileId) {
    api.remove(state.turnstileId);
    state.turnstileId = null;
    el.turnstile.replaceChildren();
  }
  state.turnstileId = api.render(el.turnstile, {
    sitekey: siteKey,
    action: "mint-key",
    theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
  });
}

function setMintHint(text: string, tone: "error" | "ok" | "" = ""): void {
  el.mintHint.textContent = text;
  el.mintHint.dataset.tone = tone;
}

function showMintResult(created: MintedKey): void {
  state.mintedKey = created.key;
  el.mintedKey.textContent = created.key;
  el.mintQuota.textContent = `Quota: ${created.inboxLimit} active inboxes, ${created.createLimit} creates per 24 hours.`;
  el.mintForm.hidden = true;
  el.mintResult.hidden = false;
}

function renderMint(): void {
  const mint = state.config?.mint;
  const enabled = !!mint?.enabled && !!mint.turnstileSiteKey;
  el.mintForm.hidden = !enabled || !!state.mintedKey;
  el.mintOff.hidden = enabled || !!state.mintedKey;
  el.mintResult.hidden = !state.mintedKey;
  if (state.config?.hosted) {
    el.notices.hidden = false;
    el.mintIntro.textContent =
      "This hosted demo is not a shared agent API. Mint your own key after Turnstile. The key is shown once.";
  }
}

// ------------------------------------------------------------------ actions

async function loadConfig(): Promise<void> {
  try {
    state.config = await api<AppConfig>("/config");
    renderMx();
    renderMint();
    try {
      if (state.config.mint.enabled) await renderTurnstile();
    } catch (err) {
      setMintHint(err instanceof Error ? err.message : String(err), "error");
    }
  } catch (err) {
    el.mx.dataset.state = "pending";
    el.mxText.textContent = err instanceof Error ? `The status check failed: ${err.message}` : "The status check failed.";
  }
}

function remember(created: CreatedInbox): StoredInbox {
  const stored: StoredInbox = { address: created.address, token: created.token, createdAt: created.createdAt, expiresAt: created.expiresAt };
  state.inboxes = [stored, ...state.inboxes.filter((i) => i.address !== stored.address)].slice(0, 12);
  return stored;
}

function applyInfo(inbox: StoredInbox, info: InboxInfo): void {
  inbox.expiresAt = info.expiresAt;
  saveInboxes();
}

async function createInbox(localPart?: string): Promise<void> {
  setHint("");
  const created = await api<CreatedInbox>("/inboxes", { method: "POST", body: localPart ? { localPart } : {} });
  await activate(remember(created));
  setHint(`Created ${created.address}.`, "ok");
}

async function activate(inbox: StoredInbox): Promise<void> {
  stopPolling();
  state.active = inbox;
  state.messages = [];
  state.cursor = 0;
  state.selected = null;
  state.gone = inbox.expiresAt <= Date.now();
  saveInboxes();
  renderAddress();
  renderList();
  renderViewer();
  if (state.gone) return;
  await refresh(true);
  startPolling();
}

async function refresh(full = false): Promise<void> {
  const inbox = state.active;
  if (!inbox || state.gone || state.polling) return;
  state.polling = true;
  try {
    const after = full ? 0 : state.cursor;
    const list = await api<MessageList>(`${inboxPath(inbox)}/messages?after=${after}`, { token: inbox.token });
    if (state.active !== inbox) return;
    applyInfo(inbox, list.inbox);
    const fresh = new Set(full ? [] : list.messages.map((m) => m.id));
    const known = new Set(state.messages.map((m) => m.id));
    state.messages = full ? list.messages : [...list.messages.filter((m) => !known.has(m.id)), ...state.messages];
    if (full && state.selected && !state.messages.some((m) => m.id === state.selected?.id)) {
      state.selected = null;
      renderViewer();
    }
    state.cursor = Math.max(state.cursor, list.cursor);
    el.live.dataset.state = "on";
    el.liveText.textContent = "Live";
    if (full || fresh.size) renderList(fresh);
    else if (el.messages.childElementCount) refreshTimes();
    tickExpiry();
  } catch (err) {
    if (err instanceof ApiFailure && err.status === 404) {
      state.gone = true;
      stopPolling();
      renderAddress();
      renderList();
      setHint("The server no longer has this inbox. It expired or someone deleted it.", "error");
    } else {
      el.live.dataset.state = "error";
      el.liveText.textContent = err instanceof ApiFailure && err.status === 429 ? "Slowed" : "Retrying";
    }
  } finally {
    state.polling = false;
  }
}

function refreshTimes(): void {
  const times = el.messages.querySelectorAll<HTMLTimeElement>(".msg__time");
  state.messages.forEach((m, i) => {
    if (times[i]) times[i].textContent = formatTime(m.receivedAt);
  });
}

function startPolling(): void {
  clearInterval(state.pollTimer);
  state.pollTimer = window.setInterval(() => {
    // Every sixth poll reloads the whole list, so a message deleted in another tab or by an agent drops out.
    if (document.visibilityState === "visible") void refresh(++state.pollCount % 6 === 0);
  }, POLL_MS);
}

function stopPolling(): void {
  clearInterval(state.pollTimer);
  el.live.dataset.state = "idle";
  el.liveText.textContent = "Idle";
}

async function openMessage(id: string): Promise<void> {
  const inbox = state.active;
  if (!inbox) return;
  try {
    const message = await api<MessageFull>(`${inboxPath(inbox)}/messages/${id}`, { token: inbox.token });
    if (state.active !== inbox) return;
    state.selected = message;
    state.remote = false;
    el.remote.checked = false;
    if (message.html) state.tab = "html";
    el.layout.dataset.view = "message";
    renderViewer();
    for (const b of el.messages.querySelectorAll<HTMLButtonElement>(".msg")) b.setAttribute("aria-current", "false");
    const index = state.messages.findIndex((m) => m.id === id);
    el.messages.querySelectorAll<HTMLButtonElement>(".msg")[index]?.setAttribute("aria-current", "true");
  } catch (err) {
    if (err instanceof ApiFailure && err.status === 404 && state.active === inbox) {
      state.messages = state.messages.filter((m) => m.id !== id);
      renderList();
    }
    setHint(err instanceof Error ? err.message : String(err), "error");
  }
}

// ------------------------------------------------------------------ events

el.newRandom.addEventListener("click", () => void busy(el.newRandom, () => createInbox()));

el.customForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = el.customName.value.trim();
  if (!name) {
    setHint("Type a name first.", "error");
    return;
  }
  const button = el.customForm.querySelector<HTMLButtonElement>("button")!;
  void busy(button, async () => {
    await createInbox(name);
    el.customName.value = "";
  }).finally(() => (button.disabled = false));
});

el.copy.addEventListener("click", () => {
  if (!state.active) return;
  void navigator.clipboard.writeText(state.active.address).then(
    () => setHint("Copied the address.", "ok"),
    () => setHint("The browser blocked the clipboard. Select the address and copy it.", "error"),
  );
});

el.extend.addEventListener("click", () => {
  const inbox = state.active;
  if (!inbox) return;
  void busy(el.extend, async () => {
    const info = await api<InboxInfo>(`${inboxPath(inbox)}/extend`, { method: "POST", token: inbox.token, body: {} });
    applyInfo(inbox, info);
    setHint(`The inbox now expires at ${new Date(info.expiresAt).toLocaleTimeString()}.`, "ok");
  });
});

el.deleteInbox.addEventListener("click", () => {
  const inbox = state.active;
  if (!inbox || !confirm(`Delete ${inbox.address} and all of its messages?`)) return;
  void busy(el.deleteInbox, async () => {
    if (!state.gone) {
      await api(inboxPath(inbox), { method: "DELETE", token: inbox.token }).catch((err: unknown) => {
        if (!(err instanceof ApiFailure && err.status === 404)) throw err;
      });
    }
    state.inboxes = state.inboxes.filter((i) => i.address !== inbox.address);
    stopPolling();
    state.active = null;
    state.messages = [];
    state.selected = null;
    saveInboxes();
    renderList();
    renderViewer();
    const next = state.inboxes.find((i) => i.expiresAt > Date.now());
    if (next) await activate(next);
    setHint(`Deleted ${inbox.address}.`, "ok");
  });
});

el.sample.addEventListener("click", () => {
  const inbox = state.active;
  if (!inbox) return;
  void busy(el.sample, async () => {
    const message = await api<MessageFull>(`${inboxPath(inbox)}/sample`, { method: "POST", token: inbox.token });
    await refresh();
    await openMessage(message.id);
    setHint("The sample went through the parser and into D1.", "ok");
  });
});

el.deleteMessage.addEventListener("click", () => {
  const inbox = state.active;
  const message = state.selected;
  if (!inbox || !message) return;
  void busy(el.deleteMessage, async () => {
    await api(`${inboxPath(inbox)}/messages/${message.id}`, { method: "DELETE", token: inbox.token });
    state.messages = state.messages.filter((m) => m.id !== message.id);
    state.selected = null;
    renderList();
    renderViewer();
  }).finally(() => (el.deleteMessage.disabled = false));
});

for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  tab.addEventListener("click", () => {
    state.tab = tab.dataset.tab as typeof state.tab;
    renderTab();
  });
}

el.remote.addEventListener("change", () => {
  state.remote = el.remote.checked;
  renderTab();
});

el.back.addEventListener("click", () => {
  state.selected = null;
  renderViewer();
  renderList();
});

el.theme.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("theme", next);
  if (state.config?.mint.enabled) void renderTurnstile();
});

el.mintForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    el.mintSubmit.disabled = true;
    setMintHint("");
    try {
      const token = state.turnstileId ? turnstileApi()?.getResponse(state.turnstileId) : "";
      if (!token) {
        setMintHint("Complete the Turnstile check first.", "error");
        return;
      }
      const name = el.agentName.value.trim();
      const created = await api<MintedKey>("/keys", {
        method: "POST",
        body: { name: name || undefined, turnstileToken: token },
      });
      showMintResult(created);
      setMintHint("Copy the key now. It will not be shown again.", "ok");
    } catch (err) {
      setMintHint(err instanceof Error ? err.message : String(err), "error");
      turnstileApi()?.reset(state.turnstileId ?? undefined);
    } finally {
      el.mintSubmit.disabled = !!state.mintedKey;
    }
  })();
});

el.copyKey.addEventListener("click", () => {
  if (!state.mintedKey) return;
  void navigator.clipboard.writeText(state.mintedKey).then(
    () => setMintHint("Copied the API key.", "ok"),
    () => setMintHint("The browser blocked the clipboard. Select the key and copy it.", "error"),
  );
});

el.revokeKey.addEventListener("click", () => {
  if (!state.mintedKey || !confirm("Revoke this API key? Inboxes it created stay until they expire.")) return;
  void (async () => {
    el.revokeKey.disabled = true;
    try {
      await api("/keys/revoke", { method: "POST", token: state.mintedKey ?? undefined });
      state.mintedKey = null;
      el.mintedKey.textContent = "";
      renderMint();
      setMintHint("The key is revoked.", "ok");
      if (state.config?.mint.enabled) await renderTurnstile();
    } catch (err) {
      setMintHint(err instanceof Error ? err.message : String(err), "error");
    } finally {
      el.revokeKey.disabled = !state.mintedKey;
    }
  })();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refresh();
});

setInterval(() => {
  tickExpiry();
  if (state.inboxes.length) {
    const lefts = el.inboxList.querySelectorAll<HTMLElement>(".left");
    state.inboxes.forEach((inbox, i) => {
      const left = inbox.expiresAt - Date.now();
      if (lefts[i]) {
        lefts[i].textContent = left > 0 ? formatLeft(left) : "expired";
        lefts[i].className = left > 0 ? "left" : "left expired";
      }
    });
  }
}, 1000);

// ------------------------------------------------------------------ start

await loadConfig();
renderSnippet();
const remembered = localStorage.getItem(ACTIVE_KEY);
const initial = state.inboxes.find((i) => i.address === remembered && i.expiresAt > Date.now()) ?? state.inboxes.find((i) => i.expiresAt > Date.now());
if (initial) await activate(initial);
else {
  renderAddress();
  renderList();
  renderViewer();
}
