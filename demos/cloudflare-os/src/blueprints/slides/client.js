// Slides gadget client. Globals: gadget, RpcTarget, gadgetInfo.

const MAX_SLIDES = 30;
const MAX_BULLETS = 12;
const LAYOUTS = [
  { id: "title", label: "Title", icon: ["M2.5 3.5h11v9h-11z", "M4.5 7.5h7", "M4.5 10h4"] },
  { id: "bullets", label: "Bullets", icon: ["M2.5 3.5h11v9h-11z", "M4.5 6.5h1", "M7 6.5h4.5", "M4.5 9.5h1", "M7 9.5h4.5"] },
  { id: "quote", label: "Quote", icon: ["M2.5 3.5h11v9h-11z", "M5 6v4", "M7 6.5h4.5", "M7 9.5h3"] },
  { id: "stat", label: "Stat", icon: ["M2.5 3.5h11v9h-11z", "M5 5.5h3.5v3H5z", "M5 10.5h6"] },
];
const ICONS = {
  up: ["M8 12.5v-9", "M4.5 7l3.5-3.5L11.5 7"],
  down: ["M8 3.5v9", "M4.5 9l3.5 3.5L11.5 9"],
  trash: ["M3 4.5h10", "M6.5 4.5V3h3v1.5", "M4.5 4.5l.6 8.5h5.8l.6-8.5"],
  plus: ["M8 3.5v9", "M3.5 8h9"],
  play: ["M5.5 3.5v9l6.5-4.5z"],
  close: ["M4.5 4.5l7 7", "M11.5 4.5l-7 7"],
};

const CSS = `
body { overflow: hidden; }
.app { display: grid; grid-template-rows: auto minmax(0, 1fr); height: 100%; }

.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 8px 12px;
  background: var(--surface); border-bottom: 1px solid var(--border); }
.tb-deck { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1 1 180px; }
.deck-title { min-width: 2ch; max-width: 100%; padding: 4px 7px; border-radius: var(--radius-sm);
  font: 600 14px/1.3 var(--font-heading); letter-spacing: -0.01em; color: var(--text-strong);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; outline: none; cursor: text; }
.deck-title:hover { box-shadow: inset 0 0 0 1px var(--border-strong); }
.deck-title:focus { box-shadow: inset 0 0 0 1px var(--ember); text-overflow: clip; }
.counter { flex: none; font-variant-numeric: tabular-nums; }
.tb-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.layouts { display: inline-flex; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); overflow: hidden; }
.layouts button { display: inline-flex; align-items: center; gap: 5px; padding: 5px 9px; border: 0; background: transparent;
  color: var(--muted); font: 500 12px/1 var(--font-body); }
.layouts button + button { border-left: 1px solid var(--border); }
.layouts button:hover { color: var(--text-strong); }
.layouts button[aria-pressed="true"] { background: var(--ember-soft); color: var(--accent-text); }
.btn svg, .layouts svg { flex: none; }
button:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--ember); outline-offset: 2px; }

.main { display: grid; grid-template-columns: 188px minmax(0, 1fr); min-height: 0; }
.rail { min-height: 0; overflow-y: auto; padding: 12px 10px 24px 6px; border-right: 1px solid var(--border); background: var(--bg); }
.thumbs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.thumb { position: relative; display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 6px; align-items: start; }
.thumb-num { padding-top: 5px; text-align: right; font: 11px/1 var(--font-mono); color: var(--muted); font-variant-numeric: tabular-nums; }
.thumb.active .thumb-num { color: var(--accent-text); }
.thumb-main { display: block; width: 100%; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--surface); overflow: hidden; }
.thumb-main:hover { border-color: var(--border-strong); }
.thumb.active .thumb-main { border-color: var(--ember); box-shadow: 0 0 0 1px var(--ember); }
.thumb-actions { position: absolute; top: 5px; right: 5px; display: flex; gap: 3px; opacity: 0; transition: opacity .12s ease; }
.thumb:hover .thumb-actions, .thumb:focus-within .thumb-actions { opacity: 1; }
@media (hover: none) { .thumb.active .thumb-actions { opacity: 1; } }
.thumb-actions button { display: grid; place-items: center; width: 22px; height: 22px; padding: 0; border-radius: 5px;
  border: 1px solid var(--border-strong); background: var(--surface); color: var(--text-strong); }
.thumb-actions button:hover { border-color: var(--ember); color: var(--accent-text); }
.thumb-actions button.danger:hover { border-color: var(--danger); color: var(--danger); }
.thumb-actions button:disabled { opacity: .4; cursor: default; border-color: var(--border); color: var(--muted); }

.stage-wrap { position: relative; container-type: size; min-width: 0; min-height: 0; display: grid; place-items: center;
  padding: clamp(12px, 3.5vw, 36px); outline: none; }
.slide { position: relative; aspect-ratio: 16 / 9; container-type: inline-size; overflow: hidden; text-align: left;
  background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); }
.stage { width: min(100cqw, calc(100cqh * 16 / 9)); }
.thumb-main .slide { width: 100%; border: 0; border-radius: 0; pointer-events: none; }

.slide-body { position: absolute; inset: 0; display: flex; flex-direction: column; padding: 7cqi 8cqi 9cqi; }
.slide-body.enter { animation: enter .22s ease-out; }
@keyframes enter { from { opacity: 0; transform: translateY(.6cqi); } }
.s-foot { position: absolute; left: 8cqi; right: 8cqi; bottom: 3.4cqi; font: 400 1.3cqi/1 var(--font-mono);
  letter-spacing: .04em; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.s-progress { position: absolute; left: 0; bottom: 0; height: max(2px, .25cqi); background: var(--ember); transition: width .25s ease; }
.s-eyebrow { position: absolute; top: 6cqi; left: 8cqi; right: 8cqi; font: 500 1.4cqi/1.2 var(--font-mono);
  letter-spacing: .14em; text-transform: uppercase; color: var(--accent-text); }

.l-title { justify-content: flex-end; padding-bottom: 13cqi; }
.l-title .s-title { max-width: 86%; font: 700 7.2cqi/1.02 var(--font-heading); letter-spacing: -0.035em; color: var(--text-strong); }
.s-rule { flex: none; width: 9cqi; height: max(2px, .35cqi); margin: 3.2cqi 0 2.6cqi; background: var(--ember); }
.l-title .s-sub { max-width: 70%; margin: 0; font: 400 2.5cqi/1.35 var(--font-body); color: var(--text); }

.l-bullets .s-title { max-width: 90%; margin-bottom: 4cqi; font: 650 4.6cqi/1.08 var(--font-heading); letter-spacing: -0.03em; color: var(--text-strong); }
.s-bullets { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1.6cqi; max-width: 88%; }
.s-bullets li { position: relative; padding-left: 3.4cqi; font: 400 2.5cqi/1.35 var(--font-body); color: var(--text); }
.s-bullets li::before { content: ""; position: absolute; left: 0; top: calc(.675em - .5cqi); width: 1cqi; height: 1cqi; background: var(--ember); }
.l-bullets:has(.dense, .xdense) { padding-top: 5.5cqi; }
.l-bullets:has(.dense, .xdense) .s-title { margin-bottom: 2.6cqi; }
.s-bullets.dense { gap: 1.1cqi; }
.s-bullets.dense li { font-size: 2.1cqi; }
.s-bullets.xdense { gap: .6cqi; }
.s-bullets.xdense li { font-size: 1.75cqi; }

.l-quote { justify-content: center; }
.s-quote-wrap { margin: 0; padding: .4cqi 0 .4cqi 4cqi; border-left: max(3px, .45cqi) solid var(--ember); max-width: 88%; }
.s-quote { margin: 0; font: 500 4cqi/1.2 var(--font-heading); letter-spacing: -0.02em; color: var(--text-strong); }
.s-attr { display: flex; align-items: center; gap: 1.4cqi; margin-top: 2.8cqi; font: 400 1.6cqi/1.3 var(--font-mono); color: var(--muted); }
.s-attr-rule { flex: none; width: 2.6cqi; height: 1px; background: var(--border-strong); }

.l-stat { justify-content: center; }
.s-stat { font: 700 19cqi/.92 var(--font-heading); letter-spacing: -0.05em; color: var(--accent-text); font-variant-numeric: tabular-nums; }
.s-caption { max-width: 62%; margin: 2.6cqi 0 0; font: 400 2.8cqi/1.3 var(--font-body); color: var(--text-strong); }

.editing [data-field] { border-radius: 2px; outline: 1px dashed transparent; outline-offset: .7cqi; cursor: text; transition: outline-color .12s ease; }
.editing [data-field]:hover { outline-color: var(--border-strong); }
.editing [data-field]:focus { outline: 1px solid var(--ember); }
.editing [data-ph]:empty::after { content: attr(data-ph); color: var(--muted); opacity: .6; pointer-events: none; }

.exit { position: absolute; top: 10px; right: 10px; display: none; opacity: 0; transition: opacity .2s ease; z-index: 2; background: var(--surface); }
.presenting .toolbar, .presenting .rail { display: none; }
.presenting .app { grid-template-rows: minmax(0, 1fr); }
.presenting .main { grid-template-columns: minmax(0, 1fr); }
.presenting .stage-wrap { padding: 0; background: var(--bg); cursor: pointer; }
.presenting .stage { border: 0; border-radius: 0; background: var(--bg); }
.presenting .exit { display: inline-flex; }
.presenting .stage-wrap:hover .exit, .exit:focus-visible { opacity: 1; }

.toast { position: fixed; left: 50%; bottom: 16px; z-index: 10; max-width: calc(100% - 32px); padding: 8px 12px;
  transform: translate(-50%, 6px); opacity: 0; pointer-events: none; transition: opacity .15s ease, transform .15s ease;
  background: var(--surface-2); color: var(--text-strong); border: 1px solid var(--border-strong); border-left: 2px solid var(--danger);
  border-radius: var(--radius-sm); font: 12px/1.35 var(--font-mono); }
.toast.show { opacity: 1; transform: translate(-50%, 0); }
.boot-error { margin: auto; padding: 24px; font: 13px/1.5 var(--font-mono); color: var(--danger); }

@media (max-width: 639px) {
  .toolbar { padding: 8px 10px; }
  .tb-actions { width: 100%; margin-left: 0; }
  .tb-actions .layouts { margin-right: auto; }
  .layouts .lbl { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .layouts button { padding: 6px 8px; }
  .main { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .rail { overflow-x: auto; overflow-y: hidden; padding: 10px 12px; border-right: 0; border-bottom: 1px solid var(--border); }
  .thumbs { flex-direction: row; gap: 8px; }
  .thumb { flex: none; width: 132px; grid-template-columns: minmax(0, 1fr); }
  .thumb-num { order: 2; padding: 0 0 0 2px; text-align: left; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;

// ---------- DOM helpers ----------

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

function icon(paths, size = 14) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 16 16", width: size, height: size, fill: "none", stroke: "currentColor",
    "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  for (const d of paths) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

const PLAINTEXT_ONLY = (() => {
  const probe = document.createElement("div");
  try { probe.contentEditable = "plaintext-only"; } catch { return false; }
  return probe.contentEditable === "plaintext-only";
})();

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const errorText = (err) => clean(err && err.message ? err.message : err).replace(/^Error:\s*/, "") || "The request failed";

// ---------- State ----------

let deck = null;
let currentId = null;
let lastIndex = 0;
let presenting = false;

function currentIndex() {
  const found = deck.slides.findIndex((s) => s.id === currentId);
  if (found >= 0) return (lastIndex = found);
  lastIndex = Math.max(0, Math.min(lastIndex, deck.slides.length - 1));
  currentId = deck.slides[lastIndex]?.id ?? null;
  return lastIndex;
}

// ---------- Shell ----------

document.head.append(h("style", { text: CSS }));

const deckTitle = h("span", { class: "deck-title", role: "textbox", "aria-label": "Deck title", spellcheck: "true" });
deckTitle.contentEditable = PLAINTEXT_ONLY ? "plaintext-only" : "true";
const counter = h("span", { class: "chip counter", "aria-live": "polite" });
const layoutButtons = LAYOUTS.map((l) =>
  h("button", { type: "button", "aria-pressed": "false", title: `${l.label} layout`, onclick: () => setLayout(l.id) },
    icon(l.icon), h("span", { class: "lbl", text: l.label })));
const addButton = h("button", { class: "btn", type: "button", onclick: () => addSlide() }, icon(ICONS.plus), "Add slide");
const presentButton = h("button", { class: "btn btn-primary", type: "button", onclick: () => setPresenting(true) },
  icon(ICONS.play), "Present");

const thumbs = h("ol", { class: "thumbs" });
const stage = h("div", { class: "slide stage editing" });
const stageFoot = h("div", { class: "s-foot" });
const stageProgress = h("div", { class: "s-progress", "aria-hidden": "true" });
const exitButton = h("button", { class: "btn exit", type: "button", onclick: (e) => { e.stopPropagation(); setPresenting(false); } },
  icon(ICONS.close), "Exit");
const stageWrap = h("section", { class: "stage-wrap", tabindex: "-1", "aria-label": "Current slide" }, stage, exitButton);
const toast = h("div", { class: "toast", role: "status", "aria-live": "polite" });

document.body.append(
  h("div", { class: "app" },
    h("header", { class: "toolbar" },
      h("div", { class: "tb-deck" }, deckTitle, counter),
      h("div", { class: "tb-actions" },
        h("div", { class: "layouts", role: "group", "aria-label": "Layout of the current slide" }, layoutButtons),
        addButton, presentButton)),
    h("div", { class: "main" },
      h("nav", { class: "rail", "aria-label": "Slides" }, thumbs),
      stageWrap)),
  toast);

let toastTimer = 0;
function flash(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

async function run(fn) {
  try {
    return await fn();
  } catch (err) {
    flash(errorText(err));
    try { deck = await gadget.getDeck(); renderAll(); } catch { /* keep the local copy */ }
    return undefined;
  }
}

// ---------- Slide rendering ----------

function makeEditable(el, key, placeholder) {
  el.dataset.field = key;
  el.dataset.ph = placeholder;
  el.contentEditable = PLAINTEXT_ONLY ? "plaintext-only" : "true";
  el.spellcheck = true;
  el.setAttribute("role", "textbox");
  el.setAttribute("aria-label", placeholder);
  return el;
}

// Long lists get a smaller type size, so 12 bullets still fit above the footer.
function setDensity(list) {
  const n = list.children.length;
  list.classList.toggle("dense", n >= 7 && n < 9);
  list.classList.toggle("xdense", n >= 9);
}

function bulletItem(value, editable) {
  const li = h("li", { text: value });
  return editable ? makeEditable(li, "bullets", "Bullet point") : li;
}

function slideContent(slide, mode) {
  const edit = mode === "edit";
  const field = (tag, cls, key, placeholder) => {
    const value = slide[key] || "";
    if (!edit && !value) return null;
    const el = h(tag, { class: cls, text: value });
    return edit ? makeEditable(el, key, placeholder) : el;
  };
  const body = h("div", { class: `slide-body l-${slide.layout}` });

  if (slide.layout === "title") {
    body.append(...[
      field(mode === "thumb" ? "div" : "h1", "s-title", "title", "Slide title"),
      h("div", { class: "s-rule", "aria-hidden": "true" }),
      field("p", "s-sub", "subtitle", "Subtitle"),
    ].filter(Boolean));
  } else if (slide.layout === "bullets") {
    const title = field(mode === "thumb" ? "div" : "h2", "s-title", "title", "Slide title");
    if (title) body.append(title);
    const items = slide.bullets && slide.bullets.length ? slide.bullets : edit ? [""] : [];
    if (items.length) {
      const list = h("ul", { class: "s-bullets" }, items.map((b) => bulletItem(b, edit)));
      setDensity(list);
      body.append(list);
    }
  } else if (slide.layout === "quote") {
    const eyebrow = field("div", "s-eyebrow", "title", "Label");
    if (eyebrow) body.append(eyebrow);
    const quote = field("blockquote", "s-quote", "quote", "Quote");
    const attribution = field("span", "s-attr-text", "attribution", "Attribution");
    if (quote || attribution) {
      body.append(h("figure", { class: "s-quote-wrap" }, quote,
        attribution && h("figcaption", { class: "s-attr" }, h("span", { class: "s-attr-rule", "aria-hidden": "true" }), attribution)));
    }
  } else {
    body.append(...[
      field("div", "s-eyebrow", "title", "Label"),
      field("div", "s-stat", "stat", "42"),
      field("p", "s-caption", "caption", "What the number means"),
    ].filter(Boolean));
  }
  return body;
}

function activeStageField() {
  const el = document.activeElement;
  return el && el !== document.body && stage.contains(el) && el.dataset.field ? el : null;
}

function updateStageMeta(index) {
  stageFoot.textContent = `${deck.title} · slide ${index + 1}`;
  stageProgress.style.width = `${((index + 1) / deck.slides.length) * 100}%`;
}

// Refresh the fields that nobody edits here, and leave the focused field alone.
function patchStage(slide, active) {
  for (const el of stage.querySelectorAll("[data-field]:not(li)")) {
    if (el === active) continue;
    const value = slide[el.dataset.field] || "";
    if (el.textContent !== value) el.textContent = value;
  }
  const list = stage.querySelector(".s-bullets");
  if (list && !list.contains(active)) {
    const items = slide.bullets && slide.bullets.length ? slide.bullets : [""];
    list.replaceChildren(...items.map((b) => bulletItem(b, true)));
    setDensity(list);
  }
}

let stagePending = false;

function renderStage(animate = false) {
  const index = currentIndex();
  const slide = deck.slides[index];
  updateStageMeta(index);
  const active = activeStageField();
  if (active) {
    if (stage.dataset.slideId === slide.id && stage.dataset.layout === slide.layout) patchStage(slide, active);
    else stagePending = true;
    return;
  }
  stagePending = false;
  const body = slideContent(slide, presenting ? "present" : "edit");
  if (animate) body.classList.add("enter");
  stage.replaceChildren(body, stageFoot, stageProgress);
  stage.dataset.slideId = slide.id;
  stage.dataset.layout = slide.layout;
  stage.classList.toggle("editing", !presenting);
}

function renderToolbar(index) {
  const slide = deck.slides[index];
  if (document.activeElement !== deckTitle && deckTitle.textContent !== deck.title) deckTitle.textContent = deck.title;
  counter.textContent = `${index + 1} / ${deck.slides.length}`;
  LAYOUTS.forEach((l, i) => layoutButtons[i].setAttribute("aria-pressed", String(slide.layout === l.id)));
  addButton.disabled = deck.slides.length >= MAX_SLIDES;
}

function renderRail(index) {
  const focusKey = thumbs.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  const total = deck.slides.length;
  const items = deck.slides.map((slide, i) => {
    const n = i + 1;
    const label = slide.title || slide.quote || slide.stat || "Untitled";
    const mini = h("div", { class: "slide", "aria-hidden": "true" }, slideContent(slide, "thumb"));
    const action = (name, paths, text, disabled, onclick, cls) =>
      h("button", { type: "button", class: cls, title: text, "aria-label": text, disabled, "data-key": `${slide.id}:${name}`, onclick },
        icon(paths, 12));
    return h("li", { class: i === index ? "thumb active" : "thumb" },
      h("span", { class: "thumb-num", "aria-hidden": "true", text: String(n).padStart(2, "0") }),
      h("button", { type: "button", class: "thumb-main", "data-key": `${slide.id}:open`, "aria-label": `Slide ${n}: ${label}`,
        "aria-current": i === index ? "true" : null, onclick: () => go(i) }, mini),
      h("div", { class: "thumb-actions" },
        action("up", ICONS.up, `Move slide ${n} up`, i === 0, () => moveSlide(slide.id, i - 1)),
        action("down", ICONS.down, `Move slide ${n} down`, i === total - 1, () => moveSlide(slide.id, i + 1)),
        action("delete", ICONS.trash, `Delete slide ${n}`, total === 1, () => removeSlide(slide.id, i), "danger")));
  });
  thumbs.replaceChildren(...items);
  if (focusKey) {
    const again = [...thumbs.querySelectorAll("[data-key]")].find((b) => b.dataset.key === focusKey);
    if (again && !again.disabled) again.focus();
  }
}

function renderAll(animate = false) {
  const index = currentIndex();
  renderToolbar(index);
  renderRail(index);
  renderStage(animate);
}

// ---------- Actions ----------

function go(index, { focusThumb = false } = {}) {
  const clamped = Math.max(0, Math.min(deck.slides.length - 1, index));
  const changed = deck.slides[clamped].id !== currentId;
  currentId = deck.slides[clamped].id;
  lastIndex = clamped;
  if (activeStageField()) activeStageField().blur();
  renderAll(changed);
  const active = thumbs.children[clamped];
  if (active) {
    active.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (focusThumb) active.querySelector(".thumb-main").focus();
  }
}

function setLayout(layout) {
  const slide = deck.slides[currentIndex()];
  if (!slide || slide.layout === layout) return;
  slide.layout = layout;
  renderAll();
  run(() => gadget.updateSlide(slide.id, { layout }));
}

async function addSlide() {
  if (deck.slides.length >= MAX_SLIDES) return flash(`A deck can have at most ${MAX_SLIDES} slides`);
  const created = await run(() => gadget.addSlide({ layout: "bullets", title: "New slide" }, currentIndex() + 1));
  if (!created) return;
  const fresh = await run(() => gadget.getDeck());
  if (!fresh) return;
  deck = fresh;
  const index = deck.slides.findIndex((s) => s.id === created.id);
  if (index < 0) return renderAll();
  go(index);
  const title = stage.querySelector('[data-field="title"]');
  if (title && !presenting) {
    title.focus();
    const range = document.createRange();
    range.selectNodeContents(title);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }
}

function moveSlide(id, toIndex) {
  run(() => gadget.moveSlide(id, toIndex));
}

function removeSlide(id, index) {
  if (deck.slides.length <= 1) return;
  if (id === currentId) {
    const neighbour = deck.slides[index + 1] || deck.slides[index - 1];
    currentId = neighbour.id;
  }
  run(() => gadget.removeSlide(id));
}

function setPresenting(on) {
  presenting = on;
  if (activeStageField()) activeStageField().blur();
  document.body.classList.toggle("presenting", on);
  renderStage();
  if (on) stageWrap.focus({ preventScroll: true });
  else presentButton.focus({ preventScroll: true });
}

// ---------- Inline editing ----------

function commitField(el) {
  const id = stage.dataset.slideId;
  const slide = deck.slides.find((s) => s.id === id);
  if (!slide) return flash("Another tab removed this slide");
  const key = el.dataset.field;
  let patch;
  if (key === "bullets") {
    const list = stage.querySelector(".s-bullets");
    const next = list ? [...list.children].map((li) => clean(li.textContent)).filter(Boolean) : [];
    if (JSON.stringify(next) === JSON.stringify(slide.bullets || [])) return;
    slide.bullets = next;
    patch = { bullets: next };
  } else {
    const value = clean(el.textContent);
    if (value === (slide[key] || "")) return;
    slide[key] = value;
    patch = { [key]: value };
  }
  renderRail(currentIndex());
  run(() => gadget.updateSlide(id, patch));
}

function textOffset(el, container, offset) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.setEnd(container, offset);
  return range.toString().length;
}

function placeCaret(el, atEnd) {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(!atEnd);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function insertPlainText(text) {
  document.execCommand("insertText", false, text);
}

stage.addEventListener("keydown", (e) => {
  const el = e.target.closest && e.target.closest("[data-field]");
  if (!el || e.isComposing) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    el.blur();
    return;
  }
  if (el.dataset.field !== "bullets") {
    if (e.key === "Enter") { e.preventDefault(); el.blur(); }
    return;
  }
  const list = el.parentElement;
  if (e.key === "Enter") {
    e.preventDefault();
    if (list.children.length >= MAX_BULLETS) return flash(`A slide can have at most ${MAX_BULLETS} bullets`);
    const text = el.textContent;
    const selection = getSelection();
    let start = text.length;
    let end = text.length;
    if (selection.rangeCount && el.contains(selection.getRangeAt(0).startContainer)) {
      const r = selection.getRangeAt(0);
      start = textOffset(el, r.startContainer, r.startOffset);
      end = el.contains(r.endContainer) ? textOffset(el, r.endContainer, r.endOffset) : text.length;
    }
    const next = bulletItem(text.slice(end), true);
    el.textContent = text.slice(0, start);
    el.after(next);
    setDensity(list);
    placeCaret(next, false);
  } else if (e.key === "Backspace" && el.textContent === "" && list.children.length > 1) {
    e.preventDefault();
    const target = el.previousElementSibling || el.nextElementSibling;
    placeCaret(target, Boolean(el.previousElementSibling));
    el.remove();
    setDensity(list);
  }
});

stage.addEventListener("paste", (e) => {
  if (!e.target.closest || !e.target.closest("[data-field]")) return;
  e.preventDefault();
  insertPlainText(clean(e.clipboardData ? e.clipboardData.getData("text/plain") : ""));
});
stage.addEventListener("drop", (e) => { if (e.target.closest && e.target.closest("[data-field]")) e.preventDefault(); });

stage.addEventListener("focusout", (e) => {
  const el = e.target.closest && e.target.closest("[data-field]");
  if (!el) return;
  commitField(el);
  setTimeout(() => { if (!activeStageField() && deck) renderStage(); }, 0);
});

deckTitle.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if (e.key === "Enter") { e.preventDefault(); deckTitle.blur(); }
  if (e.key === "Escape") { e.preventDefault(); deckTitle.textContent = deck.title; deckTitle.blur(); }
});
deckTitle.addEventListener("paste", (e) => {
  e.preventDefault();
  insertPlainText(clean(e.clipboardData ? e.clipboardData.getData("text/plain") : ""));
});
deckTitle.addEventListener("focusout", () => {
  deckTitle.scrollLeft = 0;
  const value = clean(deckTitle.textContent);
  if (!value) { deckTitle.textContent = deck.title; return; }
  if (value === deck.title) return;
  deck.title = value;
  updateStageMeta(currentIndex());
  run(() => gadget.setTitle(value));
});

// ---------- Keyboard and pointer navigation ----------

document.addEventListener("keydown", (e) => {
  if (!deck || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && t.closest && t.closest("[contenteditable], input, textarea, select")) return;
  const onButton = t && t.closest && t.closest("button");
  const inRail = t && t.closest && t.closest(".rail");
  const index = currentIndex();
  switch (e.key) {
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
      e.preventDefault(); go(index + 1, { focusThumb: Boolean(inRail) }); break;
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
      e.preventDefault(); go(index - 1, { focusThumb: Boolean(inRail) }); break;
    case " ":
      if (onButton) return;
      e.preventDefault(); go(e.shiftKey ? index - 1 : index + 1); break;
    case "Home":
      e.preventDefault(); go(0); break;
    case "End":
      e.preventDefault(); go(deck.slides.length - 1); break;
    case "Escape":
      if (presenting) { e.preventDefault(); setPresenting(false); }
      break;
  }
});

stageWrap.addEventListener("click", (e) => {
  if (!presenting || e.target.closest("button")) return;
  const box = stageWrap.getBoundingClientRect();
  go(currentIndex() + (e.clientX - box.left < box.width * 0.3 ? -1 : 1));
});

// ---------- Live sync ----------

class Listener extends RpcTarget {
  deckChanged(next) {
    deck = next;
    renderAll();
  }
}

try {
  deck = await gadget.getDeck();
  currentId = deck.slides[0] ? deck.slides[0].id : null;
  renderAll();
  await gadget.subscribe(new Listener());
} catch (err) {
  stageWrap.replaceChildren(h("p", { class: "boot-error", text: `Could not load the deck: ${errorText(err)}` }));
}
