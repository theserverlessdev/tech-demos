import { connect, launch, limits, sessions, type ActiveSession, type Browser, type BrowserContext, type BrowserContextOptions, type BrowserWorker, type Page } from "@cloudflare/puppeteer";
import { LIMITS } from "../shared/limits";
import { objectKey } from "./db";
import { PermanentError } from "./errors";
import { acquisitionsAllowed, authorizeSubresource, createGuard, rankSessions, sessionHasCapacity, sessionPrefix, type PageGuard } from "./policy";
import { authorizeNavigation, cloudflareDoh } from "./ssrf";

const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PHONE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

const NEUTER = `(() => {
  const block = function Blocked() { throw new Error("Blocked in this capture."); };
  for (const name of ["WebSocket", "WebTransport", "RTCPeerConnection", "SharedWorker", "Worker"]) {
    try { window[name] = block; } catch (err) { /* The page hid the constructor. */ }
  }
  try { window.open = function open() { return null; }; } catch (err) { /* ignore */ }
  try {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register = function register() { return Promise.reject(new Error("Blocked in this capture.")); };
    }
  } catch (err) { /* ignore */ }
})();`;

export type PageProfile = "desktop" | "phone";

type Artifact = { body: Uint8Array | string; contentType: string; filename: "desktop.png" | "desktop.jpg" | "phone.png" | "phone.jpg" | "page.pdf" | "page.md" };

type Opened = { finalUrl: string; title: string; guard: PageGuard };

type PopupTarget = { type: () => string; page: () => Promise<{ close: () => Promise<void> } | null> };

export function browserEndpoint(binding: Env["BROWSER"] | undefined): BrowserWorker | null {
  if (!binding || typeof binding.fetch !== "function") return null;
  return { fetch: binding.fetch.bind(binding) };
}

function cleanTitle(value: string): string {
  return value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
}

/**
 * newPage() emits targetcreated before it resolves, and a browser-level listener
 * sees every context. Attach only after newPage, on this context, and skip our page.
 */
export async function openContextPage<T extends PopupTarget, P extends { target: () => T }>(context: {
  on: (event: "targetcreated", handler: (target: T) => void) => void;
  newPage: () => Promise<P>;
}): Promise<P> {
  const page = await context.newPage();
  const mine = page.target();
  context.on("targetcreated", (target) => {
    if (target === mine || target.type() !== "page") return;
    void target.page().then((popup) => popup?.close()).catch(() => undefined);
  });
  return page;
}

async function contextCount(browser: Browser): Promise<number | null> {
  try {
    const client = await browser.target().createCDPSession();
    try {
      const result = (await client.send("Target.getBrowserContexts")) as { browserContextIds?: string[] };
      return result.browserContextIds?.length ?? 0;
    } finally {
      await client.detach().catch(() => undefined);
    }
  } catch (err) {
    console.error(JSON.stringify({ event: "browser_contexts_failed", error: String(err).slice(0, 200) }));
    return null;
  }
}

async function refuseIfCapped(binding: BrowserWorker): Promise<void> {
  let account;
  try {
    account = await limits(binding);
  } catch (err) {
    console.error(JSON.stringify({ event: "browser_limits_failed", error: String(err).slice(0, 200) }));
    throw new Error("Browser Rendering limits could not be read. Try again in a minute.");
  }
  const allowed = acquisitionsAllowed({
    allowedBrowserAcquisitions: account.allowedBrowserAcquisitions,
    activeSessions: account.activeSessions.length,
    maxConcurrentSessions: account.maxConcurrentSessions,
  });
  if (!allowed) throw new PermanentError("Browser Rendering is at its concurrency cap. Try again in a minute.");
}

async function createCaptureContext(browser: Browser): Promise<BrowserContext> {
  // disposeOnDetach drops the context if this worker disconnects before context.close().
  // @cloudflare/puppeteer 1.4.0 only forwards proxyServer and proxyBypassList, so the
  // flag is passed only when this build's createBrowserContext mentions it.
  // The finally block still closes the context before disconnect().
  if (browser.createBrowserContext.toString().includes("disposeOnDetach")) {
    return browser.createBrowserContext({ disposeOnDetach: true } as BrowserContextOptions);
  }
  return browser.createBrowserContext();
}

async function arm(page: Page): Promise<{ guard: PageGuard; seal: () => Promise<void> }> {
  const guard = createGuard();
  const cache = new Map<string, Promise<string[]>>();
  let hops = 0;
  let sealed = false;
  await page.setBypassServiceWorker(true);
  await page.evaluateOnNewDocument(NEUTER);
  page.on("dialog", (dialog) => {
    void dialog.dismiss();
  });
  page.on("workercreated", (worker) => {
    void (async () => {
      try {
        const client = worker.client;
        await client.send("Network.enable");
        await client.send("Network.emulateNetworkConditions", {
          offline: true,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        });
      } catch (err) {
        console.error(JSON.stringify({ event: "worker_isolate_failed", error: String(err).slice(0, 200) }));
        guard.blockMain("A page worker could not be isolated.");
      }
    })();
  });
  page.on("response", (response) => {
    let ip = "";
    try {
      ip = response.remoteAddress().ip ?? "";
    } catch {
      ip = "";
    }
    guard.noteResponse(ip, response.status());
  });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    void (async () => {
      const abort = async () => {
        try {
          await request.abort("blockedbyclient");
        } catch {
          /* The request already settled. */
        }
      };
      try {
        if (sealed) {
          await abort();
          return;
        }
        const target = request.url();
        const main = request.isNavigationRequest() && request.frame() === page.mainFrame();
        if (target === "about:blank" || (!main && (target.startsWith("data:") || target.startsWith("blob:")))) {
          await request.continue();
          return;
        }
        if (request.isNavigationRequest() && request.resourceType() !== "document") {
          if (main) guard.blockMain("Blocked a navigation that was not a document.");
          else guard.abortSubresource();
          await abort();
          return;
        }
        const decision = main
          ? await (async () => {
              hops += 1;
              if (hops > LIMITS.maxRedirectHops + 1) {
                guard.blockMain("The page redirected too many times.");
                return null;
              }
              return authorizeNavigation(target, cloudflareDoh);
            })()
          : await authorizeSubresource(target, cache, cloudflareDoh);
        if (sealed) {
          await abort();
          return;
        }
        if (!decision || !decision.ok) {
          if (main && decision) guard.blockMain(decision.message);
          else if (!main) guard.abortSubresource();
          await abort();
          return;
        }
        await request.continue();
      } catch {
        const main = request.isNavigationRequest() && request.frame() === page.mainFrame();
        if (main) guard.blockMain("The request was blocked.");
        else guard.abortSubresource();
        await abort();
      }
    })();
  });
  return {
    guard,
    seal: async () => {
      sealed = true;
      await page.setOfflineMode(true).catch(() => undefined);
    },
  };
}

function blockedError(guard: PageGuard): PermanentError | null {
  const message = guard.failure();
  return message ? new PermanentError(message) : null;
}

async function openPage(page: Page, url: string, profile: PageProfile): Promise<Opened> {
  const phone = profile === "phone";
  const width = phone ? LIMITS.phoneWidth : LIMITS.desktopWidth;
  const fallback = phone ? LIMITS.phoneHeight : LIMITS.desktopHeight;
  await page.setViewport({ width, height: fallback, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
  await page.setUserAgent(phone ? PHONE_UA : DESKTOP_UA);
  page.setDefaultNavigationTimeout(LIMITS.navigationTimeoutMs);
  page.setDefaultTimeout(LIMITS.navigationTimeoutMs);
  const armed = await arm(page);

  let response: Awaited<ReturnType<Page["goto"]>>;
  try {
    response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: LIMITS.navigationTimeoutMs });
  } catch (err) {
    const blocked = blockedError(armed.guard);
    if (blocked) throw blocked;
    throw err;
  }
  const early = blockedError(armed.guard);
  if (early) throw early;
  if (!response) throw new PermanentError("The page did not respond.");

  const headers = response.headers();
  const type = headers["content-type"] ?? "";
  const disposition = headers["content-disposition"] ?? "";
  if (/attachment/i.test(disposition)) throw new PermanentError("Downloads are blocked.");
  if (!/text\/html|application\/xhtml\+xml/i.test(type)) throw new PermanentError("The page is not an HTML document.");
  const length = Number(headers["content-length"] ?? "0");
  if (Number.isFinite(length) && length > LIMITS.maxHtmlBytes) throw new PermanentError("The page is too large.");

  const finalDecision = await authorizeNavigation(page.url(), cloudflareDoh);
  if (!finalDecision.ok) throw new PermanentError(finalDecision.message);
  await page.waitForNetworkIdle({ idleTime: 400, timeout: LIMITS.networkIdleMs }).catch(() => undefined);
  const afterIdle = blockedError(armed.guard);
  if (afterIdle) throw afterIdle;

  const height = await shotHeight(page, fallback);
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
  await page.evaluate(async (total: number) => {
    const step = Math.max(200, window.innerHeight || 800);
    for (let y = 0; y < total; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    window.scrollTo(0, 0);
  }, height);
  await page.waitForNetworkIdle({ idleTime: 400, timeout: LIMITS.networkIdleMs }).catch(() => undefined);
  const afterSettle = blockedError(armed.guard);
  if (afterSettle) throw afterSettle;
  await armed.seal();

  const htmlChars = await page.evaluate(() => (document.documentElement ? document.documentElement.outerHTML.length : 0));
  if (htmlChars > LIMITS.maxHtmlChars) throw new PermanentError("The page is too large.");
  const title = cleanTitle(await page.title());
  return { finalUrl: finalDecision.url, title, guard: armed.guard };
}

async function shotHeight(page: Page, fallback: number): Promise<number> {
  const measured = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    return Math.max(root?.scrollHeight ?? 0, body?.scrollHeight ?? 0);
  });
  return Math.min(LIMITS.maxShotHeight, Math.max(fallback, measured || fallback));
}

async function shoot(page: Page, profile: PageProfile): Promise<Artifact> {
  const width = profile === "phone" ? LIMITS.phoneWidth : LIMITS.desktopWidth;
  const fallback = profile === "phone" ? LIMITS.phoneHeight : LIMITS.desktopHeight;
  const height = await shotHeight(page, fallback);
  const clip = { x: 0, y: 0, width, height };
  let body = await page.screenshot({ type: "png", clip, captureBeyondViewport: true });
  let contentType = "image/png";
  let filename: Artifact["filename"] = profile === "phone" ? "phone.png" : "desktop.png";
  if (body.byteLength > LIMITS.maxScreenshotBytes) {
    body = await page.screenshot({ type: "jpeg", quality: 60, clip, captureBeyondViewport: true });
    contentType = "image/jpeg";
    filename = profile === "phone" ? "phone.jpg" : "desktop.jpg";
  }
  if (body.byteLength > LIMITS.maxScreenshotBytes) throw new PermanentError("The screenshot is too large.");
  return { body, contentType, filename };
}

async function produce(page: Page, profile: PageProfile): Promise<Artifact[]> {
  if (profile === "phone") return [await shoot(page, "phone")];
  const shot = await shoot(page, "desktop");
  const pdf = await page.pdf({ printBackground: true, format: "A4", pageRanges: "1-20", timeout: LIMITS.navigationTimeoutMs });
  if (pdf.byteLength > LIMITS.maxPdfBytes) throw new PermanentError("The PDF is too large.");
  const markdown = await page.evaluate((max: number) => {
    const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "CANVAS", "IFRAME", "OBJECT", "TEMPLATE"]);
    const lines: string[] = [];
    const textOf = (node: Element) => (node.textContent ?? "").replace(/\s+/g, " ").trim();
    const walk = (node: Node): void => {
      if (!(node instanceof Element)) return;
      if (skip.has(node.tagName)) return;
      const tag = node.tagName;
      if (/^H[1-6]$/.test(tag)) {
        const text = textOf(node);
        if (text) lines.push("#".repeat(Number(tag.slice(1))) + " " + text, "");
        return;
      }
      if (tag === "PRE") {
        const text = (node.textContent ?? "").trim();
        if (text) lines.push("```", text.slice(0, 2000), "```", "");
        return;
      }
      if (tag === "LI") {
        const text = textOf(node);
        if (text) lines.push(`- ${text}`);
        return;
      }
      if (tag === "P" || tag === "BLOCKQUOTE") {
        const text = textOf(node);
        if (text) lines.push(text, "");
        return;
      }
      for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes.item(i);
        if (child) walk(child);
      }
    };
    if (document.body) walk(document.body);
    const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
    return text || "_The page had no text._";
  }, LIMITS.maxMarkdownChars);
  return [
    shot,
    { body: pdf, contentType: "application/pdf", filename: "page.pdf" },
    { body: markdown, contentType: "text/markdown; charset=utf-8", filename: "page.md" },
  ];
}

async function connectWithCapacity(binding: BrowserWorker, listed: ActiveSession[]): Promise<{ browser: Browser; sessionId: string } | { browser: null; full: boolean }> {
  let full = false;
  for (const session of rankSessions(listed)) {
    let candidate: Browser | null = null;
    try {
      candidate = await connect(binding, session.sessionId);
      const count = await contextCount(candidate);
      if (sessionHasCapacity(count)) {
        return { browser: candidate, sessionId: candidate.sessionId() };
      }
      full = true;
      await candidate.disconnect().catch(() => undefined);
    } catch (err) {
      console.error(JSON.stringify({ event: "browser_connect_failed", error: String(err).slice(0, 200) }));
      if (candidate) await candidate.disconnect().catch(() => undefined);
    }
  }
  return { browser: null, full };
}

export async function capturePage(env: Env, captureId: string, url: string, profile: PageProfile): Promise<{ mode: "connect" | "launch"; sessionId: string; note: string; finalUrl: string; title: string }> {
  const binding = browserEndpoint(env.BROWSER);
  if (!binding) throw new PermanentError("Browser Rendering is not bound to this Worker.");

  let browser: Browser | null = null;
  let mode: "connect" | "launch" = "launch";
  let sessionId = "";
  let note = "Launched a fresh browser with keep_alive of 5 minutes.";

  try {
    let active: ActiveSession[] = [];
    try {
      active = await sessions(binding);
    } catch (err) {
      console.error(JSON.stringify({ event: "browser_sessions_failed", error: String(err).slice(0, 200) }));
      active = [];
    }
    const picked = await connectWithCapacity(binding, active);
    if (picked.browser) {
      browser = picked.browser;
      mode = "connect";
      sessionId = picked.sessionId;
      note = `Reused warm session ${sessionPrefix(sessionId)}. keep_alive is 5 minutes.`;
    } else {
      await refuseIfCapped(binding);
      const overflow = picked.full;
      browser = await launch(binding, { keep_alive: overflow ? LIMITS.overflowKeepAliveMs : LIMITS.keepAliveMs });
      mode = "launch";
      sessionId = browser.sessionId();
      note = overflow
        ? "Every warm session is at its context limit, so this step launched a browser with keep_alive of 10 seconds."
        : "Launched a fresh browser with keep_alive of 5 minutes.";
    }

    const context = await createCaptureContext(browser);
    try {
      const page = await openContextPage(context);
      const opened = await openPage(page, url, profile);
      const artifacts = await produce(page, profile);
      const blocked = opened.guard.failure();
      if (blocked) throw new PermanentError(blocked);
      for (const artifact of artifacts) {
        await env.BUCKET.put(objectKey(captureId, artifact.filename), artifact.body, {
          httpMetadata: { contentType: artifact.contentType },
        });
      }
      return { mode, sessionId: sessionPrefix(sessionId), note, finalUrl: opened.finalUrl, title: opened.title };
    } finally {
      await context.close().catch(() => undefined);
    }
  } finally {
    if (browser) {
      try {
        await browser.disconnect();
      } catch (err) {
        console.error(JSON.stringify({ event: "browser_release_failed", error: String(err).slice(0, 200) }));
      }
    }
  }
}
