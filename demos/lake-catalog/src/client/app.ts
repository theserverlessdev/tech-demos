import { QuackClient, type QuackRow } from "@quack-protocol/sdk";

type Role = "analyst" | "viewer" | "guest";

type Explain = {
  effect: "allow" | "deny" | "rewrite";
  role: Role;
  catalog: string;
  reasons: string[];
  executedSql: string | null;
};

type MapPayload = {
  registryId: string;
  catalogs: { id: string; durableObjectId: string; dataPath: string; rows: number; parquetNote: string }[];
};

const SAMPLES: { role: Role; label: string; sql: string }[] = [
  {
    role: "analyst",
    label: "Analyst: full table",
    sql: "SELECT region, product, units, revenue, customer FROM orders",
  },
  {
    role: "viewer",
    label: "Viewer: mask and filter",
    sql: "SELECT region, product, revenue, customer FROM orders",
  },
  {
    role: "guest",
    label: "Guest: blocked columns",
    sql: "SELECT customer, revenue FROM orders",
  },
];

const sqlBox = document.querySelector<HTMLTextAreaElement>("#sql");
const form = document.querySelector<HTMLFormElement>("#form");
const run = document.querySelector<HTMLButtonElement>("#run");
const status = document.querySelector<HTMLElement>("#status");
const explainEl = document.querySelector<HTMLElement>("#explain");
const rowsEl = document.querySelector<HTMLElement>("#rows");
const mapEl = document.querySelector<HTMLElement>("#map");
const snippetEl = document.querySelector<HTMLElement>("#snippet");
const copyBtn = document.querySelector<HTMLButtonElement>("#copy");
const chips = document.querySelector<HTMLElement>("#chips");
const roles = document.querySelectorAll<HTMLButtonElement>(".role");

let role: Role = "analyst";
let siteKey = "0x4AAAAAAFRUoj5qDpf7XyIW";
let widgetId = "";
let turnstileToken = "";
let snippet = "";

function setStatus(text: string) {
  if (status) status.textContent = text;
}

function selectRole(next: Role) {
  role = next;
  roles.forEach((button) => {
    const on = button.dataset.role === next;
    button.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

document.querySelector<HTMLButtonElement>("#theme")?.addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem("theme", next);
  } catch {
    /* ignore */
  }
});

roles.forEach((button) => {
  button.addEventListener("click", () => {
    const next = button.dataset.role;
    if (next === "analyst" || next === "viewer" || next === "guest") selectRole(next);
  });
});

SAMPLES.forEach((sample) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chip";
  button.textContent = sample.label;
  button.addEventListener("click", () => {
    selectRole(sample.role);
    if (sqlBox) sqlBox.value = sample.sql;
    sqlBox?.focus();
  });
  chips?.append(button);
});

function renderExplain(explain: Explain | null, fallback: string) {
  if (!explainEl) return;
  explainEl.replaceChildren();
  if (!explain) {
    explainEl.dataset.effect = "";
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = fallback;
    explainEl.append(p);
    return;
  }
  explainEl.dataset.effect = explain.effect;
  const badge = document.createElement("p");
  badge.className = `badge badge-${explain.effect}`;
  badge.textContent = explain.effect;
  const list = document.createElement("ul");
  explain.reasons.forEach((reason) => {
    const item = document.createElement("li");
    item.textContent = reason;
    list.append(item);
  });
  explainEl.append(badge, list);
  if (explain.executedSql) {
    const label = document.createElement("p");
    label.className = "eyebrow";
    label.textContent = "SQL that ran";
    const code = document.createElement("pre");
    code.className = "code";
    code.textContent = explain.executedSql;
    explainEl.append(label, code);
  }
}

function renderRows(names: string[], records: QuackRow[]) {
  if (!rowsEl) return;
  rowsEl.replaceChildren();
  if (!records.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = names.length ? "The statement returned no rows." : "No rows were returned.";
    rowsEl.append(p);
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  const head = document.createElement("tr");
  names.forEach((name) => {
    const cell = document.createElement("th");
    cell.textContent = name;
    head.append(cell);
  });
  const thead = document.createElement("thead");
  thead.append(head);
  const tbody = document.createElement("tbody");
  records.forEach((record) => {
    const tr = document.createElement("tr");
    names.forEach((name) => {
      const cell = document.createElement("td");
      const value = record[name];
      if (value === null || value === undefined) {
        cell.textContent = "null";
        cell.className = "nil";
      } else {
        cell.textContent = String(value);
      }
      tr.append(cell);
    });
    tbody.append(tr);
  });
  table.append(thead, tbody);
  wrap.append(table);
  const count = document.createElement("p");
  count.className = "muted";
  count.textContent = `${records.length} row${records.length === 1 ? "" : "s"}`;
  rowsEl.append(wrap, count);
}

function renderMap(payload: MapPayload) {
  if (!mapEl) return;
  mapEl.replaceChildren();
  const registry = document.createElement("p");
  registry.className = "mono";
  const k = document.createElement("span");
  k.className = "eyebrow";
  k.textContent = "Registry";
  registry.append(k, document.createTextNode(` ${payload.registryId}`));
  mapEl.append(registry);
  payload.catalogs.forEach((catalog) => {
    const card = document.createElement("article");
    card.className = "docard";
    const title = document.createElement("h3");
    title.textContent = catalog.id;
    const id = document.createElement("p");
    id.className = "mono";
    id.textContent = catalog.durableObjectId;
    const path = document.createElement("p");
    path.className = "mono";
    path.textContent = catalog.dataPath;
    const meta = document.createElement("p");
    meta.className = "muted";
    meta.textContent = `${catalog.rows} rows · Parquet ${catalog.parquetNote}`;
    card.append(title, id, path, meta);
    mapEl.append(card);
  });
}

function showSnippet(text: string) {
  snippet = text;
  if (!snippetEl) return;
  snippetEl.textContent = text || "Run a query to mint a ten-minute read-only token.";
}

copyBtn?.addEventListener("click", () => {
  if (!snippet) return;
  void navigator.clipboard.writeText(snippet).then(
    () => setStatus("The DuckDB snippet is on the clipboard."),
    () => setStatus("The clipboard was blocked. Select the snippet and copy it."),
  );
});

function mountTurnstile() {
  const host = document.getElementById("turnstile");
  const api = (window as unknown as { turnstile?: { render?: (el: HTMLElement, opts: Record<string, unknown>) => string } }).turnstile;
  if (!host || host.dataset.ready === "1") return true;
  if (!api || typeof api.render !== "function") return false;
  host.dataset.ready = "1";
  widgetId = api.render(host, {
    sitekey: siteKey,
    action: "lake-catalog",
    callback: (token: string) => {
      turnstileToken = token;
      setStatus("Check passed. Pick a role and run a query.");
    },
    "error-callback": () => {
      turnstileToken = "";
      setStatus("The check failed. Reload and try again.");
    },
    "expired-callback": () => {
      turnstileToken = "";
    },
  });
  return true;
}

async function loadMap() {
  const response = await fetch("/api/map");
  if (!response.ok) {
    setStatus("The catalog map is unavailable.");
    return;
  }
  renderMap((await response.json()) as MapPayload);
}

async function boot() {
  try {
    const response = await fetch("/api/config");
    if (response.ok) {
      const body = (await response.json()) as { siteKey?: string };
      if (body.siteKey) siteKey = body.siteKey;
    }
  } catch {
    /* the public site key remains */
  }
  const retry = document.querySelector<HTMLButtonElement>("#turnstile-retry");
  const started = Date.now();
  let notedWait = false;
  const timer = window.setInterval(() => {
    if (mountTurnstile()) {
      window.clearInterval(timer);
      if (retry) retry.hidden = true;
      return;
    }
    if (retry && Date.now() - started > 8000) {
      retry.hidden = false;
      if (!notedWait && !turnstileToken) {
        notedWait = true;
        setStatus("The check is still loading.");
      }
    }
  }, 200);
  retry?.addEventListener("click", () => {
    const host = document.getElementById("turnstile");
    if (host) delete host.dataset.ready;
    turnstileToken = "";
    widgetId = "";
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    document.body.append(script);
    setStatus("Waiting for the check to load.");
    if (mountTurnstile() && retry) retry.hidden = true;
  });
  await loadMap();
}

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  void runQuery();
});

function resetTurnstile() {
  turnstileToken = "";
  const api = (window as unknown as { turnstile?: { reset?: (id: string) => void } }).turnstile;
  if (widgetId && api?.reset) api.reset(widgetId);
}

async function runQuery() {
  if (!sqlBox || !run) return;
  const statement = sqlBox.value.trim();
  if (!statement) {
    setStatus("Write a SELECT first.");
    return;
  }
  if (!turnstileToken) {
    setStatus("Finish the check above the button first.");
    return;
  }
  const token = turnstileToken;
  turnstileToken = "";
  run.disabled = true;
  setStatus("Minting a ten-minute token…");
  renderExplain(null, "Waiting for the catalog.");
  try {
    const minted = await fetch("/api/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role, turnstile: token, catalog: "orders" }),
    });
    const mintedBody = (await minted.json()) as { token?: string; snippet?: string; error?: string };
    if (!minted.ok || !mintedBody.token) {
      const message = mintedBody.error || "The token was not issued.";
      renderExplain(null, message);
      setStatus(message);
      return;
    }
    showSnippet(mintedBody.snippet || "");
    setStatus("Running the statement over Quack…");
    const captured: { explain: Explain | null; httpError: string } = { explain: null, httpError: "" };
    let client: Awaited<ReturnType<typeof QuackClient.connect>> | null = null;
    try {
      client = await QuackClient.connect(location.origin, {
        authToken: mintedBody.token,
        heartbeat: false,
        clientPlatform: "lake-catalog-browser",
        // Workers and browsers reject an unbound fetch. The SDK calls this later.
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          const header = response.headers.get("x-lake-explain");
          if (header) {
            try {
              captured.explain = JSON.parse(header) as Explain;
            } catch {
              captured.explain = null;
            }
          }
          if (!response.ok) captured.httpError = await response.clone().text();
          return response;
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "The catalog connection failed.";
      renderRows([], []);
      renderExplain(null, message);
      setStatus(message);
      return;
    }
    try {
      const result = await client.query(statement);
      const records = result.rows();
      renderRows(result.names, records);
      renderExplain(captured.explain, "The catalog returned rows without an explain header.");
      const effect = captured.explain?.effect ?? "done";
      setStatus(`Decision: ${effect}. The log stores the role and the decision, not the SQL.`);
    } catch (err) {
      renderRows([], []);
      renderExplain(captured.explain, captured.httpError || (err instanceof Error ? err.message : "The query failed."));
      const effect = captured.explain?.effect;
      setStatus(effect ? `Decision: ${effect}.` : captured.httpError || (err instanceof Error ? err.message : "The query failed."));
    } finally {
      await client.disconnect().catch(() => undefined);
    }
  } finally {
    resetTurnstile();
    run.disabled = false;
  }
}

void boot();
