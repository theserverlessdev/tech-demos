// Headlines client. The shell injects the globals `gadget`, `RpcTarget` and `gadgetInfo`.

const BUSY = new Set(["awaiting-approval", "fetching", "summarizing"]);
const PHASE_LABEL = {
  "awaiting-approval": "awaiting approval",
  fetching: "fetching",
  summarizing: "summarizing",
};

/* ---------------------------------------------------------------- styles */

const style = document.createElement("style");
style.textContent = `
[hidden] { display: none !important; }
body { overflow-y: auto; }
.page { max-width: 880px; margin: 0 auto; padding: 24px 24px 40px; }
.top { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 16px 24px; padding-bottom: 16px; }
.titles { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.titles h1 { font-size: 30px; line-height: 1.05; }
.meta-line { font: 12px/1.2 var(--font-mono); color: var(--muted); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.btn { justify-content: center; white-space: nowrap; }
.btn:focus-visible { outline: 2px solid var(--ember); outline-offset: 2px; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn:disabled:hover { border-color: var(--border-strong); }
.btn-primary:disabled:hover { background: var(--ember); border-color: var(--ember); }
.btn-lg { padding: .75em 1.4em; font-size: 15px; }

.rule { position: relative; height: 2px; margin-bottom: 20px; overflow: hidden; }
.rule::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 1px; background: var(--border); }
.rule span { position: absolute; top: 0; left: 0; width: 28%; height: 2px; background: var(--ember); opacity: 0; transform: translateX(-100%); }
.rule.busy span { opacity: 1; animation: sweep 1.3s cubic-bezier(.45, 0, .35, 1) infinite; }
@keyframes sweep { from { transform: translateX(-100%); } to { transform: translateX(360%); } }
@media (prefers-reduced-motion: reduce) { .rule.busy span { animation-duration: 3.2s; } }

.banner {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
  margin-bottom: 16px; padding: 12px 14px; font-size: 14px; color: var(--text-strong);
  border: 1px solid var(--border); border-left: 3px solid var(--ember); border-radius: var(--radius-sm);
  background: var(--ember-soft);
}
.banner p { margin: 0; overflow-wrap: anywhere; }
.banner strong { font-weight: 600; }
.banner code { font: 13px var(--font-mono); color: var(--accent-text); }
.banner-error { border-left-color: var(--danger); background: var(--surface); }
.banner-error strong { color: var(--danger); }
.banner .btn { flex: none; padding: .3em .7em; }

.summary { margin-bottom: 20px; padding: 16px 18px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.summary-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 12px; }
.summary ul { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 8px; }
.summary li { position: relative; padding-left: 18px; color: var(--text-strong); }
.summary li::before { content: ""; position: absolute; left: 1px; top: .62em; width: 6px; height: 6px; border-radius: 1px; background: var(--ember); }

.empty {
  display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 44px 24px; text-align: center;
  border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface);
}
.empty h2 { font-size: 22px; }
.empty p { margin: 0; max-width: 48ch; }
.empty code { font: 13px var(--font-mono); color: var(--accent-text); }

.list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--border); }
.row { display: grid; grid-template-columns: 2.4em minmax(0, 1fr); gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--border); }
.rank { padding-top: 2px; font: 13px/1.4 var(--font-mono); color: var(--muted); font-variant-numeric: tabular-nums; }
.line1 { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; min-width: 0; }
.title { color: var(--text-strong); font-weight: 600; line-height: 1.35; text-decoration: none; overflow-wrap: anywhere; }
.title:hover { color: var(--accent-text); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; }
.title:focus-visible { outline: 2px solid var(--ember); outline-offset: 2px; border-radius: 2px; }
.host { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; padding: .25em .6em; }
.meta { margin-top: 4px; font: 12px/1.4 var(--font-mono); color: var(--muted); overflow-wrap: anywhere; }

@media (max-width: 520px) {
  .page { padding: 16px 14px 32px; }
  .titles h1 { font-size: 24px; }
  .actions { width: 100%; }
  .actions .btn { flex: 1; }
  .row { grid-template-columns: 2em minmax(0, 1fr); gap: 8px; }
  .empty { padding: 32px 16px; }
}
`;
(document.head || document.documentElement).append(style);

/* ------------------------------------------------------------------- dom */

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) if (child != null) node.append(child);
  return node;
}

const metaLine = h("span", { class: "meta-line", "aria-live": "polite" });
const refreshBtn = h("button", { type: "button", class: "btn btn-primary", text: "Refresh", onclick: () => run("refresh") });
const summarizeBtn = h("button", { type: "button", class: "btn", text: "Summarize with AI", onclick: () => run("summarize") });
const rule = h("div", { class: "rule", role: "presentation" }, h("span"));

const waitBanner = h("div", { class: "banner", role: "status", hidden: true },
  h("p", {},
    h("strong", { text: "Waiting for approval" }),
    " — open Activity in the shell and approve ",
    h("code", { text: "hn.algolia.com" }),
  ),
);

const errorText = h("span");
const errorTitle = h("strong", { text: "Request failed" });
const errorBanner = h("div", { class: "banner banner-error", role: "alert", hidden: true },
  h("p", {}, errorTitle, ". ", errorText),
  h("button", { type: "button", class: "btn", text: "Dismiss", onclick: () => { dismissedError = currentError(); render(); } }),
);

const summaryList = h("ul");
const summaryBox = h("section", { class: "summary", "aria-label": "AI digest", hidden: true },
  h("div", { class: "summary-head" },
    h("span", { class: "eyebrow", text: "AI digest" }),
    h("span", { class: "meta-line", text: "via AI gatekeeper" }),
  ),
  summaryList,
);

const fetchBtn = h("button", { type: "button", class: "btn btn-primary btn-lg", text: "Fetch front page", onclick: () => run("refresh") });
const emptyBox = h("section", { class: "empty", hidden: true },
  h("h2", { text: "No headlines yet" }),
  h("p", {},
    "This gadget runs with ",
    h("code", { text: "globalOutbound: null" }),
    ", so it has no network access of its own. It reaches the internet only through the WEB gatekeeper, and a person approves each request.",
  ),
  fetchBtn,
);

const list = h("ol", { class: "list", hidden: true });

document.body.append(
  h("div", { class: "page" },
    h("header", { class: "top" },
      h("div", { class: "titles" },
        h("span", { class: "eyebrow", text: "via WEB gatekeeper" }),
        h("h1", { text: "Front page" }),
        metaLine,
      ),
      h("div", { class: "actions" }, refreshBtn, summarizeBtn),
    ),
    rule,
    waitBanner,
    errorBanner,
    summaryBox,
    emptyBox,
    list,
  ),
);

/* ----------------------------------------------------------------- state */

let state = { items: [], fetchedAt: null, summary: null, status: { phase: "idle" } };
let localBusy = null;
let localError = null;
let dismissedError = null;
let listKey = "";
let ageNodes = [];

const messageOf = (err) => (err && err.message) || String(err);

function normalize(next) {
  const status = next && next.status && typeof next.status.phase === "string" ? next.status : { phase: "idle" };
  return {
    items: Array.isArray(next && next.items) ? next.items.filter((item) => item && typeof item.title === "string") : [],
    fetchedAt: typeof (next && next.fetchedAt) === "number" ? next.fetchedAt : null,
    summary: typeof (next && next.summary) === "string" ? next.summary : null,
    status: { phase: status.phase, message: typeof status.message === "string" ? status.message : undefined },
  };
}

function ago(ms) {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function currentError() {
  if (state.status.phase === "error" && state.status.message) return state.status.message;
  return localError;
}

function bulletsOf(summary) {
  return summary
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•–]|\d+[.)])\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
}

function itemMeta(item) {
  const parts = [plural(Number(item.points) || 0, "point"), plural(Number(item.comments) || 0, "comment")];
  if (item.author) parts.push(`by ${item.author}`);
  if (item.createdAt) parts.push(ago(item.createdAt * 1000));
  return parts.join(" · ");
}

function renderList() {
  const key = `${state.fetchedAt}|${state.items.map((item) => item.id).join(",")}`;
  if (key === listKey) {
    for (const { node, item } of ageNodes) node.textContent = itemMeta(item);
    return;
  }
  listKey = key;
  ageNodes = [];
  list.replaceChildren(
    ...state.items.map((item, i) => {
      const href = /^https?:\/\//i.test(item.url) ? item.url : `https://news.ycombinator.com/item?id=${encodeURIComponent(item.id)}`;
      const meta = h("div", { class: "meta", text: itemMeta(item) });
      ageNodes.push({ node: meta, item });
      return h("li", { class: "row" },
        h("span", { class: "rank", text: String(i + 1).padStart(2, "0") }),
        h("div", {},
          h("div", { class: "line1" },
            h("a", { class: "title", href, target: "_blank", rel: "noopener", text: item.title }),
            h("span", { class: "chip host", title: item.host || "", text: item.host || "news.ycombinator.com" }),
          ),
          meta,
        ),
      );
    }),
  );
}

function render() {
  const { phase } = state.status;
  const busy = BUSY.has(phase) || localBusy !== null;
  const hasItems = state.items.length > 0;
  const refreshing = phase === "awaiting-approval" || phase === "fetching" || localBusy === "refresh";
  const summarizing = phase === "summarizing" || localBusy === "summarize";

  rule.classList.toggle("busy", busy);
  metaLine.textContent = [
    state.fetchedAt ? `fetched ${ago(state.fetchedAt)}` : "not fetched yet",
    PHASE_LABEL[phase],
  ].filter(Boolean).join(" · ");

  refreshBtn.disabled = busy;
  refreshBtn.textContent = refreshing ? "Refreshing…" : "Refresh";
  summarizeBtn.disabled = busy || !hasItems;
  summarizeBtn.textContent = summarizing ? "Summarizing…" : "Summarize with AI";
  fetchBtn.disabled = busy;
  fetchBtn.textContent = phase === "awaiting-approval" ? "Waiting for approval…" : refreshing ? "Fetching…" : "Fetch front page";

  waitBanner.hidden = phase !== "awaiting-approval";

  const error = currentError();
  errorBanner.hidden = !error || error === dismissedError;
  if (error) {
    const denied = /^denied\b/i.test(error);
    errorTitle.textContent = denied ? "Request denied" : "Request failed";
    errorText.textContent = denied ? error.replace(/^denied\b[:.\s-]*/i, "") || "A person denied the request." : error;
  }

  const bullets = state.summary ? bulletsOf(state.summary) : [];
  summaryBox.hidden = bullets.length === 0 || !hasItems;
  summaryList.replaceChildren(...bullets.map((line) => h("li", { text: line })));

  emptyBox.hidden = hasItems;
  list.hidden = !hasItems;
  renderList();
}

async function run(kind) {
  if (localBusy || BUSY.has(state.status.phase)) return;
  localBusy = kind;
  localError = null;
  dismissedError = null;
  render();
  try {
    const next = kind === "refresh" ? await gadget.refresh() : await gadget.summarize();
    if (next && typeof next === "object") state = normalize(next);
  } catch (err) {
    localError = messageOf(err);
  } finally {
    localBusy = null;
    render();
  }
}

class Listener extends RpcTarget {
  stateChanged(next) {
    state = normalize(next);
    if (BUSY.has(state.status.phase)) {
      localError = null;
      dismissedError = null;
    }
    render();
  }
}

/* ----------------------------------------------------------------- boot */

render();
setInterval(render, 30_000);

try {
  // Subscribe first, so no change can fall between the snapshot and the live stream.
  await gadget.subscribe(new Listener());
  state = normalize(await gadget.getState());
  render();
} catch (err) {
  localError = `The gadget did not load. ${messageOf(err)}`;
  render();
}
