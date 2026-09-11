// Tic-tac-toe gadget client. Globals: gadget, RpcTarget, gadgetInfo.

const NS = "http://www.w3.org/2000/svg";
const viewerName = gadgetInfo && gadgetInfo.viewer && typeof gadgetInfo.viewer.name === "string" ? gadgetInfo.viewer.name : "";

const CSS = `
body { overflow: auto; }
.ttt { --cell: clamp(60px, calc(min(80vw, 60vh, 100vh - 320px) / 3), 148px); --line: 2px;
  min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 18px; padding: 24px 16px 28px; text-align: center; }
.head { display: flex; flex-direction: column; align-items: center; gap: 10px; }
.status { min-height: 1.1em;
  font: 700 clamp(22px, 5.2vw, 32px)/1.1 var(--font-heading); letter-spacing: -0.025em; color: var(--text-strong); }
.status .who-x { color: var(--accent-text); }
.status .who-o { color: var(--text-strong); }

.board-wrap { position: relative; }
.board { display: grid; grid-template-columns: repeat(3, var(--cell)); grid-template-rows: repeat(3, var(--cell));
  gap: var(--line); background: var(--border-strong); }
.cell { position: relative; display: grid; place-items: center; padding: 0; border: 0; background: var(--bg); color: inherit;
  transition: background-color .12s ease; }
.cell:disabled { cursor: default; }
.cell.open:hover { background: var(--surface); }
.cell:focus-visible { outline: 2px solid var(--ember); outline-offset: -2px; z-index: 1; }

.mark, .ghost { width: 62%; height: 62%; overflow: visible; fill: none; stroke-width: 9; stroke-linecap: round; }
.mark { transition: opacity .25s ease; }
.mark-x { stroke: var(--ember); }
.mark-o { stroke: var(--text-strong); }
.mark.draw path, .mark.draw circle { stroke-dasharray: 1; animation: stroke .26s cubic-bezier(.4, 0, .2, 1) both; }
.mark.draw path + path { animation-delay: .12s; }
@keyframes stroke { from { stroke-dashoffset: 1; opacity: 0; } 1% { opacity: 1; } to { stroke-dashoffset: 0; opacity: 1; } }
.ghost { position: absolute; top: 19%; left: 19%; opacity: 0; transition: opacity .12s ease; }
.board.turn-x .cell.open:hover .ghost-x, .board.turn-o .cell.open:hover .ghost-o,
.board.turn-x .cell.hint .ghost-x, .board.turn-o .cell.hint .ghost-o { opacity: .28; }
.board.over .cell:not(.win) .mark { opacity: .32; }

.cell.hint::after { content: ""; position: absolute; inset: 8px; border: 2px solid var(--ember); border-radius: var(--radius-sm);
  animation: pulse 1.6s ease-out both; pointer-events: none; }
@keyframes pulse { 0% { opacity: 0; transform: scale(.86); } 18% { opacity: 1; transform: scale(1); }
  45% { opacity: .3; } 70% { opacity: 1; } 100% { opacity: 0; } }

.win-line { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
.win-line line { stroke: var(--ember); stroke-width: 7; stroke-linecap: round; stroke-dasharray: 1;
  animation: stroke .38s cubic-bezier(.4, 0, .2, 1) .12s both; }

.scores { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
.score { display: inline-flex; align-items: center; gap: 7px; padding: .4em .8em; color: var(--text); transition: border-color .15s ease; }
.score b { font-weight: 600; color: var(--text-strong); font-variant-numeric: tabular-nums; }
.score svg { width: 10px; height: 10px; fill: none; stroke-width: 14; stroke-linecap: round; }
.score.turn { border-color: var(--ember); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.actions { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 8px; }
.btn:disabled { opacity: .45; cursor: default; border-color: var(--border-strong); }
.btn-quiet { padding: .45em .5em; border: 0; background: transparent; color: var(--muted); font: 12px/1 var(--font-mono); }
.btn-quiet:hover { color: var(--text-strong); }
button:focus-visible { outline: 2px solid var(--ember); outline-offset: 2px; }

.caption, .note, .error { margin: 0; font: 12px/1.5 var(--font-mono); }
.caption { color: var(--text); min-height: 1.5em; }
.note { max-width: 44ch; color: var(--muted); font-size: 11px; }
.error { min-height: 1.5em; color: var(--danger); }

@media (prefers-reduced-motion: reduce) {
  .mark.draw path, .mark.draw circle, .win-line line { animation: none; stroke-dasharray: none; }
  .cell.hint::after { animation: none; }
  .cell, .mark, .ghost, .score { transition: none; }
}
`;

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) el.append(child);
  return el;
}

function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  el.append(...children);
  return el;
}

function markSvg(player, cls) {
  if (player === "X") {
    return s("svg", { class: `${cls} mark-x`, viewBox: "0 0 100 100", "aria-hidden": "true" },
      s("path", { d: "M24 24L76 76", pathLength: 1 }),
      s("path", { d: "M76 24L24 76", pathLength: 1 }));
  }
  return s("svg", { class: `${cls} mark-o`, viewBox: "0 0 100 100", "aria-hidden": "true" },
    s("circle", { cx: 50, cy: 50, r: 28, pathLength: 1, transform: "rotate(-90 50 50)" }));
}

function smallMark(player) {
  const svg = markSvg(player, "");
  svg.setAttribute("class", player === "X" ? "mark-x" : "mark-o");
  return svg;
}

const errorText = (err) =>
  String(err && err.message ? err.message : err || "The request failed").replace(/^Error:\s*/, "");

// ---------- Shell ----------

document.head.append(h("style", { text: CSS }));

const eyebrow = h("div", { class: "eyebrow" });
const status = h("h1", { class: "status", "aria-live": "polite" });
const board = h("div", { class: "board", role: "group", "aria-label": "Tic-tac-toe board" });
const winLayer = s("svg", { class: "win-line", viewBox: "0 0 300 300", "aria-hidden": "true" });
const cells = Array.from({ length: 9 }, (_, i) => {
  const cell = h("button", { class: "cell", type: "button", "data-index": i, onclick: () => play(i) });
  board.append(cell);
  return cell;
});
const scoreX = h("b", { text: "0" });
const scoreDraw = h("b", { text: "0" });
const scoreO = h("b", { text: "0" });
const chipX = h("span", { class: "chip score" }, smallMark("X"), h("span", { class: "sr", text: "X wins" }), scoreX);
const chipDraw = h("span", { class: "chip score" }, "Draw", scoreDraw);
const chipO = h("span", { class: "chip score" }, smallMark("O"), h("span", { class: "sr", text: "O wins" }), scoreO);
const newGame = h("button", { class: "btn", type: "button", onclick: () => run(() => gadget.reset()) }, "New game");
const hint = h("button", { class: "btn", type: "button", onclick: () => showHint() }, "Hint");
const resetScores = h("button", { class: "btn-quiet", type: "button", onclick: () => run(() => gadget.resetScores()) }, "Reset scores");
const caption = h("p", { class: "caption" });
const error = h("p", { class: "error", role: "alert" });

document.body.append(
  h("main", { class: "ttt" },
    h("div", { class: "head" }, eyebrow, status),
    h("div", { class: "board-wrap" }, board, winLayer),
    h("div", { class: "scores", "aria-label": "Scores" }, chipX, chipDraw, chipO),
    h("div", { class: "actions" }, newGame, hint, resetScores),
    caption,
    h("p", { class: "note", text: "State lives in this gadget's facet SQLite. Open this workspace in a second tab to play against yourself." }),
    error));

// ---------- State and rendering ----------

let state = null;
let shown = Array(9).fill(null); // What each cell shows now. null means "not rendered yet".
let shownLine = "";
let busy = false;
let errorTimer = 0;
let hintTimer = 0;

function showError(message) {
  error.textContent = message;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { error.textContent = ""; }, 3500);
}

function renderStatus() {
  const who = (p) => h("span", { class: p === "X" ? "who-x" : "who-o", text: p });
  if (state.winner === "draw") {
    eyebrow.textContent = "Game over";
    status.replaceChildren("Draw");
  } else if (state.winner) {
    eyebrow.textContent = "Game over";
    status.replaceChildren(who(state.winner), " wins");
  } else {
    eyebrow.textContent = `Move ${state.moves + 1}`;
    status.replaceChildren(who(state.turn), " to move");
  }
}

function renderBoard(animate) {
  const over = Boolean(state.winner);
  board.classList.toggle("over", over);
  board.classList.toggle("turn-x", !over && state.turn === "X");
  board.classList.toggle("turn-o", !over && state.turn === "O");
  const winning = new Set(state.line);
  state.board.forEach((value, i) => {
    const cell = cells[i];
    const open = !value && !over;
    cell.disabled = !open;
    cell.classList.toggle("open", open);
    cell.classList.toggle("win", winning.has(i));
    const row = Math.floor(i / 3) + 1;
    const col = (i % 3) + 1;
    cell.setAttribute("aria-label", `Cell ${i}, row ${row}, column ${col}: ${value || "empty"}`);
    if (shown[i] === value) return;
    if (value) cell.replaceChildren(markSvg(value, animate ? "mark draw" : "mark"));
    else cell.replaceChildren(markSvg("X", "ghost ghost-x"), markSvg("O", "ghost ghost-o"));
    shown[i] = value;
  });

  const lineKey = state.line.join(",");
  if (lineKey !== shownLine) {
    shownLine = lineKey;
    winLayer.replaceChildren();
    if (state.line.length === 3) {
      const center = (i) => [(i % 3) * 100 + 50, Math.floor(i / 3) * 100 + 50];
      const [x1, y1] = center(state.line[0]);
      const [x2, y2] = center(state.line[2]);
      const len = Math.hypot(x2 - x1, y2 - y1);
      const dx = ((x2 - x1) / len) * 32;
      const dy = ((y2 - y1) / len) * 32;
      winLayer.append(s("line", { x1: x1 - dx, y1: y1 - dy, x2: x2 + dx, y2: y2 + dy, pathLength: 1 }));
    }
  }
}

function renderMeta() {
  scoreX.textContent = String(state.scores.X);
  scoreO.textContent = String(state.scores.O);
  scoreDraw.textContent = String(state.scores.draw);
  chipX.classList.toggle("turn", !state.winner && state.turn === "X");
  chipO.classList.toggle("turn", !state.winner && state.turn === "O");
  const over = Boolean(state.winner);
  newGame.className = over ? "btn btn-primary" : "btn";
  hint.disabled = over;
  const last = state.lastMove;
  caption.textContent = last
    ? `last move: ${last.player} at ${last.index}${last.by ? ` by ${last.by}` : ""}`
    : "last move: none";
}

function render(next, animate = true) {
  state = next;
  renderStatus();
  renderBoard(animate);
  renderMeta();
  if (state.winner || state.board.some((v, i) => v && cells[i].classList.contains("hint"))) clearHint();
}

// ---------- Actions ----------

async function run(fn) {
  if (busy) return;
  busy = true;
  try {
    const next = await fn();
    if (next && Array.isArray(next.board)) render(next);
  } catch (err) {
    showError(errorText(err));
    try { render(await gadget.getState()); } catch { /* keep the last state */ }
  } finally {
    busy = false;
  }
}

function play(index) {
  if (!state || state.winner || state.board[index]) return;
  clearHint();
  run(() => gadget.move(index, viewerName));
}

function clearHint() {
  clearTimeout(hintTimer);
  for (const cell of cells) cell.classList.remove("hint");
}

async function showHint() {
  if (!state || state.winner) return;
  try {
    const index = await gadget.bestMove();
    clearHint();
    if (!Number.isInteger(index) || index < 0 || index > 8) return;
    void cells[index].offsetWidth; // Restart the pulse animation.
    cells[index].classList.add("hint");
    hintTimer = setTimeout(clearHint, 1700);
  } catch (err) {
    showError(errorText(err));
  }
}

board.addEventListener("keydown", (e) => {
  const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 };
  if (!(e.key in moves)) return;
  const from = cells.indexOf(document.activeElement);
  if (from < 0) return;
  e.preventDefault();
  const step = moves[e.key];
  // Walk in the arrow direction and stop at the first open cell. Taken cells are disabled.
  for (let to = from + step; to >= 0 && to <= 8; to += step) {
    if (Math.abs(step) === 1 && Math.floor(to / 3) !== Math.floor(from / 3)) break;
    if (!cells[to].disabled) {
      cells[to].focus();
      break;
    }
  }
});

// ---------- Live sync ----------

class Listener extends RpcTarget {
  stateChanged(next) {
    render(next);
  }
}

try {
  render(await gadget.getState(), false);
  await gadget.subscribe(new Listener());
} catch (err) {
  showError(`Could not load the game: ${errorText(err)}`);
}
