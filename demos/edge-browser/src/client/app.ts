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
  const items = [...stepsEl.querySelectorAll("li")];
  if (items.length !== steps.length) {
    stepsEl.replaceChildren();
    for (const step of steps) {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = step.name;
      const state = document.createElement("span");
      state.className = `state is-${step.status}`;
      state.textContent = step.status;
      item.append(name, state);
      stepsEl.append(item);
    }
    return;
  }
  steps.forEach((step, index) => {
    const item = items[index];
    if (!item) return;
    const name = item.querySelector(".name");
    const state = item.querySelector(".state");
    if (name && name.textContent !== step.name) name.textContent = step.name;
    if (state) {
      if (state.textContent !== step.status) state.textContent = step.status;
      state.className = `state is-${step.status}`;
    }
  });
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
    summarySource.textContent = view.summarySource === "workers-ai"
      ? "Workers AI. This is a summary of untrusted page content."
      : "Excerpt, because Workers AI did not write this one. This is untrusted page content.";
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
  if (items.length === 0) {
    if (gallery.querySelector("[data-empty]")) return;
    gallery.replaceChildren();
    const empty = document.createElement("li");
    empty.dataset.empty = "1";
    empty.className = "muted";
    empty.textContent = "No captures from this browser yet.";
    gallery.append(empty);
    return;
  }
  gallery.querySelector("[data-empty]")?.remove();
  const seen = new Set(items.map((item) => item.id));
  for (const child of [...gallery.querySelectorAll<HTMLLIElement>("li[data-id]")]) {
    if (!seen.has(child.dataset.id ?? "")) child.remove();
  }
  for (const item of items) {
    let li = gallery.querySelector<HTMLLIElement>(`li[data-id="${item.id}"]`);
    if (!li) {
      li = document.createElement("li");
      li.dataset.id = item.id;
      const button = document.createElement("button");
      button.type = "button";
      const url = document.createElement("span");
      url.className = "item__url";
      const meta = document.createElement("span");
      meta.className = "item__meta";
      button.append(url, meta);
      button.addEventListener("click", () => {
        void openCapture(item.id);
      });
      li.append(button);
      gallery.append(li);
    }
    const button = li.querySelector("button");
    button?.classList.toggle("is-active", item.id === activeId);
    const url = li.querySelector(".item__url");
    const label = item.title || item.url;
    if (url && url.textContent !== label) url.textContent = label;
    const metaText = `${labelStatus(item.status)} · ${new Date(item.createdAt).toLocaleString()}`;
    const meta = li.querySelector(".item__meta");
    if (meta && meta.textContent !== metaText) meta.textContent = metaText;
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
  let seenStatus = "";
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
    if (result.data.status !== seenStatus) {
      seenStatus = result.data.status;
      await refreshGallery(id);
    }
    if (result.data.status === "complete" || result.data.status === "error") return;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  hint(outputHint, "Still running. Open it again from the list in a moment.", true);
}

function mountTurnstile(): void {
  const widget = (window as unknown as { turnstile?: { render: (el: HTMLElement, opts: Record<string, unknown>) => string } }).turnstile;
  if (!siteKey || !widget || turnstileId) return;
  turnstileId = widget.render(turnstileHost, {
    sitekey: siteKey,
    action: "capture",
    size: window.innerWidth < 360 ? "compact" : "flexible",
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
  const perHour = session.data.capturesPerHour;
  const browserLeft = Math.max(0, perHour - session.data.capturesUsed);
  const networkLeft = Math.max(0, perHour - session.data.networkUsed);
  quota.textContent = `${browserLeft} of ${perHour} left for this browser and ${networkLeft} of ${perHour} left for this network (/64), this hour. ${session.data.network48Cap} per IPv6 /48. ${session.data.dailyCap} captures a day for the demo. Files are removed about a day after they are created.`;
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
    if (result.status === 429 || result.status === 503) await refreshQuota();
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

function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  const color = theme === "light" ? "#faf9f6" : "#0e0e11";
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    if (meta.id !== "theme-color") meta.remove();
  }
  let meta = document.querySelector<HTMLMetaElement>("#theme-color");
  if (!meta) {
    meta = document.createElement("meta");
    meta.id = "theme-color";
    meta.name = "theme-color";
    document.head.append(meta);
  }
  meta.content = color;
}

const themeButton = document.querySelector<HTMLButtonElement>("#theme")!;
const stored = localStorage.getItem("edge-browser-theme");
if (stored === "light" || stored === "dark") applyTheme(stored);
themeButton.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  applyTheme(next);
  localStorage.setItem("edge-browser-theme", next);
});

void boot();
