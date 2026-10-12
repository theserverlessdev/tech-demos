import { connect, launch, limits, sessions, type Browser, type Page, type Target } from "@cloudflare/puppeteer";
import { LIMITS } from "../shared/limits";
import { objectKey } from "./db";
import { PermanentError } from "./errors";
import { acquisitionsAllowed, cachedAuthorize, createGuard, reusePlan, sessionPrefix, type PageGuard } from "./policy";
import { browserEndpoint } from "./session";
import { authorizeNavigation, cloudflareDoh } from "./ssrf";

const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PHONE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

const NEUTER = `(() => {
  const block = function Blocked() { throw new Error("Blocked in this capture."); };
  for (const name of ["WebSocket", "WebTransport", "RTCPeerConnection", "SharedWorker"]) {
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

type Opened = { finalUrl: string; title: string; guard: PageGuard; seal: () => Promise<void> };

function cleanTitle(value: string): string {
  return value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
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

async function refuseIfCapped(binding: NonNullable<ReturnType<typeof browserEndpoint>>): Promise<void> {
  let account;
  try {
    account = await limits(binding);
  } catch (err) {
    console.error(JSON.stringify({ event: "browser_limits_failed", error: String(err).slice(0, 200) }));
    throw new PermanentError("Browser Rendering is at its concurrency cap. Try again in a minute.");
  }
  const allowed = acquisitionsAllowed({
    allowedBrowserAcquisitions: account.allowedBrowserAcquisitions,
    activeSessions: account.activeSessions.length,
    maxConcurrentSessions: account.maxConcurrentSessions,
  });
  if (!allowed) throw new PermanentError("Browser Rendering is at its concurrency cap. Try again in a minute.");
}

function watchPopups(browser: Browser, allowed: Set<Target>): void {
  browser.on("targetcreated", (target) => {
    if (target.type() !== "page") return;
    setTimeout(() => {
      if (allowed.has(target)) return;
      void target.page().then((popup) => popup?.close().catch(() => undefined));
    }, 0);
  });
}

async function arm(page: Page): Promise<{ guard: PageGuard; seal: () => Promise<void> }> {
  const guard = createGuard();
  const cache = new Map<string, ReturnType<typeof cachedAuthorize>>();
  let hops = 0;
  let sealed = false;
  await page.setBypassServiceWorker(true);
  await page.evaluateOnNewDocument(NEUTER);
  page.on("dialog", (dialog) => {
    void dialog.dismiss();
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
      try {
        if (sealed) {
          await request.abort("blockedbyclient");
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
          await request.abort("blockedbyclient");
          return;
        }
        if (main) {
          hops += 1;
          if (hops > LIMITS.maxRedirectHops + 1) {
            guard.blockMain("The page redirected too many times.");
            await request.abort("blockedbyclient");
            return;
          }
          const decision = await cachedAuthorize(cache, target, cloudflareDoh);
          if (!decision.ok) {
            guard.blockMain(decision.message);
            await request.abort("blockedbyclient");
            return;
          }
          await request.continue();
          return;
        }
        const decision = await cachedAuthorize(cache, target, cloudflareDoh);
        if (!decision.ok) {
          guard.abortSubresource();
          await request.abort("blockedbyclient");
          return;
        }
        await request.continue();
      } catch {
        const main = request.isNavigationRequest() && request.frame() === page.mainFrame();
        if (main) guard.blockMain(guard.failure() ?? "The request was blocked.");
        else guard.abortSubresource();
        try {
          await request.abort("blockedbyclient");
        } catch {
          /* The request already settled. */
        }
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

async function openPage(page: Page, url: string, profile: PageProfile): Promise<Opened> {
  if (profile === "phone") {
    await page.setViewport({ width: LIMITS.phoneWidth, height: LIMITS.phoneHeight, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await page.setUserAgent(PHONE_UA);
  } else {
    await page.setViewport({ width: LIMITS.desktopWidth, height: LIMITS.desktopHeight, deviceScaleFactor: 1 });
    await page.setUserAgent(DESKTOP_UA);
  }
  page.setDefaultNavigationTimeout(LIMITS.navigationTimeoutMs);
  page.setDefaultTimeout(LIMITS.navigationTimeoutMs);
  const armed = await arm(page);

  let response: Awaited<ReturnType<Page["goto"]>>;
  try {
    response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: LIMITS.navigationTimeoutMs });
  } catch (err) {
    if (armed.guard.failure()) throw new PermanentError(armed.guard.failure() ?? "The page was blocked.");
    throw err;
  }
  if (armed.guard.failure()) throw new PermanentError(armed.guard.failure() ?? "The page was blocked.");
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
  await page.waitForNetworkIdle({ idleTime: 400, timeout: 3_000 }).catch(() => undefined);
  if (armed.guard.failure()) throw new PermanentError(armed.guard.failure() ?? "The page was blocked.");
  await armed.seal();

  const htmlChars = await page.evaluate(() => (document.documentElement ? document.documentElement.outerHTML.length : 0));
  if (htmlChars > LIMITS.maxHtmlBytes) throw new PermanentError("The page is too large.");
  const title = cleanTitle(await page.title());
  return { finalUrl: finalDecision.url, title, guard: armed.guard, seal: armed.seal };
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

export async function capturePage(env: Env, captureId: string, url: string, profile: PageProfile): Promise<{ mode: "connect" | "launch"; sessionId: string; note: string; finalUrl: string; title: string }> {
  const binding = browserEndpoint(env.BROWSER);
  if (!binding) throw new PermanentError("Browser Rendering is not bound to this Worker.");

  let browser: Browser | null = null;
  let dispose: "disconnect" | "close" = "disconnect";
  let mode: "connect" | "launch" = "launch";
  let sessionId = "";
  let note = "Launched a fresh browser with keep_alive of 5 minutes.";

  try {
    let active: { sessionId: string }[] = [];
    try {
      active = await sessions(binding);
    } catch (err) {
      console.error(JSON.stringify({ event: "browser_sessions_failed", error: String(err).slice(0, 200) }));
      active = [];
    }
    const first = active.find((session) => session.sessionId)?.sessionId ?? "";
    let oneOff = false;
    if (first) {
      try {
        browser = await connect(binding, first);
        const count = await contextCount(browser);
        if (reusePlan([first], count) === "connect") {
          mode = "connect";
          dispose = "disconnect";
          sessionId = browser.sessionId();
          note = `Reused warm session ${sessionPrefix(sessionId)}. keep_alive is 5 minutes.`;
        } else {
          await browser.disconnect().catch(() => undefined);
          browser = null;
          oneOff = true;
        }
      } catch (err) {
        console.error(JSON.stringify({ event: "browser_connect_failed", error: String(err).slice(0, 200) }));
        if (browser) await browser.disconnect().catch(() => undefined);
        browser = null;
      }
    }

    if (!browser) {
      await refuseIfCapped(binding);
      dispose = oneOff ? "close" : "disconnect";
      browser = await launch(binding, oneOff ? {} : { keep_alive: LIMITS.keepAliveMs });
      mode = "launch";
      sessionId = browser.sessionId();
      note = oneOff
        ? "The warm session is at its context limit, so this step launched a browser and closed it."
        : "Launched a fresh browser with keep_alive of 5 minutes.";
    }

    const allowed = new Set<Target>();
    watchPopups(browser, allowed);
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      allowed.add(page.target());
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
        if (dispose === "close") await browser.close();
        else await browser.disconnect();
      } catch (err) {
        console.error(JSON.stringify({ event: "browser_release_failed", error: String(err).slice(0, 200) }));
      }
    }
  }
}
