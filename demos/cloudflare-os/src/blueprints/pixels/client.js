// Pixel Board client. The shell injects the globals `gadget`, `RpcTarget` and `gadgetInfo`.

const SIZE = 32;
const CELLS = SIZE * SIZE;
const EMPTY = -1;
const FLUSH_MS = 60;
const CLEAR_CONFIRM_MS = 3000;
const GRID_MIN_CELL_CSS = 12;
const COLOR_NAMES = [
  "Ember", "Ember light", "Amber", "Green", "Teal", "Blue",
  "Violet", "Red", "Bone", "Grey", "Graphite", "Ink",
];

const viewerName = String((gadgetInfo && gadgetInfo.viewer && gadgetInfo.viewer.name) || "anonymous").slice(0, 40);

/* ---------------------------------------------------------------- styles */

const style = document.createElement("style");
style.textContent = `
[hidden] { display: none !important; }
body { overflow: auto; }
.app {
  height: 100%; display: grid; gap: 24px; padding: 20px;
  grid-template-columns: minmax(0, 1fr) 244px; grid-template-rows: minmax(0, 1fr);
}
.stage { min-width: 0; min-height: 0; display: flex; align-items: center; justify-content: center; }
.board {
  display: block; touch-action: none; cursor: crosshair; user-select: none; -webkit-user-select: none;
  outline: 1px solid var(--border-strong); image-rendering: pixelated;
}
.board.erasing { cursor: cell; }
.panel { min-width: 0; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; padding: 4px 2px; }
.panel-head { display: flex; flex-direction: column; gap: 8px; }
.panel-head h1 { font-size: 22px; line-height: 1.1; }
.coords { font: 12px/1 var(--font-mono); color: var(--muted); font-variant-numeric: tabular-nums; white-space: pre; }
.coords.active { color: var(--text-strong); }
.section { display: flex; flex-direction: column; gap: 10px; }
.label { font: 500 11px/1 var(--font-mono); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
.swatches { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; }
.swatch {
  aspect-ratio: 1; width: 100%; padding: 0; border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
}
.swatch:hover { border-color: var(--text-strong); }
.swatch[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--bg), 0 0 0 3.5px var(--text-strong); }
.seg {
  display: grid; grid-template-columns: 1fr 1fr; gap: 2px; padding: 2px;
  border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
}
.seg button {
  border: 0; border-radius: 4px; padding: .45em .6em; background: transparent;
  color: var(--muted); font-weight: 600; font-size: 13px;
}
.seg button:hover { color: var(--text-strong); }
.seg button[aria-pressed="true"] { background: var(--ember-soft); color: var(--accent-text); }
.swatch:focus-visible, .seg button:focus-visible, .btn:focus-visible { outline: 2px solid var(--ember); outline-offset: 2px; }
.hint { margin: 0; font-size: 12px; color: var(--muted); }
.stat { display: flex; align-items: baseline; gap: 8px; }
.stat-value { font: 600 26px/1 var(--font-heading); color: var(--text-strong); letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.stat-label { font: 12px/1 var(--font-mono); color: var(--muted); }
.contributors { display: flex; flex-wrap: wrap; gap: 6px; }
.contributors .chip { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.contributors .chip.me { border-color: var(--ember); color: var(--accent-text); }
.muted-note { margin: 0; font-size: 13px; color: var(--muted); }
.clear { justify-content: center; }
.clear.armed { border-color: var(--danger); color: var(--danger); }
.clear:disabled { opacity: .5; cursor: not-allowed; }
.error { margin: 0; padding-left: 10px; border-left: 2px solid var(--danger); font-size: 13px; color: var(--danger); overflow-wrap: anywhere; }
.note {
  margin: auto 0 0; padding-top: 12px; border-top: 1px solid var(--border);
  font: 11px/1.6 var(--font-mono); color: var(--muted);
}
@media (max-width: 640px) {
  .app { height: auto; gap: 18px; padding: 14px; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto; }
  .stage { display: block; }
  .board { margin: 1px auto; }
  .panel { overflow: visible; }
  .note { margin-top: 0; }
}
@media (min-width: 420px) and (max-width: 640px) {
  .swatches { grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 6px; }
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

const canvas = h("canvas", { class: "board", role: "img", "aria-label": "Shared 32 by 32 pixel board" });
const ctx = canvas.getContext("2d");
const stage = h("div", { class: "stage" }, canvas);
const NO_COORDS = "x  – · y  –";
const coords = h("span", { class: "coords", text: NO_COORDS, "aria-live": "off" });
const swatches = h("div", { class: "swatches", role: "group", "aria-label": "Colour" });
const paintBtn = h("button", { type: "button", title: "Paint (P)", text: "Paint", onclick: () => setTool("paint") });
const eraseBtn = h("button", { type: "button", title: "Erase (E)", text: "Erase", onclick: () => setTool("erase") });
const paintedValue = h("span", { class: "stat-value", text: "0" });
const contributorsList = h("div", { class: "contributors" });
const clearBtn = h("button", { type: "button", class: "btn clear", text: "Clear board", onclick: onClear });
const errorLine = h("p", { class: "error", role: "status", hidden: true });

document.body.append(
  h("div", { class: "app" },
    stage,
    h("aside", { class: "panel" },
      h("header", { class: "panel-head" },
        h("span", { class: "eyebrow", text: "Shared canvas" }),
        h("h1", { text: "Pixel Board" }),
        coords,
      ),
      h("div", { class: "section" }, h("span", { class: "label", text: "Colour" }), swatches),
      h("div", { class: "section" },
        h("span", { class: "label", text: "Tool" }),
        h("div", { class: "seg", role: "group", "aria-label": "Tool" }, paintBtn, eraseBtn),
        h("p", { class: "hint", text: "Drag to draw. Right-click erases with either tool." }),
      ),
      h("div", { class: "section" },
        h("span", { class: "label", text: "Board" }),
        h("div", { class: "stat" }, paintedValue, h("span", { class: "stat-label", text: `painted of ${CELLS}` })),
        contributorsList,
      ),
      clearBtn,
      errorLine,
      h("p", { class: "note", text: "Every stroke is a Cap'n Web call into this gadget's Durable Object facet." }),
    ),
  ),
);

/* ----------------------------------------------------------------- state */

const pixels = new Int8Array(CELLS).fill(EMPTY);
let palette = [];
let contributors = [];
let selected = 0;
let tool = "paint";
let hover = null;
let stroke = null;

// Local cells not yet sent (idx -> color), and cells sent but not yet acknowledged (idx -> count).
const pending = new Map();
const unacked = new Map();
let flushTimer = 0;
let maybeStale = false;
let resyncing = false;

let dpr = 1;
let cellDev = 0;
let tokens = {};

/* --------------------------------------------------------------- drawing */

function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  tokens = {
    empty: v("--surface-2", "#1d1d22"),
    grid: v("--border", "rgba(255,255,255,.08)"),
    strong: v("--text-strong", "#e8e8e4"),
  };
}

const narrowQuery = window.matchMedia("(max-width: 640px)");

function layout() {
  dpr = window.devicePixelRatio || 1;
  const narrow = narrowQuery.matches;
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  const avail = Math.max(SIZE * 2, (narrow ? Math.min(width, 640) : Math.min(width, height)) - 2);
  const nextCell = Math.max(1, Math.floor((avail * dpr) / SIZE));
  const dev = nextCell * SIZE;
  if (nextCell === cellDev && canvas.width === dev && canvas.dataset.dpr === String(dpr)) return;
  cellDev = nextCell;
  canvas.width = dev;
  canvas.height = dev;
  canvas.dataset.dpr = String(dpr);
  canvas.style.width = `${dev / dpr}px`;
  canvas.style.height = `${dev / dpr}px`;
  draw();
}

let drawQueued = false;
function scheduleDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(draw);
}

function draw() {
  drawQueued = false;
  const c = cellDev;
  if (!c) return;
  const n = c * SIZE;
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = 1;
  ctx.fillStyle = tokens.empty;
  ctx.fillRect(0, 0, n, n);

  for (let i = 0; i < CELLS; i++) {
    const color = palette[pixels[i]];
    if (!color) continue;
    ctx.fillStyle = color;
    ctx.fillRect((i % SIZE) * c, Math.floor(i / SIZE) * c, c, c);
  }

  if (c / dpr >= GRID_MIN_CELL_CSS) {
    ctx.fillStyle = tokens.grid;
    for (let k = 1; k < SIZE; k++) {
      ctx.fillRect(k * c, 0, 1, n);
      ctx.fillRect(0, k * c, n, 1);
    }
  }

  if (hover) {
    const x = hover.x * c;
    const y = hover.y * c;
    if (!stroke) {
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = tool === "erase" ? tokens.empty : palette[selected] || tokens.empty;
      ctx.fillRect(x, y, c, c);
      ctx.globalAlpha = 1;
    }
    const lw = Math.max(1, Math.round(dpr));
    ctx.lineWidth = lw;
    ctx.strokeStyle = tokens.strong;
    ctx.strokeRect(x + lw / 2, y + lw / 2, c - lw, c - lw);
  }
}

/* ------------------------------------------------------------------- ui */

function renderSwatches() {
  swatches.replaceChildren(
    ...palette.map((hex, i) => {
      const name = COLOR_NAMES[i] || `Colour ${i}`;
      const button = h("button", {
        type: "button",
        class: "swatch",
        title: `${name} (${i})`,
        "aria-label": name,
        "aria-pressed": String(i === selected),
        onclick: () => {
          selected = i;
          setTool("paint");
          updateSwatches();
        },
      });
      button.style.backgroundColor = hex;
      return button;
    }),
  );
}

function updateSwatches() {
  swatches.querySelectorAll(".swatch").forEach((node, i) => node.setAttribute("aria-pressed", String(i === selected)));
  scheduleDraw();
}

function setTool(next) {
  tool = next;
  paintBtn.setAttribute("aria-pressed", String(tool === "paint"));
  eraseBtn.setAttribute("aria-pressed", String(tool === "erase"));
  canvas.classList.toggle("erasing", tool === "erase");
  scheduleDraw();
}

function updateStats() {
  let painted = 0;
  for (let i = 0; i < CELLS; i++) if (pixels[i] !== EMPTY) painted++;
  paintedValue.textContent = String(painted);
  if (contributors.length === 0) {
    contributorsList.replaceChildren(h("p", { class: "muted-note", text: "Nobody has painted yet." }));
  } else {
    contributorsList.replaceChildren(
      ...contributors.map((name) => h("span", { class: name === viewerName ? "chip me" : "chip", title: name, text: name })),
    );
  }
}

function setHover(cell) {
  const same = hover && cell && hover.x === cell.x && hover.y === cell.y;
  if (same || (!hover && !cell)) return;
  hover = cell;
  coords.textContent = cell
    ? `x ${String(cell.x).padStart(2, " ")} · y ${String(cell.y).padStart(2, " ")}`
    : NO_COORDS;
  coords.classList.toggle("active", Boolean(cell));
  scheduleDraw();
}

let errorTimer = 0;
function showError(message) {
  errorLine.textContent = message;
  errorLine.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { errorLine.hidden = true; }, 6000);
}

const messageOf = (err) => (err && err.message) || String(err);

/* ------------------------------------------------------------ painting */

function cellAt(event) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const fx = (event.clientX - rect.left) / rect.width;
  const fy = (event.clientY - rect.top) / rect.height;
  if (fx < 0 || fy < 0 || fx >= 1 || fy >= 1) return null;
  return { x: Math.floor(fx * SIZE), y: Math.floor(fy * SIZE) };
}

function eachCellOnLine(a, b, fn) {
  let x0 = a.x;
  let y0 = a.y;
  const dx = Math.abs(b.x - x0);
  const dy = -Math.abs(b.y - y0);
  const sx = x0 < b.x ? 1 : -1;
  const sy = y0 < b.y ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    fn(x0, y0);
    if (x0 === b.x && y0 === b.y) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

function paintCell(x, y, color) {
  const idx = y * SIZE + x;
  if (pixels[idx] === color) return;
  pixels[idx] = color;
  pending.set(idx, color);
  if (color !== EMPTY && contributors[0] !== viewerName) {
    contributors = [viewerName, ...contributors.filter((name) => name !== viewerName)].slice(0, 20);
  }
  updateStats();
  scheduleDraw();
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

function flush() {
  clearTimeout(flushTimer);
  flushTimer = 0;
  if (pending.size === 0) return;
  const batch = [...pending];
  pending.clear();
  send(batch);
}

async function send(batch) {
  for (const [idx] of batch) unacked.set(idx, (unacked.get(idx) || 0) + 1);
  const points = batch.map(([idx, color]) => ({ x: idx % SIZE, y: Math.floor(idx / SIZE), color }));
  try {
    await gadget.paintMany(points, viewerName);
  } catch (err) {
    showError(`A stroke did not save. ${messageOf(err)}`);
    maybeStale = true;
  } finally {
    for (const [idx] of batch) {
      const left = (unacked.get(idx) || 1) - 1;
      if (left > 0) unacked.set(idx, left);
      else unacked.delete(idx);
    }
    if (maybeStale && unacked.size === 0 && pending.size === 0) resync();
  }
}

function endStroke(event) {
  if (!stroke || (event && event.pointerId !== stroke.pointerId)) return;
  stroke = null;
  flush();
  scheduleDraw();
}

canvas.addEventListener("pointerdown", (event) => {
  if (stroke || (event.button !== 0 && event.button !== 2)) return;
  const cell = cellAt(event);
  if (!cell || !palette.length) return;
  event.preventDefault();
  const color = event.button === 2 || tool === "erase" ? EMPTY : selected;
  stroke = { pointerId: event.pointerId, color, last: cell };
  try { canvas.setPointerCapture(event.pointerId); } catch {}
  setHover(cell);
  paintCell(cell.x, cell.y, color);
});

canvas.addEventListener("pointermove", (event) => {
  const cell = cellAt(event);
  setHover(cell);
  if (!stroke || event.pointerId !== stroke.pointerId) return;
  if (!cell) {
    stroke.last = null;
    return;
  }
  const from = stroke.last || cell;
  eachCellOnLine(from, cell, (x, y) => paintCell(x, y, stroke.color));
  stroke.last = cell;
});

canvas.addEventListener("pointerup", endStroke);
canvas.addEventListener("pointercancel", endStroke);
canvas.addEventListener("lostpointercapture", endStroke);
canvas.addEventListener("pointerleave", () => { if (!stroke) setHover(null); });
canvas.addEventListener("contextmenu", (event) => event.preventDefault());

document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === "p" || key === "b") setTool("paint");
  else if (key === "e") setTool("erase");
});

/* ---------------------------------------------------------------- clear */

let clearArmTimer = 0;
function disarmClear() {
  clearTimeout(clearArmTimer);
  clearArmTimer = 0;
  clearBtn.classList.remove("armed");
  clearBtn.textContent = "Clear board";
}

async function onClear() {
  if (!clearArmTimer) {
    clearBtn.classList.add("armed");
    clearBtn.textContent = "Click again to clear";
    clearArmTimer = setTimeout(disarmClear, CLEAR_CONFIRM_MS);
    return;
  }
  disarmClear();
  clearTimeout(flushTimer);
  flushTimer = 0;
  pending.clear();
  pixels.fill(EMPTY);
  contributors = [];
  updateStats();
  scheduleDraw();
  clearBtn.disabled = true;
  try {
    await gadget.clear();
  } catch (err) {
    showError(`The board did not clear. ${messageOf(err)}`);
    resync();
  } finally {
    clearBtn.disabled = false;
  }
}

/* ----------------------------------------------------------------- sync */

function cleanContributors(list) {
  return Array.isArray(list) ? list.filter((name) => typeof name === "string").slice(0, 20) : [];
}

function loadBoard(board) {
  if (!board || !Array.isArray(board.pixels)) return;
  if (Array.isArray(board.palette)) {
    const next = board.palette.map(String);
    if (next.join() !== palette.join()) {
      palette = next;
      if (selected >= palette.length) selected = 0;
      renderSwatches();
    }
  }
  for (let i = 0; i < CELLS; i++) {
    if (pending.has(i) || unacked.has(i)) continue;
    const value = board.pixels[i];
    pixels[i] = Number.isInteger(value) && value >= EMPTY && value < palette.length ? value : EMPTY;
  }
  contributors = cleanContributors(board.contributors);
  updateStats();
  scheduleDraw();
}

async function resync() {
  if (resyncing) return;
  resyncing = true;
  maybeStale = false;
  try {
    loadBoard(await gadget.getBoard());
  } catch (err) {
    showError(`The board did not reload. ${messageOf(err)}`);
  } finally {
    resyncing = false;
  }
}

class Listener extends RpcTarget {
  pixelsChanged(message) {
    if (!message || !Array.isArray(message.changes)) return;
    for (const change of message.changes) {
      const idx = change && change.idx;
      const color = change && change.color;
      if (!Number.isInteger(idx) || idx < 0 || idx >= CELLS || !Number.isInteger(color)) continue;
      // A local write for this cell is still queued or in flight. The server applies it after this change.
      if (pending.has(idx)) continue;
      if (unacked.has(idx)) {
        if (pixels[idx] !== color) maybeStale = true;
        continue;
      }
      pixels[idx] = color >= EMPTY && color < palette.length ? color : EMPTY;
    }
    contributors = cleanContributors(message.contributors);
    updateStats();
    scheduleDraw();
  }

  boardCleared() {
    for (let i = 0; i < CELLS; i++) {
      if (pending.has(i)) continue;
      if (unacked.has(i)) {
        if (pixels[i] !== EMPTY) maybeStale = true;
        continue;
      }
      pixels[i] = EMPTY;
    }
    contributors = [];
    updateStats();
    scheduleDraw();
  }
}

/* ----------------------------------------------------------------- boot */

readTokens();
new MutationObserver(() => { readTokens(); scheduleDraw(); })
  .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
// Defer to the next frame. A canvas resize inside the observer callback causes a loop warning.
let layoutQueued = false;
new ResizeObserver(() => {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => { layoutQueued = false; layout(); });
}).observe(stage);
narrowQuery.addEventListener("change", layout);
setTool("paint");
updateStats();
layout();

try {
  // Subscribe first, so no change can fall between the snapshot and the live stream.
  await gadget.subscribe(new Listener());
  loadBoard(await gadget.getBoard());
} catch (err) {
  showError(`The board did not load. ${messageOf(err)}`);
}
