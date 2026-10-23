import { FIELD_TYPES, LIMITS, type FieldType } from "../shared/limits";
import { PRESETS, cloneFields, type PresetId } from "../shared/presets";
import { SAMPLES } from "../shared/samples";
import { validateFields } from "../shared/schema";
import { highlightHtml, marksFromAnswers } from "../shared/highlight";
import { estimateBand, forecastPoints, formatAnswer, percentBetween } from "../shared/format";
import type { Answer, DeskDecision, Extraction, FieldSpec } from "../shared/types";

type ImagePayload = { content_type: "image/png" | "image/jpeg" | "image/webp"; base64: string; previewUrl: string };
type Draft = { name: string; spec: FieldSpec };
type TurnstileApi = {
  render: (el: HTMLElement, options: Record<string, unknown>) => string;
};

const tokens: Record<string, string> = { extract: "", decide: "", batch: "" };
let draft: Draft[] = [];
let preset: PresetId = "support";
let image: ImagePayload | null = null;
let last: Extraction | null = null;
let siteKey = "";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function text(node: HTMLElement, value: string) {
  node.textContent = value;
}

function button(label: string, onClick: () => void, pressed = false): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `btn btn-ghost${pressed ? " is-on" : ""}`;
  text(el, label);
  el.setAttribute("aria-pressed", pressed ? "true" : "false");
  el.addEventListener("click", onClick);
  return el;
}

function boot() {
  $("theme").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
  });
  renderSamples();
  renderPresets();
  loadPreset("support");
  $("add-field").addEventListener("click", () => {
    draft.push({ name: "field_name", spec: { type: "text", instructions: "" } });
    renderFields();
  });
  $("file").addEventListener("change", () => {
    const file = ($("file") as HTMLInputElement).files?.[0];
    if (file) void readFile(file);
  });
  $("clear-image").addEventListener("click", clearImage);
  $("extract").addEventListener("click", () => void runExtract());
  $("decide").addEventListener("click", () => void runDecide());
  $("batch").addEventListener("click", () => void runBatch());
  $("refresh").addEventListener("click", () => void loadReview(false));
  void (async () => {
    try {
      await loadConfig();
    } catch (err) {
      showError("form-error", err instanceof Error ? err.message : "The desk did not load.");
    }
    try {
      await loadReview(false);
    } catch (err) {
      showError("form-error", err instanceof Error ? err.message : "The review list did not load.");
    }
  })();
}

function renderSamples() {
  const box = $("samples");
  box.replaceChildren();
  for (const sample of SAMPLES) {
    box.append(button(sample.title, () => void applySample(sample.id)));
  }
}

async function applySample(id: string) {
  const sample = SAMPLES.find((item) => item.id === id);
  if (!sample) return;
  ($("state") as HTMLTextAreaElement).value = sample.state;
  loadPreset(sample.preset);
  clearImage();
  if (sample.image === "receipt") {
    const res = await fetch("./samples/receipt.png");
    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      const blob = new Blob([bytes], { type: "image/png" });
      image = { content_type: "image/png", base64: toBase64(bytes), previewUrl: URL.createObjectURL(blob) };
      showPreview();
    }
  }
}

function renderPresets() {
  const box = $("presets");
  box.replaceChildren();
  for (const [id, value] of Object.entries(PRESETS) as [PresetId, (typeof PRESETS)[PresetId]][]) {
    box.append(button(value.label, () => loadPreset(id), id === preset));
  }
}

function loadPreset(id: PresetId) {
  preset = id;
  const fields = cloneFields(PRESETS[id].fields);
  draft = Object.entries(fields).map(([name, spec]) => ({ name, spec }));
  renderPresets();
  renderFields();
}

function renderFields() {
  const box = $("fields");
  box.replaceChildren();
  draft.forEach((field, index) => {
    const card = document.createElement("div");
    card.className = "field";
    const row = document.createElement("div");
    row.className = "field__row";
    const name = labelled("Name", input(field.name, (value) => {
      field.name = value;
    }));
    const type = labelled("Type", select(FIELD_TYPES, field.spec.type, (value) => {
      field.spec = { type: value as FieldType };
      renderFields();
    }));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn btn-ghost";
    text(remove, "Remove");
    remove.addEventListener("click", () => {
      draft.splice(index, 1);
      renderFields();
    });
    row.append(name, type, remove);
    card.append(row);
    card.append(labelled("Instructions", input(field.spec.instructions ?? "", (value) => {
      field.spec.instructions = value;
    })));
    card.append(...extras(field.spec));
    box.append(card);
  });
}

function extras(spec: FieldSpec): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  if (spec.type === "number" || spec.type === "duration" || spec.type === "estimate" || spec.type === "forecast") {
    nodes.push(labelled("Unit", input(spec.unit ?? "", (value) => {
      spec.unit = value;
    })));
  }
  if (spec.type === "list") {
    nodes.push(labelled("Items", select(["text", "number", "date"] as const, spec.items ?? "text", (value) => {
      spec.items = value as "text" | "number" | "date";
    })));
  }
  if (spec.type === "number" || spec.type === "duration") {
    nodes.push(labelled("Decimals", input(spec.decimals === undefined ? "" : String(spec.decimals), (value) => {
      spec.decimals = value === "" ? undefined : Number(value);
    })));
  }
  if (spec.type === "estimate" || spec.type === "forecast") {
    nodes.push(labelled("Min", input(spec.min === undefined ? "" : String(spec.min), (value) => {
      spec.min = numericOrString(value);
    })));
    nodes.push(labelled("Max", input(spec.max === undefined ? "" : String(spec.max), (value) => {
      spec.max = numericOrString(value);
    })));
    nodes.push(labelled("Scale", select(["linear", "log"] as const, spec.scale ?? "linear", (value) => {
      spec.scale = value as "linear" | "log";
    })));
  }
  if (spec.type === "estimate") {
    nodes.push(labelled("Step", input(spec.step === undefined ? "" : String(spec.step), (value) => {
      spec.step = numericOrString(value);
    })));
  }
  if (spec.type === "forecast") {
    nodes.push(labelled("Horizon", input(spec.horizon === undefined ? "4" : String(spec.horizon), (value) => {
      spec.horizon = Number(value);
    })));
    nodes.push(labelled("Interval", select(["step", "day", "week", "month"] as const, spec.interval ?? "week", (value) => {
      spec.interval = value;
    })));
  }
  return nodes;
}

function labelled(label: string, control: HTMLElement): HTMLLabelElement {
  const wrap = document.createElement("label");
  wrap.className = "stack";
  wrap.append(document.createTextNode(label), control);
  return wrap;
}

function input(value: string, onInput: (value: string) => void): HTMLInputElement {
  const el = document.createElement("input");
  el.value = value;
  el.autocomplete = "off";
  el.addEventListener("input", () => onInput(el.value));
  return el;
}

function select<T extends string>(options: readonly T[], value: string, onChange: (value: string) => void): HTMLSelectElement {
  const el = document.createElement("select");
  for (const option of options) {
    const node = document.createElement("option");
    node.value = option;
    text(node, option);
    if (option === value) node.selected = true;
    el.append(node);
  }
  el.addEventListener("change", () => onChange(el.value));
  return el;
}

function numericOrString(value: string): number | string | undefined {
  if (!value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && value.trim() !== "" && !value.includes("-") ? number : value.trim();
}

function currentFields(): Record<string, FieldSpec> | null {
  const raw: Record<string, unknown> = {};
  for (const field of draft) {
    const spec: FieldSpec = { type: field.spec.type };
    if (field.spec.instructions?.trim()) spec.instructions = field.spec.instructions.trim();
    if (field.spec.unit?.trim()) spec.unit = field.spec.unit.trim();
    if (field.spec.integer) spec.integer = true;
    if (field.spec.decimals !== undefined && field.spec.decimals !== ("" as unknown)) spec.decimals = Number(field.spec.decimals);
    if (field.spec.items) spec.items = field.spec.items;
    if (field.spec.min !== undefined && field.spec.min !== "") spec.min = typeof field.spec.min === "string" && field.spec.min !== "month" && field.spec.min !== "year" && Number.isFinite(Number(field.spec.min)) ? Number(field.spec.min) : field.spec.min;
    if (field.spec.max !== undefined && field.spec.max !== "") spec.max = typeof field.spec.max === "string" && Number.isFinite(Number(field.spec.max)) ? Number(field.spec.max) : field.spec.max;
    if (field.spec.step !== undefined && field.spec.step !== "") spec.step = field.spec.step;
    if (field.spec.scale) spec.scale = field.spec.scale;
    if (field.spec.horizon) spec.horizon = Number(field.spec.horizon);
    if (field.spec.interval) spec.interval = field.spec.interval;
    raw[field.name.trim()] = spec;
  }
  const parsed = validateFields(raw);
  if (!parsed.ok) {
    showError("form-error", parsed.message);
    return null;
  }
  return parsed.fields;
}

async function readFile(file: File) {
  if (file.size > LIMITS.maxImageBytes) {
    showError("form-error", "That image is over the 1.5 MB limit.");
    return;
  }
  const type = file.type === "image/jpg" ? "image/jpeg" : file.type;
  if (type !== "image/png" && type !== "image/jpeg" && type !== "image/webp") {
    showError("form-error", "Use a PNG, JPEG, or WebP image.");
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (image?.previewUrl) URL.revokeObjectURL(image.previewUrl);
  image = { content_type: type, base64: toBase64(bytes), previewUrl: URL.createObjectURL(file) };
  showPreview();
  clearError("form-error");
}

function showPreview() {
  const box = $("preview");
  box.hidden = !image;
  box.replaceChildren();
  $("clear-image").hidden = !image;
  if (!image) return;
  const img = document.createElement("img");
  img.src = image.previewUrl;
  img.alt = "Receipt or invoice preview";
  box.append(img);
}

function clearImage() {
  if (image?.previewUrl.startsWith("blob:")) URL.revokeObjectURL(image.previewUrl);
  image = null;
  ($("file") as HTMLInputElement).value = "";
  showPreview();
}

async function runExtract() {
  clearError("form-error");
  const fields = currentFields();
  if (!fields) return;
  const state = ($("state") as HTMLTextAreaElement).value;
  const submitted = { compare: ($("compare") as HTMLInputElement).checked, hasText: state.trim().length > 0 };
  if (!submitted.hasText && !image) {
    showError("form-error", "Paste a document or upload an image.");
    return;
  }
  if (!tokens.extract) {
    showError("form-error", "Complete the Turnstile check first.");
    return;
  }
  setBusy("extract", true);
  try {
    const res = await fetch("./api/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        turnstileToken: tokens.extract,
        state,
        fields,
        compare: submitted.compare,
        ...(image ? { image: { content_type: image.content_type, base64: image.base64 } } : {}),
      }),
    });
    const body = await readBody(res);
    if (!res.ok) throw new Error(errorMessage(body));
    last = body as Extraction;
    renderExtraction(last, fields, submitted);
    $("decision").hidden = false;
    tokens.extract = "";
    ($("extract") as HTMLButtonElement).disabled = true;
  } catch (err) {
    showError("form-error", err instanceof Error ? err.message : "The extraction failed.");
  } finally {
    setBusy("extract", false);
  }
}

function renderExtraction(result: Extraction, fields: Record<string, FieldSpec>, submitted: { compare: boolean; hasText: boolean }) {
  const panel = $("results");
  panel.hidden = false;
  panel.replaceChildren();
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  text(eyebrow, "Results");
  panel.append(eyebrow);
  if (result.source === "mock" || result.photoUnread) {
    const note = document.createElement("p");
    note.className = "banner";
    text(note, result.photoUnread
      ? "Local mock cannot read a photo on its own. Production Clairic can. Paste the transcript or use the receipt sample."
      : "Labelled local mock. Latency and cost are estimates, and nothing was billed.");
    panel.append(note);
  }
  if (result.truncated) {
    const note = document.createElement("p");
    note.className = "banner";
    text(note, "Clairic truncated this document. A field past the cut can come back null.");
    panel.append(note);
  }
  const legend = document.createElement("div");
  legend.className = "legend";
  legend.append(swatch("high", "High confidence"), swatch("mid", "Mid confidence"), swatch("low", "Low confidence"));
  panel.append(legend);
  const source = document.createElement("div");
  source.className = "source";
  source.innerHTML = highlightHtml(result.stateText || "", marksFromAnswers(result.answers));
  panel.append(source);
  const cards = document.createElement("div");
  cards.className = "cards";
  for (const [name, answer] of Object.entries(result.answers)) {
    cards.append(answerCard(name, answer, fields[name], result.review.some((flag) => flag.field === name)));
  }
  panel.append(cards);
  const meta = document.createElement("p");
  meta.className = "meta";
  text(meta, `${result.model} · ${result.latencyMs} ms · est. ${usd(result.costUsd)} · ${result.usage.input_tokens} input tokens`);
  panel.append(meta);
  renderComparison(result, fields, submitted);
  panel.scrollIntoView({ block: "start" });
}

function swatch(tone: string, label: string): HTMLSpanElement {
  const el = document.createElement("span");
  const mark = document.createElement("i");
  mark.className = `swatch ${tone}`;
  el.append(mark, document.createTextNode(label));
  return el;
}

function answerCard(name: string, answer: Answer, spec: FieldSpec | undefined, flagged: boolean): HTMLElement {
  const card = document.createElement("article");
  card.className = "card";
  const header = document.createElement("header");
  const title = document.createElement("h3");
  text(title, name);
  header.append(title);
  if (flagged) {
    const flag = document.createElement("span");
    flag.className = "flag";
    text(flag, answer.value === null || answer.value === undefined ? "Needs review · null" : "Needs review");
    header.append(flag);
  }
  card.append(header);
  const value = document.createElement("p");
  value.className = "value";
  text(value, formatAnswer(answer));
  card.append(value);
  if ((answer.value === null || answer.value === undefined) && answer.guess !== undefined && answer.guess !== null) {
    const guess = document.createElement("p");
    guess.className = "hint";
    text(guess, `Guess not used: ${String(answer.guess)}`);
    card.append(guess);
  }
  const meta = document.createElement("p");
  meta.className = "meta";
  const bits = [answer.type];
  if (typeof answer.confidence === "number") bits.push(`confidence ${answer.confidence.toFixed(2)}`);
  if (typeof answer.p_null === "number") bits.push(`p_null ${answer.p_null.toExponential(1)}`);
  text(meta, bits.join(" · "));
  card.append(meta);
  const band = answer.type === "estimate" ? estimateBand(answer, spec) : null;
  if (band) card.append(rangeEl(band));
  if (answer.type === "forecast") {
    const points = forecastPoints(answer);
    if (points.length) card.append(chartEl(points));
  }
  return card;
}

function rangeEl(band: { min: number; max: number; p10: number; p90: number; median: number }): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "range";
  const track = document.createElement("div");
  track.className = "range__track";
  const span = document.createElement("div");
  span.className = "range__band";
  const left = percentBetween(Math.min(band.p10, band.p90), band.min, band.max);
  const right = percentBetween(Math.max(band.p10, band.p90), band.min, band.max);
  span.style.left = `${left}%`;
  span.style.width = `${Math.max(2, right - left)}%`;
  const mark = document.createElement("div");
  mark.className = "range__mark";
  mark.style.left = `${percentBetween(band.median, band.min, band.max)}%`;
  track.append(span, mark);
  const labels = document.createElement("div");
  labels.className = "range__labels";
  for (const label of [String(band.min), `80% ${band.p10}–${band.p90}`, String(band.max)]) {
    const node = document.createElement("span");
    text(node, label);
    labels.append(node);
  }
  wrap.append(track, labels);
  return wrap;
}

function chartEl(points: { median: number; p10: number; p90: number }[]): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 320 150");
  svg.setAttribute("class", "chart");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Forecast chart");
  const max = Math.max(...points.map((point) => point.p90), 1);
  const min = Math.min(...points.map((point) => point.p10), 0);
  const span = Math.max(1, max - min);
  const slot = 320 / points.length;
  points.forEach((point, index) => {
    const x = index * slot + slot * 0.2;
    const width = slot * 0.6;
    const y90 = 120 - ((point.p90 - min) / span) * 100;
    const y10 = 120 - ((point.p10 - min) / span) * 100;
    const yMed = 120 - ((point.median - min) / span) * 100;
    const band = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    band.setAttribute("x", String(x));
    band.setAttribute("y", String(Math.min(y10, y90)));
    band.setAttribute("width", String(width));
    band.setAttribute("height", String(Math.max(2, Math.abs(y10 - y90))));
    band.setAttribute("fill", "rgba(226, 98, 46, 0.45)");
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(x));
    line.setAttribute("x2", String(x + width));
    line.setAttribute("y1", String(yMed));
    line.setAttribute("y2", String(yMed));
    line.setAttribute("stroke", "currentColor");
    line.setAttribute("stroke-width", "2");
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String(x));
    label.setAttribute("y", "142");
    label.setAttribute("fill", "currentColor");
    label.setAttribute("font-size", "12");
    label.textContent = String(index + 1);
    svg.append(band, line, label);
  });
  return svg;
}

function renderComparison(result: Extraction, fields: Record<string, FieldSpec>, submitted: { compare: boolean; hasText: boolean }) {
  const panel = $("comparison");
  const comparison = result.comparison;
  if (!comparison) {
    panel.replaceChildren();
    if (submitted.compare && !submitted.hasText) {
      panel.hidden = false;
      const note = document.createElement("p");
      note.className = "hint";
      text(note, "Compare needs pasted text.");
      panel.append(note);
      return;
    }
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  panel.replaceChildren();
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  text(eyebrow, "Comparison");
  const title = document.createElement("h2");
  text(title, "Clairic and Llama 3.2 3B");
  panel.append(eyebrow, title);
  if (comparison.source === "mock") {
    const note = document.createElement("p");
    note.className = "banner";
    text(note, "Labelled local mock of the instruct model. It is written to come back schema-invalid.");
    panel.append(note);
  }
  const grid = document.createElement("div");
  grid.className = "compare";
  grid.append(statCard("Clairic", `${result.latencyMs} ms`, "Schema-valid", "Yes", result.costUsd));
  const schema = comparison.schemaValid ? "Yes" : "No";
  grid.append(statCard(comparison.model, `${comparison.latencyMs} ms`, "Schema-valid", schema, comparison.costUsd, !comparison.schemaValid));
  panel.append(grid);
  if (!comparison.schemaValid && comparison.reasons.length) {
    const why = document.createElement("p");
    why.className = "hint";
    text(why, comparison.reasons.slice(0, 4).join(" "));
    panel.append(why);
  }
  const table = document.createElement("div");
  table.className = "cards";
  const parsed = comparison.parsed && typeof comparison.parsed === "object" ? comparison.parsed as Record<string, unknown> : {};
  for (const name of Object.keys(fields)) {
    const row = document.createElement("article");
    row.className = "card pair";
    const heading = document.createElement("h3");
    text(heading, name);
    const left = document.createElement("p");
    text(left, `Clairic: ${formatAnswer(result.answers[name])}`);
    const right = document.createElement("p");
    text(right, `Llama: ${parsed[name] === undefined ? "missing" : JSON.stringify(parsed[name])}`);
    row.append(heading, left, right);
    table.append(row);
  }
  panel.append(table);
}

function statCard(model: string, latency: string, schemaLabel: string, schema: string, cost: number | null, bad = false): HTMLElement {
  const card = document.createElement("article");
  card.className = "card stat";
  const heading = document.createElement("h3");
  text(heading, model);
  const lat = document.createElement("p");
  text(lat, latency);
  const valid = document.createElement("p");
  valid.className = bad ? "bad" : "ok";
  text(valid, `${schemaLabel}: ${schema}`);
  const price = document.createElement("p");
  price.className = "meta";
  text(price, cost === null ? "Estimated cost unknown" : `Estimated cost ${usd(cost)}`);
  card.append(heading, lat, valid, price);
  return card;
}

async function runDecide() {
  clearError("decide-error");
  if (!last) return;
  const fields = currentFields();
  if (!fields) return;
  if (!tokens.decide) {
    showError("decide-error", "Complete the Turnstile check first.");
    return;
  }
  setBusy("decide", true);
  try {
    const res = await fetch("./api/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnstileToken: tokens.decide, fields, answers: last.answers }),
    });
    const body = await readBody(res);
    if (!res.ok) throw new Error(errorMessage(body));
    renderDecision(body as DeskDecision);
    tokens.decide = "";
    ($("decide") as HTMLButtonElement).disabled = true;
  } catch (err) {
    showError("decide-error", err instanceof Error ? err.message : "Clef did not answer.");
  } finally {
    setBusy("decide", false);
  }
}

function renderDecision(decision: DeskDecision) {
  const box = $("decision-body");
  box.replaceChildren();
  if (decision.source === "mock") {
    const note = document.createElement("p");
    note.className = "banner";
    text(note, "Labelled local mock of Clef.");
    box.append(note);
  }
  const choice = document.createElement("h2");
  text(choice, decision.choice);
  const reason = document.createElement("p");
  text(reason, decision.reason);
  const list = document.createElement("ul");
  list.className = "bars";
  for (const [name, probability] of Object.entries(decision.probabilities)) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    text(label, name);
    const bar = document.createElement("span");
    bar.className = "bar";
    const fill = document.createElement("span");
    fill.className = "bar__fill";
    fill.style.width = `${Math.round(probability * 100)}%`;
    bar.append(fill);
    const num = document.createElement("span");
    num.className = "meta";
    text(num, probability.toFixed(2));
    item.append(label, bar, num);
    list.append(item);
  }
  const meta = document.createElement("p");
  meta.className = "meta";
  text(meta, `${decision.model} · ${decision.latencyMs} ms · confidence ${decision.confidence.toFixed(2)} · est. ${usd(decision.costUsd)}`);
  box.append(choice, reason, list, meta);
}

async function runBatch() {
  text($("batch-note"), "");
  if (!tokens.batch) {
    text($("batch-note"), "Complete the Turnstile check first.");
    return;
  }
  setBusy("batch", true);
  try {
    const res = await fetch("./api/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnstileToken: tokens.batch }),
    });
    const body = await readBody(res);
    if (!res.ok) throw new Error(errorMessage(body));
    text($("batch-note"), "Queued 12 documents. Waiting for the review rows.");
    tokens.batch = "";
    ($("batch") as HTMLButtonElement).disabled = true;
    await pollReview();
  } catch (err) {
    text($("batch-note"), err instanceof Error ? err.message : "The inbox did not queue.");
  } finally {
    setBusy("batch", false);
  }
}

async function pollReview() {
  const started = Date.now();
  let wait = 400;
  while (Date.now() - started < 60_000) {
    if (await loadReview(true)) return;
    await new Promise((resolve) => setTimeout(resolve, wait));
    wait = Math.min(4_000, Math.round(wait * 1.5));
  }
  text($("batch-note"), "Still working. Use Refresh in a moment.");
}

async function loadReview(announce: boolean): Promise<boolean> {
  const res = await fetch("./api/review");
  const body = (await readBody(res)) as { items?: ReviewItem[]; error?: { message?: string } };
  if (!res.ok) {
    if (announce) text($("batch-note"), body.error?.message || "The review list did not load.");
    return false;
  }
  const items = body.items ?? [];
  renderReview(items);
  const ready = items.length > 0 && items.every((item) => item.status !== "queued" && item.status !== "running");
  if (announce && ready) {
    text($("batch-note"), `${items.length} documents are ready for review.`);
    $("review").scrollIntoView({ block: "start" });
  }
  return ready;
}

type ReviewItem = {
  id: string;
  title: string;
  status: string;
  state: string;
  truncated?: boolean;
  answers: Record<string, Answer> | null;
  corrections: Record<string, string> | null;
  source: string | null;
  error: string | null;
};

function renderReview(items: ReviewItem[]) {
  const box = $("review");
  box.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    text(empty, "The queue for this browser is empty.");
    box.append(empty);
    return;
  }
  for (const item of items) box.append(reviewCard(item));
}

function reviewCard(item: ReviewItem): HTMLElement {
  const card = document.createElement("article");
  card.className = "card review-card";
  const header = document.createElement("header");
  const title = document.createElement("h3");
  text(title, item.title);
  const status = document.createElement("span");
  status.className = "meta";
  text(status, item.status);
  header.append(title, status);
  card.append(header);
  if (item.error) {
    const err = document.createElement("p");
    err.className = "hint";
    text(err, item.error);
    card.append(err);
  }
  const inputs = new Map<string, HTMLInputElement>();
  if (item.answers) {
    for (const [name, answer] of Object.entries(item.answers)) {
      const row = document.createElement("label");
      row.className = "stack";
      const shown = item.corrections?.[name] ?? formatAnswer(answer);
      row.append(document.createTextNode(name));
      const field = document.createElement("input");
      field.value = shown === "null" ? "" : shown;
      field.setAttribute("aria-label", `Correct ${name}`);
      inputs.set(name, field);
      if (answer.value === null || (typeof answer.confidence === "number" && answer.confidence < LIMITS.reviewConfidence)) {
        const flag = document.createElement("span");
        flag.className = "flag";
        text(flag, "Needs review");
        row.append(flag);
      }
      row.append(field);
      card.append(row);
    }
    const fold = document.createElement("details");
    fold.className = "source-fold";
    const summary = document.createElement("summary");
    text(summary, "Source");
    const source = document.createElement("div");
    source.className = "source";
    source.innerHTML = highlightHtml(item.state, marksFromAnswers(item.answers));
    fold.append(summary, source);
    card.append(fold);
    if (item.truncated) {
      const note = document.createElement("p");
      note.className = "hint";
      text(note, "Clairic truncated this document.");
      card.append(note);
    }
  }
  const actions = document.createElement("div");
  actions.className = "review-actions";
  const accept = document.createElement("button");
  accept.type = "button";
  accept.className = "btn btn-primary";
  text(accept, "Accept");
  accept.disabled = item.status !== "review" && item.status !== "accepted";
  accept.addEventListener("click", () => void sendReview(item.id, "accept"));
  const correct = document.createElement("button");
  correct.type = "button";
  correct.className = "btn";
  text(correct, "Save correction");
  correct.disabled = item.status !== "review" && item.status !== "accepted";
  correct.addEventListener("click", () => {
    const corrections: Record<string, string> = {};
    for (const [name, field] of inputs) {
      if (field.value.trim()) corrections[name] = field.value.trim();
    }
    void sendReview(item.id, "correct", corrections);
  });
  actions.append(accept, correct);
  card.append(actions);
  return card;
}

async function sendReview(id: string, action: "accept" | "correct", corrections?: Record<string, string>) {
  const res = await fetch(`./api/review/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, corrections }),
  });
  const body = await readBody(res);
  if (!res.ok) {
    text($("batch-note"), errorMessage(body));
    return;
  }
  await pollReview();
}

async function loadConfig() {
  const res = await fetch("./api/config");
  const config = (await res.json()) as {
    turnstileSiteKey: string;
    testSiteKey: boolean;
    placeholderSiteKey: boolean;
    mock: boolean;
  };
  siteKey = config.turnstileSiteKey;
  if (config.mock) text($("banner"), "Local mock. Clairic, Llama, and Clef are labelled stand-ins, so this page does not bill Workers AI. Uploads still follow the one-day rule.");
  if (config.placeholderSiteKey) {
    showError("form-error", "Turnstile site key is still the placeholder TURNSTILE_SITE_KEY. Set the real key before deploy.");
    return;
  }
  if (config.testSiteKey) $("test-note").hidden = false;
  mountTurnstile("turnstile-extract", "extract");
  mountTurnstile("turnstile-decide", "decide");
  mountTurnstile("turnstile-batch", "batch");
}

function mountTurnstile(id: string, action: "extract" | "decide" | "batch") {
  const api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
  const el = $(id);
  if (!api) {
    window.setTimeout(() => mountTurnstile(id, action), 200);
    return;
  }
  api.render(el, {
    sitekey: siteKey,
    action,
    callback: (token: string) => {
      tokens[action] = token;
      const buttonId = action === "extract" ? "extract" : action === "decide" ? "decide" : "batch";
      ($(buttonId) as HTMLButtonElement).disabled = false;
    },
    "expired-callback": () => {
      tokens[action] = "";
    },
  });
}

function showError(id: string, message: string) {
  const el = $(id);
  el.hidden = false;
  text(el, message);
}

function clearError(id: string) {
  const el = $(id);
  el.hidden = true;
  text(el, "");
}

function setBusy(id: string, busy: boolean) {
  ($(id) as HTMLButtonElement).disabled = busy || !tokens[id === "extract" ? "extract" : id === "decide" ? "decide" : "batch"];
}

async function readBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

function errorMessage(body: unknown): string {
  if (body && typeof body === "object" && body && "error" in body) {
    const error = (body as { error?: { message?: string } }).error;
    if (error?.message) return error.message;
  }
  return "The request failed.";
}

function usd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0";
  if (value < 0.0001) return `$${value.toExponential(1)}`;
  return `$${value.toFixed(value < 0.01 ? 5 : 4)}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

boot();
