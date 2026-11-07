import { TURNSTILE_ACTION, clientBase } from "../shared/protocol";

const DUMMY = "XXXX.DUMMY.TOKEN.XXXX";

type TimelineItem = { at: number; kind: string; detail: string };
type Challenge = {
  tool: string;
  args: Record<string, string | number>;
  network: string;
  networkLabel: string;
  assetLabel: string;
  amountLabel: string;
  payTo: string;
};
type CallResponse = {
  paid?: boolean;
  status?: string;
  text?: string;
  label?: string;
  error?: string | { code?: string; message?: string };
  confirmationId?: string;
  binding?: string;
  expiresAt?: number;
  challenge?: Challenge;
  settlement?: string;
  transaction?: string;
  timeline?: TimelineItem[];
  mode?: string;
};

function must<T extends Element>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as unknown as T;
}

function setStatus(kind: string, text: string): void {
  const status = must<HTMLElement>("status");
  status.dataset.kind = kind;
  status.textContent = text;
}

function base(): string {
  return clientBase(location.pathname);
}

function errorText(body: CallResponse, fallback: string): string {
  if (typeof body.label === "string" && body.label) return body.label;
  if (typeof body.error === "string") return body.error;
  if (body.error && typeof body.error === "object" && body.error.message) return body.error.message;
  return fallback;
}

function renderTimeline(items: TimelineItem[] | undefined): void {
  const list = must<HTMLOListElement>("timeline");
  list.replaceChildren();
  for (const item of items ?? []) {
    const li = document.createElement("li");
    let detail = item.kind;
    try {
      const parsed = JSON.parse(item.detail) as Record<string, string>;
      const parts = Object.entries(parsed).map(([key, value]) => `${key} ${value}`);
      if (parts.length) detail = `${item.kind} · ${parts.join(" · ")}`;
    } catch {
      detail = item.kind;
    }
    li.textContent = detail;
    list.append(li);
  }
}

function showResult(text: string): void {
  const result = must<HTMLElement>("result");
  result.hidden = false;
  result.textContent = text;
}

let pending: { confirmationId: string; binding: string } | null = null;
let demoMode = "pending";

function showConfirm(body: CallResponse): void {
  const challenge = body.challenge;
  if (!challenge || !body.confirmationId || !body.binding) return;
  pending = { confirmationId: body.confirmationId, binding: body.binding };
  const sheet = must<HTMLElement>("confirm");
  const copy = demoMode === "preview"
    ? "Layout preview. Not a payment."
    : demoMode === "mock"
      ? "Mock settlement. Not a Base Sepolia payment. Nothing is signed until you accept this exact challenge."
      : "The agent will not sign until you accept this exact charge.";
  must<HTMLElement>("confirm-copy").textContent = copy;
  sheet.hidden = false;
  const fields = must<HTMLDListElement>("confirm-fields");
  fields.replaceChildren();
  const rows: [string, string][] = [
    ["Tool", challenge.tool],
    ["Arguments", JSON.stringify(challenge.args)],
    ["Amount", challenge.amountLabel],
    ["Network", `${challenge.networkLabel} (${challenge.network})`],
    ["Token", challenge.assetLabel],
    ["Payee", challenge.payTo],
    ["Expires", body.expiresAt ? new Date(body.expiresAt).toLocaleTimeString() : ""],
  ];
  for (const [term, value] of rows) {
    const wrap = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = value;
    wrap.append(dt, dd);
    fields.append(wrap);
  }
}

async function post(path: string, body: unknown): Promise<CallResponse & { http: number }> {
  const response = await fetch(`${base()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as CallResponse;
  renderTimeline(payload.timeline);
  return { ...payload, http: response.status };
}

async function callTool(tool: string, args: Record<string, string | number>): Promise<void> {
  must<HTMLElement>("confirm").hidden = true;
  pending = null;
  const body = await post("/api/call", { tool, args });
  if (body.http === 402) {
    showConfirm(body);
    setStatus(demoMode === "mock" ? "mock" : "pending", demoMode === "mock"
      ? "HTTP 402. Mock settlement. Not a Base Sepolia payment. Nothing is signed yet."
      : "HTTP 402. Confirm the exact charge, or deny it. Nothing is signed yet.");
    return;
  }
  if (body.status === "free") {
    setStatus(demoMode === "mock" ? "mock" : "idle", body.text ? `Echo returned: ${body.text}` : "Echo returned.");
    if (body.text) showResult(body.text);
    return;
  }
  if (body.paid) {
    setStatus("paid", body.label || "Settled on Base Sepolia test USDC.");
    showResult(body.text || "");
    return;
  }
  const kind = body.settlement === "mock" || demoMode === "mock" || body.mode === "pending" || body.error === "setup_pending" ? "mock" : "error";
  setStatus(kind, errorText(body, "The call did not settle. Nothing is marked paid."));
  if (body.text) showResult(body.text);
}

function preview(): void {
  demoMode = "preview";
  must<HTMLElement>("gate").hidden = true;
  must<HTMLElement>("workspace").hidden = false;
  setStatus("mock", "Layout preview. Not a payment.");
  showConfirm({
    confirmationId: "preview",
    binding: "preview",
    expiresAt: Date.now() + 60_000,
    challenge: {
      tool: "square",
      args: { number: 4 },
      network: "eip155:84532",
      networkLabel: "Base Sepolia",
      assetLabel: "Base Sepolia test USDC",
      amountLabel: "$0.01",
      payTo: "0x2222222222222222222222222222222222222222",
    },
  });
  renderTimeline([
    { at: Date.now(), kind: "http_402", detail: JSON.stringify({ tool: "square", amount: "10000", network: "eip155:84532" }) },
    { at: Date.now(), kind: "approved", detail: JSON.stringify({ tool: "square" }) },
    { at: Date.now(), kind: "mock_settled", detail: JSON.stringify({ label: "Not a Base Sepolia payment" }) },
  ]);
  showResult("Layout preview. Not a payment.");
}

async function boot(): Promise<void> {
  if (new URLSearchParams(location.search).get("preview") === "1") {
    preview();
    return;
  }
  const configResponse = await fetch(`${base()}/api/config`);
  if (!configResponse.ok) {
    setStatus("error", "The demo config did not load. Base Sepolia is the only network this page will accept.");
    return;
  }
  const config = (await configResponse.json()) as { siteKey?: string; local?: boolean; label?: string; mode?: string };
  demoMode = config.mode === "mock" || config.mode === "testnet" || config.mode === "pending" ? config.mode : "pending";
  if (config.label) must<HTMLElement>("mode-note").textContent = config.label;
  if (config.mode === "pending") setStatus("pending", config.label || "Setup pending.");
  if (config.mode === "mock") setStatus("mock", config.label || "Mock settlement. Not a Base Sepolia payment.");
  const start = must<HTMLButtonElement>("start");
  const local = must<HTMLButtonElement>("local-check");
  const tokenBox = { token: "" };
  local.addEventListener("click", () => {
    tokenBox.token = DUMMY;
    start.disabled = false;
  });
  if (config.local) local.hidden = false;
  start.addEventListener("click", () => {
    void startSession(tokenBox.token);
  });
  if (config.siteKey) mountTurnstile(config.siteKey, tokenBox, start);
  must<HTMLFormElement>("echo-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const message = must<HTMLInputElement>("echo").value;
    void callTool("echo", { message });
  });
  must<HTMLFormElement>("square-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const number = Number(must<HTMLInputElement>("square").value);
    void callTool("square", { number });
  });
  must<HTMLFormElement>("summary-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const text = must<HTMLTextAreaElement>("summary").value;
    void callTool("summarize", { text });
  });
  must<HTMLButtonElement>("accept").addEventListener("click", () => {
    void decide(true);
  });
  must<HTMLButtonElement>("deny").addEventListener("click", () => {
    void decide(false);
  });
}

async function startSession(token: string): Promise<void> {
  const body = await post("/api/session", { turnstileToken: token });
  if (body.http !== 200) {
    must<HTMLElement>("form-error").textContent = errorText(body, "The session did not start.");
    return;
  }
  if (body.mode === "mock" || body.mode === "testnet" || body.mode === "pending") demoMode = body.mode;
  must<HTMLElement>("gate").hidden = true;
  must<HTMLElement>("workspace").hidden = false;
  setStatus(body.mode === "mock" ? "mock" : body.mode === "pending" ? "pending" : "idle", body.label || "Session ready.");
}

async function decide(accept: boolean): Promise<void> {
  if (!pending || pending.confirmationId === "preview") return;
  const body = await post("/api/confirm", { ...pending, accept });
  must<HTMLElement>("confirm").hidden = true;
  pending = null;
  if (body.paid) {
    setStatus("paid", body.label || "Settled on Base Sepolia test USDC.");
  } else if (body.settlement === "mock") {
    setStatus("mock", body.label || "Mock settlement. Not a Base Sepolia payment.");
  } else if (body.status === "denied") {
    setStatus("idle", "Denied. The agent did not sign.");
  } else {
    setStatus("error", errorText(body, "Not marked paid."));
  }
  if (body.text) showResult(body.text);
}

type TurnstileApi = { render: (el: string | HTMLElement, opts: Record<string, unknown>) => void };

function mountTurnstile(siteKey: string, tokenBox: { token: string }, start: HTMLButtonElement): void {
  const started = Date.now();
  const tick = () => {
    const api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
    if (typeof api?.render === "function") {
      api.render("#turnstile", {
        sitekey: siteKey,
        action: TURNSTILE_ACTION,
        callback: (token: string) => {
          tokenBox.token = token;
          start.disabled = false;
        },
        "expired-callback": () => {
          if (tokenBox.token === DUMMY) return;
          tokenBox.token = "";
          start.disabled = true;
        },
      });
      return;
    }
    if (Date.now() - started > 8000) return;
    setTimeout(tick, 50);
  };
  tick();
}

void boot();
