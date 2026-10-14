import { PRESETS, SAMPLES, validateQuestions } from "../shared/questions";
import type { AnswerBar, JudgmentResult, JudgmentView, SampleId, SessionPayload } from "../shared/types";

type Draft = { instructions: string; options: string[] };
type Picked =
  | { source: "sample"; sampleId: SampleId }
  | { source: "file"; file: File; note: string };

declare const turnstile: {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  getResponse: (id?: string) => string;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const questionsEl = $("questions");
const presetsEl = $("presets");
const previewEl = $("preview");
const mediaNote = $("media-note");
const permEl = $("perm");
const formError = $("form-error");
const resultsEl = $("results");
const historyEl = $("history");
const historyEmpty = $("history-empty");
const overlay = $("overlay");
const countEl = $("count");
const countHint = $("count-hint");
const testNote = $("test-note");

let draft: Draft[] = fromPreset(PRESETS[0]!);
let picked: Picked | null = null;
let previewUrl: string | null = null;
let widgetId = "";
let session: SessionPayload | null = null;
let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];
let ticker = 0;
let cancelled = false;
let recording = false;

function fromPreset(preset: (typeof PRESETS)[number]): Draft[] {
  return preset.questions.map((question) => ({ instructions: question.instructions, options: [...question.options] }));
}

function setText(node: HTMLElement, value: string): void {
  node.textContent = value;
}

function showError(message: string): void {
  formError.hidden = !message;
  setText(formError, message);
}

function api(path: string): string {
  return new URL(path.replace(/^\//, ""), document.baseURI).toString();
}

function clearPreview(): void {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  previewEl.replaceChildren();
  previewEl.hidden = true;
}

function showPreview(url: string, kind: "image" | "audio" | "video"): void {
  clearPreview();
  previewUrl = url.startsWith("blob:") ? url : null;
  const node = kind === "image" ? document.createElement("img") : kind === "audio" ? document.createElement("audio") : document.createElement("video");
  node.src = url;
  if (node instanceof HTMLMediaElement) {
    node.controls = true;
    if (node instanceof HTMLVideoElement) node.playsInline = true;
  }
  if (node instanceof HTMLImageElement) node.alt = "Selected media";
  previewEl.append(node);
  previewEl.hidden = false;
}

function guessKind(file: File): "image" | "audio" | "video" | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("video/")) return "video";
  const name = file.name.toLowerCase();
  if (/\.(png|jpe?g|webp)$/.test(name)) return "image";
  if (/\.(wav|mp3)$/.test(name)) return "audio";
  if (/\.(mp4|webm)$/.test(name)) return "video";
  return null;
}

function selectSample(id: SampleId): void {
  stopTracks();
  picked = { source: "sample", sampleId: id };
  const sample = SAMPLES[id];
  const kind = id === "clip" ? "video" : id === "gallery" || id === "package" ? "image" : "audio";
  showPreview(api(`samples/${sample.file}`), kind);
  setText(mediaNote, `${sample.label}. ${sample.note}`);
  permEl.hidden = true;
  markSamples(id);
  const preset = PRESETS.find((item) => item.sample === id);
  if (preset) {
    draft = fromPreset(preset);
    renderQuestions();
    markPresets(preset.id);
  }
}

async function downscaleImage(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  try {
    const maxEdge = 1024;
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas");
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) throw new Error("blob");
    return new File([blob], "photo.jpg", { type: "image/jpeg" });
  } finally {
    bitmap.close();
  }
}

async function selectFile(file: File): Promise<void> {
  const kind = guessKind(file);
  if (!kind) {
    showError("Use a PNG, JPEG, WebP, WAV, MP3, MP4, or WebM file.");
    return;
  }
  let chosen = file;
  if (kind === "image") {
    try {
      chosen = await downscaleImage(file);
    } catch {
      showError("That image could not be resized. Use a PNG, JPEG, or WebP.");
      return;
    }
  }
  picked = { source: "file", file: chosen, note: chosen.name || "Upload" };
  showPreview(URL.createObjectURL(chosen), kind);
  setText(mediaNote, `${chosen.name || "Upload"} · ${(chosen.size / 1024).toFixed(0)} KB. The server checks the bytes.`);
  permEl.hidden = true;
  markSamples(null);
  showError("");
}

function markSamples(id: SampleId | null): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-sample]")) {
    button.classList.toggle("is-on", button.dataset.sample === id);
  }
}

function markPresets(id: string | null): void {
  for (const button of presetsEl.querySelectorAll<HTMLButtonElement>("[data-preset]")) {
    button.classList.toggle("is-on", button.dataset.preset === id);
  }
}

function readDraftFromDom(): Draft[] {
  return [...questionsEl.querySelectorAll<HTMLElement>(".q")].map((block) => {
    const instructions = (block.querySelector<HTMLInputElement>(".q-text")?.value ?? "").trim();
    const options = [...block.querySelectorAll<HTMLInputElement>(".opt-text")].map((input) => input.value.trim()).filter((value, index, all) => value.length > 0 || index < 2 || all.length <= 2);
    const filled = options.filter((value) => value.length > 0);
    return { instructions, options: filled.length >= 2 ? filled : options };
  });
}

function renderQuestions(): void {
  questionsEl.replaceChildren();
  draft.forEach((question, index) => {
    const block = document.createElement("div");
    block.className = "q";
    const label = document.createElement("label");
    label.htmlFor = `q-${index}`;
    setText(label, `Question ${index + 1}`);
    const input = document.createElement("input");
    input.id = `q-${index}`;
    input.className = "q-text";
    input.maxLength = 160;
    input.value = question.instructions;
    input.autocomplete = "off";
    block.append(label, input);
    question.options.forEach((option, optionIndex) => {
      const row = document.createElement("div");
      row.className = "opt";
      const wrap = document.createElement("div");
      const optLabel = document.createElement("label");
      optLabel.htmlFor = `q-${index}-o-${optionIndex}`;
      setText(optLabel, `Option ${optionIndex + 1}`);
      const opt = document.createElement("input");
      opt.id = `q-${index}-o-${optionIndex}`;
      opt.className = "opt-text";
      opt.maxLength = 48;
      opt.value = option;
      opt.autocomplete = "off";
      wrap.append(optLabel, opt);
      row.append(wrap);
      if (question.options.length > 2) {
        const remove = document.createElement("button");
        remove.className = "btn btn-ghost";
        remove.type = "button";
        setText(remove, "Remove");
        remove.addEventListener("click", () => {
          draft = readDraftFromDom();
          draft[index]?.options.splice(optionIndex, 1);
          renderQuestions();
        });
        row.append(remove);
      }
      block.append(row);
    });
    const add = document.createElement("button");
    add.className = "btn btn-ghost";
    add.type = "button";
    add.style.marginTop = "0.45rem";
    setText(add, "Add an option");
    add.disabled = question.options.length >= 6;
    add.addEventListener("click", () => {
      draft = readDraftFromDom();
      if ((draft[index]?.options.length ?? 0) >= 6) return;
      draft[index]?.options.push("");
      renderQuestions();
    });
    block.append(add);
    if (draft.length > 1) {
      const removeQ = document.createElement("button");
      removeQ.className = "btn btn-ghost";
      removeQ.type = "button";
      removeQ.style.marginLeft = "0.4rem";
      setText(removeQ, "Remove question");
      removeQ.addEventListener("click", () => {
        draft = readDraftFromDom();
        draft.splice(index, 1);
        renderQuestions();
        markPresets(null);
      });
      block.append(removeQ);
    }
    questionsEl.append(block);
  });
}

function renderPresets(): void {
  presetsEl.replaceChildren();
  for (const preset of PRESETS) {
    const button = document.createElement("button");
    button.className = "chip";
    button.type = "button";
    button.dataset.preset = preset.id;
    setText(button, preset.title);
    button.addEventListener("click", () => {
      draft = fromPreset(preset);
      renderQuestions();
      markPresets(preset.id);
      if (preset.sample) selectSample(preset.sample);
    });
    presetsEl.append(button);
  }
  markPresets(PRESETS[0]!.id);
}

function bars(list: AnswerBar[], topId: string): HTMLUListElement {
  const ul = document.createElement("ul");
  ul.className = "bars";
  for (const bar of list) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    setText(name, bar.label);
    const track = document.createElement("span");
    track.className = "bar";
    const fill = document.createElement("span");
    fill.className = "bar__fill";
    fill.style.width = `${Math.max(0, Math.min(100, Math.round(bar.probability * 100)))}%`;
    if (bar.id === topId) fill.style.background = "var(--ember)";
    track.append(fill);
    const n = document.createElement("span");
    n.className = "bar__n";
    setText(n, `${Math.round(bar.probability * 100)}%`);
    li.append(name, track, n);
    ul.append(li);
  }
  return ul;
}

function money(usd: number): string {
  return `$${usd.toFixed(6)}`;
}

function renderOne(view: JudgmentView): HTMLElement {
  const card = document.createElement("article");
  card.className = "card";
  const kicker = document.createElement("p");
  kicker.className = "eyebrow";
  setText(kicker, view.kind === "compare" ? "Classic chain" : "Clef-omni");
  card.append(kicker);
  if (view.status === "error") {
    const p = document.createElement("p");
    setText(p, view.error || "The judgment failed.");
    card.append(p);
    return card;
  }
  const result = view.result;
  if (!result) {
    const p = document.createElement("p");
    setText(p, "No result was stored.");
    card.append(p);
    return card;
  }
  if (result.source === "local-stub" || result.source === "chain-stub") {
    const banner = document.createElement("p");
    banner.className = "banner";
    setText(banner, "Local stub. Workers AI was not called.");
    card.append(banner);
  }
  for (const answer of result.answers) {
    const block = document.createElement("div");
    block.className = "answer";
    const q = document.createElement("p");
    setText(q, answer.instructions);
    const top = document.createElement("h3");
    setText(top, answer.topLabel);
    block.append(q, top, bars(answer.bars, answer.topId));
    card.append(block);
  }
  card.append(metaLine(result));
  if (result.untrustedText) {
    const box = document.createElement("div");
    box.className = "untrusted";
    const label = document.createElement("p");
    label.className = "eyebrow";
    setText(label, "Model text, untrusted");
    const body = document.createElement("p");
    setText(body, result.untrustedText);
    box.append(label, body);
    card.append(box);
  }
  return card;
}

function metaLine(result: JudgmentResult): HTMLElement {
  const p = document.createElement("p");
  p.className = "meta";
  const cost = result.cost.usd === null ? result.cost.note : `${money(result.cost.usd)}. ${result.cost.note}`;
  const steps = result.steps.length
    ? ` Steps: ${result.steps.map((step) => `${step.name} ${step.latencyMs} ms${step.cost.usd === null ? "" : ` ${money(step.cost.usd)}`}`).join(", ")}.`
    : "";
  setText(p, `${result.latencyMs} ms · ${result.model}.${steps} ${cost}`);
  return p;
}

function renderOutcome(judgment: JudgmentView, comparison: unknown): void {
  resultsEl.hidden = false;
  resultsEl.replaceChildren();
  const pair = document.createElement("div");
  pair.className = "pair";
  pair.append(renderOne(judgment));
  if (comparison && typeof comparison === "object") {
    const row = comparison as { available?: boolean; reason?: string; error?: { message?: string }; id?: string };
    if (row.available === false && row.reason) {
      const card = document.createElement("article");
      card.className = "card";
      const kicker = document.createElement("p");
      kicker.className = "eyebrow";
      setText(kicker, "Classic chain");
      const p = document.createElement("p");
      setText(p, row.reason);
      card.append(kicker, p);
      pair.append(card);
    } else if (row.error?.message) {
      const card = document.createElement("article");
      card.className = "card";
      const p = document.createElement("p");
      setText(p, row.error.message);
      card.append(p);
      pair.append(card);
    } else if (row.id) {
      pair.append(renderOne(comparison as JudgmentView));
    }
  }
  resultsEl.append(pair);
  resultsEl.scrollIntoView({ block: "nearest" });
}

function renderHistory(items: JudgmentView[]): void {
  historyEl.replaceChildren();
  const visible = items.filter((item) => item.kind === "omni");
  historyEmpty.hidden = visible.length > 0;
  for (const item of visible) {
    const li = document.createElement("li");
    li.className = "history-item";
    const button = document.createElement("button");
    button.className = "btn btn-ghost";
    button.type = "button";
    const when = new Date(item.createdAt).toLocaleString();
    const top = item.result?.answers[0]?.topLabel ?? item.status;
    setText(button, `${item.label} · ${top} · ${when}`);
    button.addEventListener("click", () => {
      const compare = items.find((other) => other.kind === "compare" && other.pairId !== null && other.pairId === item.pairId);
      renderOutcome(item, compare ?? null);
      if (item.mediaId) showPreview(api(`api/media/${item.mediaId}`), item.modality);
      else if (item.sampleId && Object.hasOwn(SAMPLES, item.sampleId)) selectSample(item.sampleId as SampleId);
    });
    li.append(button);
    historyEl.append(li);
  }
}

async function loadHistory(): Promise<void> {
  const res = await fetch(api("api/judgments"));
  if (!res.ok) return;
  const body = (await res.json()) as { judgments?: JudgmentView[] };
  renderHistory(body.judgments ?? []);
}

function permissionMessage(kind: "audio" | "video" | "photo", err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    if (kind === "audio") return "The browser blocked the microphone. Upload a WAV or MP3, or use a sample.";
    if (kind === "photo") return "The browser blocked the camera. Upload a photo, or use a sample.";
    return "The browser blocked the camera. Upload an MP4 or WebM, or use a sample.";
  }
  if (name === "NotFoundError") return "No camera or microphone was found. Upload a file or use a sample.";
  return "Recording did not start. Upload a file or use a sample.";
}

let photoResolver: ((take: boolean) => void) | null = null;

function detachFinder(): void {
  const finder = $<HTMLVideoElement>("finder");
  finder.pause();
  finder.srcObject = null;
  finder.hidden = true;
}

function attachFinder(local: MediaStream): void {
  const finder = $<HTMLVideoElement>("finder");
  finder.srcObject = local;
  finder.muted = true;
  finder.playsInline = true;
  finder.hidden = false;
  void finder.play().catch(() => undefined);
}

function stopTracks(): void {
  cancelled = true;
  window.clearInterval(ticker);
  ticker = 0;
  recording = false;
  if (photoResolver) {
    const resolve = photoResolver;
    photoResolver = null;
    resolve(false);
  }
  if (recorder && recorder.state !== "inactive") recorder.stop();
  recorder = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  detachFinder();
  overlay.hidden = true;
  $<HTMLButtonElement>("shutter").hidden = true;
}

function formatLeft(seconds: number): string {
  return `0:${String(Math.max(0, seconds)).padStart(2, "0")}`;
}

async function blobToWav(blob: Blob): Promise<Blob> {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const duration = Math.min(decoded.duration, 15);
    const rate = 16_000;
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(duration * rate)), rate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    const samples = rendered.getChannelData(0);
    const data = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
      data[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    const buffer = new ArrayBuffer(44 + data.length * 2);
    const view = new DataView(buffer);
    const write = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    write(0, "RIFF");
    view.setUint32(4, 36 + data.length * 2, true);
    write(8, "WAVE");
    write(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, "data");
    view.setUint32(40, data.length * 2, true);
    new Uint8Array(buffer, 44).set(new Uint8Array(data.buffer));
    return new Blob([buffer], { type: "audio/wav" });
  } finally {
    await ctx.close();
  }
}

function pickMime(kind: "audio" | "video"): string {
  const candidates = kind === "audio" ? ["audio/webm", "audio/mp4"] : ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
  return candidates.find((type) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) ?? "";
}

function showCaptureChrome(kind: "audio" | "video" | "photo"): void {
  const photo = kind === "photo";
  $<HTMLButtonElement>("shutter").hidden = !photo;
  $<HTMLButtonElement>("stop-rec").hidden = photo;
  countEl.hidden = photo;
  countHint.hidden = photo;
  overlay.hidden = false;
}

async function grabFrame(video: HTMLVideoElement): Promise<Blob | null> {
  const sourceW = video.videoWidth || 640;
  const sourceH = video.videoHeight || 480;
  const scale = Math.min(1, 1024 / Math.max(sourceW, sourceH));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceW * scale));
  canvas.height = Math.max(1, Math.round(sourceH * scale));
  canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
}

async function startCapture(kind: "audio" | "video" | "photo"): Promise<void> {
  showError("");
  permEl.hidden = true;
  if (kind === "photo" && navigator.maxTouchPoints > 0) {
    $<HTMLInputElement>("snap-cam").click();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    permEl.hidden = false;
    setText(permEl, "This browser has no media capture. Choose a file or a sample.");
    return;
  }
  let local: MediaStream | null = null;
  try {
    local = await navigator.mediaDevices.getUserMedia(
      kind === "audio" ? { audio: true } : kind === "photo" ? { video: { facingMode: "environment" }, audio: false } : { audio: true, video: { facingMode: "environment" } },
    );
    stream = local;
    if (kind !== "audio") attachFinder(local);
    cancelled = false;
    showCaptureChrome(kind);
    if (kind === "photo") {
      const take = await new Promise<boolean>((resolve) => {
        photoResolver = resolve;
      });
      photoResolver = null;
      if (!take) {
        setText(mediaNote, "Recording cancelled.");
        return;
      }
      const blob = await grabFrame($<HTMLVideoElement>("finder"));
      if (!blob) {
        showError("The photo could not be saved. Choose a file instead.");
        return;
      }
      await selectFile(new File([blob], "photo.jpg", { type: "image/jpeg" }));
      return;
    }
    const mime = pickMime(kind);
    const options: MediaRecorderOptions = { audioBitsPerSecond: 128_000 };
    if (mime) options.mimeType = mime;
    if (kind === "video") options.videoBitsPerSecond = 1_500_000;
    recorder = new MediaRecorder(local, options);
    chunks = [];
    recording = true;
    const limitMs = kind === "audio" ? 15_000 : 9_500;
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    const stopped = new Promise<void>((resolve) => {
      recorder?.addEventListener("stop", () => resolve(), { once: true });
    });
    setText($("count-label"), kind === "audio" ? "Voice note" : "Video");
    setText(countHint, kind === "audio" ? "15 seconds at most. Cancel discards it." : "Stops near 9.5 seconds. Cancel discards it.");
    const started = Date.now();
    setText(countEl, formatLeft(Math.ceil(limitMs / 1000)));
    ticker = window.setInterval(() => {
      const leftMs = limitMs - (Date.now() - started);
      setText(countEl, formatLeft(Math.ceil(leftMs / 1000)));
      if (leftMs <= 0) finishStop();
    }, 200);
    recorder.start();
    await stopped;
    await finishRecording(kind, mime || recorder?.mimeType || "");
  } catch (err) {
    if (err instanceof DOMException || !local) {
      permEl.hidden = false;
      setText(permEl, permissionMessage(kind === "photo" ? "photo" : kind, err));
    } else {
      showError("Recording did not start. Upload a file or use a sample.");
    }
  } finally {
    window.clearInterval(ticker);
    ticker = 0;
    recording = false;
    photoResolver = null;
    recorder = null;
    if (local) {
      local.getTracks().forEach((track) => track.stop());
      if (stream === local) stream = null;
    }
    detachFinder();
    overlay.hidden = true;
    $<HTMLButtonElement>("shutter").hidden = true;
    $<HTMLButtonElement>("stop-rec").hidden = false;
    countEl.hidden = false;
    countHint.hidden = false;
  }
}

function finishStop(): void {
  if (photoResolver) {
    const resolve = photoResolver;
    photoResolver = null;
    resolve(!cancelled);
    return;
  }
  if (!recording) return;
  recording = false;
  window.clearInterval(ticker);
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

async function finishRecording(kind: "audio" | "video", mime: string): Promise<void> {
  const parts = chunks;
  chunks = [];
  stream = null;
  recorder = null;
  if (cancelled || parts.length === 0) {
    setText(mediaNote, "Recording cancelled.");
    return;
  }
  const blob = new Blob(parts, { type: mime || (kind === "audio" ? "audio/webm" : "video/webm") });
  try {
    if (kind === "audio") {
      const wav = await blobToWav(blob);
      await selectFile(new File([wav], "voice.wav", { type: "audio/wav" }));
      return;
    }
    const type = blob.type || "video/webm";
    const name = type.includes("mp4") ? "clip.mp4" : "clip.webm";
    await selectFile(new File([blob], name, { type }));
  } catch {
    showError(kind === "audio" ? "Could not convert the recording to WAV. Upload a WAV or MP3." : "Could not keep that recording. Upload an MP4 or WebM.");
  }
}

function showTurnstileFailure(host: HTMLElement): void {
  widgetId = "";
  host.replaceChildren();
  const note = document.createElement("p");
  note.className = "hint";
  setText(note, "Security check did not load");
  const retry = document.createElement("button");
  retry.className = "btn";
  retry.type = "button";
  setText(retry, "Retry");
  retry.addEventListener("click", () => {
    host.replaceChildren();
    void mountTurnstile();
  });
  host.append(note, retry);
}

async function mountTurnstile(): Promise<void> {
  const res = await fetch(api("api/session"));
  if (!res.ok) {
    showError("The session could not be loaded.");
    return;
  }
  session = (await res.json()) as SessionPayload;
  testNote.hidden = !(session.stub || session.testWidget);
  const host = $("turnstile");
  if (!session.siteKey) {
    setText(host, "Turnstile site key is not set.");
    return;
  }
  const render = () => {
    if (widgetId || typeof turnstile === "undefined") return;
    widgetId = turnstile.render(host, {
      sitekey: session!.siteKey,
      action: "judge",
      size: window.innerWidth < 360 ? "compact" : "flexible",
      theme: document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark",
    });
  };
  render();
  const started = Date.now();
  const timer = window.setInterval(() => {
    render();
    if (widgetId) {
      window.clearInterval(timer);
      return;
    }
    if (Date.now() - started >= 30_000) {
      window.clearInterval(timer);
      showTurnstileFailure(host);
    }
  }, 200);
}

async function judge(): Promise<void> {
  showError("");
  draft = readDraftFromDom();
  const validated = validateQuestions(draft.map((question) => ({ instructions: question.instructions, options: question.options })));
  if (!validated.ok) {
    showError(validated.message);
    return;
  }
  if (!picked) {
    showError("Choose a sample, a file, or a recording.");
    return;
  }
  let token = widgetId && typeof turnstile !== "undefined" ? turnstile.getResponse(widgetId) : "";
  if (!token && session?.testWidget) token = "XXXX.DUMMY.TOKEN.XXXX";
  if (!token) {
    showError("Complete the Turnstile check first.");
    return;
  }
  const button = $<HTMLButtonElement>("judge");
  button.disabled = true;
  setText(button, "Judging…");
  const compare = $<HTMLInputElement>("compare").checked;
  try {
    let response: Response;
    if (picked.source === "file") {
      const form = new FormData();
      form.set("turnstileToken", token);
      form.set("questions", JSON.stringify(validated.questions));
      form.set("compare", compare ? "1" : "0");
      form.set("file", picked.file);
      response = await fetch(api("api/judge"), { method: "POST", body: form });
    } else {
      response = await fetch(api("api/judge"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turnstileToken: token, questions: validated.questions, compare, sampleId: picked.sampleId }),
      });
    }
    const body = (await response.json()) as { judgment?: JudgmentView; comparison?: unknown; error?: { message?: string } };
    if (!response.ok && !body.judgment) {
      showError(body.error?.message || "The judgment failed.");
      return;
    }
    if (body.judgment) renderOutcome(body.judgment, body.comparison ?? null);
    if (!response.ok && body.judgment?.error) showError(body.judgment.error);
    await loadHistory();
  } catch {
    showError("The request did not finish. Try again.");
  } finally {
    button.disabled = false;
    setText(button, "Judge");
    if (widgetId && typeof turnstile !== "undefined") turnstile.reset(widgetId);
  }
}

function bind(): void {
  renderPresets();
  renderQuestions();
  selectSample("package");
  $<HTMLButtonElement>("snap").addEventListener("click", () => void startCapture("photo"));
  $<HTMLButtonElement>("voice").addEventListener("click", () => void startCapture("audio"));
  $<HTMLButtonElement>("film").addEventListener("click", () => void startCapture("video"));
  $<HTMLButtonElement>("cancel-rec").addEventListener("click", () => {
    cancelled = true;
    finishStop();
  });
  $<HTMLButtonElement>("stop-rec").addEventListener("click", () => {
    cancelled = false;
    finishStop();
  });
  $<HTMLButtonElement>("shutter").addEventListener("click", () => {
    cancelled = false;
    finishStop();
  });
  $<HTMLInputElement>("file").addEventListener("change", () => {
    const file = $<HTMLInputElement>("file").files?.[0];
    if (file) void selectFile(file);
  });
  $<HTMLInputElement>("capture").addEventListener("change", () => {
    const file = $<HTMLInputElement>("capture").files?.[0];
    if (file) void selectFile(file);
  });
  $<HTMLInputElement>("snap-cam").addEventListener("change", () => {
    const file = $<HTMLInputElement>("snap-cam").files?.[0];
    if (file) void selectFile(file);
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-sample]")) {
    button.addEventListener("click", () => {
      const id = button.dataset.sample ?? "";
      if (Object.hasOwn(SAMPLES, id)) selectSample(id as SampleId);
    });
  }
  $<HTMLButtonElement>("add-question").addEventListener("click", () => {
    draft = readDraftFromDom();
    if (draft.length >= 5) return;
    draft.push({ instructions: "", options: ["", ""] });
    renderQuestions();
    markPresets(null);
  });
  $<HTMLButtonElement>("own").addEventListener("click", () => {
    draft = [{ instructions: "", options: ["", ""] }];
    renderQuestions();
    markPresets(null);
  });
  $<HTMLButtonElement>("judge").addEventListener("click", () => void judge());
  $<HTMLButtonElement>("theme").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* ignore */
    }
  });
}

bind();
void mountTurnstile();
void loadHistory();
