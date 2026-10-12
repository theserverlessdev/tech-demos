import { renderMarkdown } from "../shared/markdown";
import type { CaptureListItem, CaptureStatus, CaptureStep, CaptureView, SessionPayload } from "../shared/types";

const base = location.pathname.startsWith("/demos/edge-browser") ? "/demos/edge-browser" : "";

type ApiError = { error?: { code?: string; message?: string } };

const form = document.querySelector<HTMLFormElement>("#capture-form")!;
const urlInput = document.querySelector<HTMLInputElement>("#url")!;
const captureButton = document.querySelector<HTMLButtonElement>("#capture")!;
const formHint = document.querySelector<HTMLElement>("#form-hint")!;
const turnstileHost = document.querySelector<HTMLElement>("#turnstile")!;
const quota = document.querySelector<HTMLElement>("#quota")!;
const gallery = document.querySelector<HTMLElement>("#gallery")!;
const stepsEl = document.querySelector<HTMLOListElement>("#steps")!;
const outputMeta = document.querySelector<HTMLElement>("#output-meta")!;
const outputHint = document.querySelector<HTMLElement>("#output-hint")!;
const banner = document.querySelector<HTMLElement>("#banner")!;
const summary = document.querySelector<HTMLElement>("#summary")!;
const summaryText = document.querySelector<HTMLElement>("#summary-text")!;
const summarySource = document.querySelector<HTMLElement>("#summary-source")!;
const shots = document.querySelector<HTMLElement>("#shots")!;
const desktop = document.querySelector<HTMLImageElement>("#desktop")!;
const phone = document.querySelector<HTMLImageElement>("#phone")!;
const pdfRow = document.querySelector<HTMLElement>("#pdf-row")!;
const pdfLink = document.querySelector<HTMLAnchorElement>("#pdf")!;
const markdownWrap = document.querySelector<HTMLElement>("#markdown-wrap")!;
const markdownEl = document.querySelector<HTMLElement>("#markdown")!;
const sourceToggle = document.querySelector<HTMLButtonElement>("#source-toggle")!;

let siteKey: string | null = null;
let turnstileId = "";
let turnstileToken = "";
let watchToken = 0;
let showSource = false;
let current: CaptureView | null = null;
let desktopShown = false;
let phoneShown = false;

function hint(el: HTMLElement, text: string, bad = false): void {
  el.textContent = text;
  el.classList.toggle("is-bad", bad && text.length > 0);
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: (T & ApiError) | null }> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}/api${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data: (T & ApiError) | null = null;
  try {
    data = text ? (JSON.parse(text) as T & ApiError) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

function fileUrl(id: string, kind: "desktop" | "phone" | "pdf"): string {
  return `${base}/api/captures/${id}/${kind}`;
}

function renderSteps(steps: CaptureStep[]): void {
  stepsEl.replaceChildren();
  for (const step of steps) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = step.name;
    const state = document.createElement("span");
    state.className = `state is-${step.status}`;
    state.textContent = step.status;
    item.append(name, state);
    stepsEl.append(item);
  }
}

function renderMarkdownView(): void {
  if (!current?.markdown) {
    markdownWrap.hidden = true;
    return;
  }
  markdownWrap.hidden = false;
  if (showSource) {
    markdownEl.replaceChildren();
    const pre = document.createElement("pre");
    pre.className = "source";
    pre.textContent = current.markdown;
    markdownEl.append(pre);
    return;
  }
  markdownEl.innerHTML = renderMarkdown(current.markdown);
}

function renderCapture(view: CaptureView): void {
  current = view;
  outputMeta.textContent = view.title || new URL(view.url).hostname;
  renderSteps(view.steps);
  hint(outputHint, view.error ?? "", Boolean(view.error));
  if (view.browserMode === "stub") {
    banner.hidden = false;
    banner.textContent = view.sessionNote || "Local stand-in. Browser Rendering needs a Cloudflare login.";
  } else if (view.sessionNote) {
    banner.hidden = false;
    banner.textContent = view.sessionNote;
  } else {
    banner.hidden = true;
    banner.textContent = "";
  }
  if (view.summary) {
    summary.hidden = false;
    summaryText.textContent = view.summary;
    summarySource.textContent = view.summarySource === "workers-ai" ? "Workers AI" : "Excerpt, because Workers AI did not write this one";
  } else {
    summary.hidden = true;
  }
  shots.hidden = !(view.hasDesktop || view.hasPhone);
  if (view.hasDesktop && !desktopShown) {
    desktop.src = fileUrl(view.id, "desktop");
    desktopShown = true;
  }
  if (view.hasPhone && !phoneShown) {
    phone.src = fileUrl(view.id, "phone");
    phoneShown = true;
  }
  pdfRow.hidden = !view.hasPdf;
  if (view.hasPdf) pdfLink.href = fileUrl(view.id, "pdf");
  renderMarkdownView();
}

function resetMedia(): void {
  desktopShown = false;
  phoneShown = false;
  desktop.removeAttribute("src");
  phone.removeAttribute("src");
}

function renderGallery(items: CaptureListItem[], activeId: string): void {
  gallery.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = "No captures from this browser yet.";
    gallery.append(empty);
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.classList.toggle("is-active", item.id === activeId);
    const url = document.createElement("span");
    url.className = "item__url";
    url.textContent = item.title || item.url;
    const meta = document.createElement("span");
    meta.className = "item__meta";
    meta.textContent = `${labelStatus(item.status)} · ${new Date(item.createdAt).toLocaleString()}`;
    button.append(url, meta);
    button.addEventListener("click", () => {
      void openCapture(item.id);
    });
    li.append(button);
    gallery.append(li);
  }
}

function labelStatus(status: CaptureStatus): string {
  if (status === "complete") return "Ready";
  if (status === "error") return "Stopped";
  if (status === "running") return "Running";
  return "Queued";
}

async function refreshGallery(activeId = ""): Promise<void> {
  const result = await call<{ captures: CaptureListItem[] }>("/captures");
  renderGallery(result.data?.captures ?? [], activeId);
}

async function openCapture(id: string): Promise<void> {
  const token = ++watchToken;
  resetMedia();
  showSource = false;
  sourceToggle.setAttribute("aria-pressed", "false");
  sourceToggle.textContent = "Source";
  hint(outputHint, "Loading the capture…");
  for (let i = 0; i < 80; i++) {
    if (token !== watchToken) return;
    const result = await call<CaptureView>(`/captures/${id}`);
    if (token !== watchToken) return;
    if (!result.data || result.data.error?.code) {
      hint(outputHint, result.data?.error?.message ?? "The capture could not be loaded.", true);
      return;
    }
    renderCapture(result.data);
    await refreshGallery(id);
    if (result.data.status === "complete" || result.data.status === "error") return;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  hint(outputHint, "Still running. Open it again from the list in a moment.", true);
}

function mountTurnstile(): void {
  const widget = (window as unknown as { turnstile?: { render: (el: HTMLElement, opts: Record<string, unknown>) => string } }).turnstile;
  if (!siteKey || !widget || turnstileId) return;
  turnstileId = widget.render(turnstileHost, {
    sitekey: siteKey,
    action: "capture",
    size: "flexible",
    theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
    callback: (token: string) => {
      turnstileToken = token;
    },
    "expired-callback": () => {
      turnstileToken = "";
    },
    "error-callback": () => {
      turnstileToken = "";
      hint(formHint, "Turnstile could not load. Refresh and try again.", true);
    },
  });
}

async function refreshQuota(): Promise<void> {
  const session = await call<SessionPayload>("/session");
  if (!session.data) return;
  const left = Math.max(0, session.data.capturesPerHour - session.data.capturesUsed);
  quota.textContent = `${left} of ${session.data.capturesPerHour} captures left this hour. Files are deleted after ${session.data.retentionHours} hours.`;
}

async function boot(): Promise<void> {
  const session = await call<SessionPayload>("/session");
  if (session.data?.siteKey) {
    siteKey = session.data.siteKey;
    const wait = window.setInterval(() => {
      mountTurnstile();
      if (turnstileId) window.clearInterval(wait);
    }, 200);
    window.setTimeout(() => window.clearInterval(wait), 8000);
  } else {
    hint(formHint, "Turnstile site key is not set.", true);
  }
  await refreshQuota();
  await refreshGallery();
}

document.querySelectorAll<HTMLButtonElement>(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    urlInput.value = chip.dataset.url ?? "";
    urlInput.focus();
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  hint(formHint, "");
  if (!turnstileToken) {
    hint(formHint, "Complete the Turnstile check first.", true);
    return;
  }
  captureButton.disabled = true;
  const result = await call<{ id: string }>("/captures", {
    method: "POST",
    body: { url: urlInput.value, turnstileToken },
  });
  captureButton.disabled = false;
  turnstileToken = "";
  const widget = (window as unknown as { turnstile?: { reset: (id: string) => void } }).turnstile;
  if (widget && turnstileId) widget.reset(turnstileId);
  if (!result.data || result.data.error || !result.data.id) {
    hint(formHint, result.data?.error?.message ?? "The capture was not started.", true);
    if (result.status === 429) await refreshQuota();
    return;
  }
  hint(formHint, "Capture started.");
  await refreshQuota();
  await openCapture(result.data.id);
});

sourceToggle.addEventListener("click", () => {
  showSource = !showSource;
  sourceToggle.setAttribute("aria-pressed", showSource ? "true" : "false");
  sourceToggle.textContent = showSource ? "Rendered" : "Source";
  renderMarkdownView();
});

const themeButton = document.querySelector<HTMLButtonElement>("#theme")!;
const stored = localStorage.getItem("edge-browser-theme");
if (stored === "light" || stored === "dark") document.documentElement.dataset.theme = stored;
themeButton.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("edge-browser-theme", next);
});

void boot();
