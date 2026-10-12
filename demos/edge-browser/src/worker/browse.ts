import { connect, launch, type Browser, type Page } from "@cloudflare/puppeteer";
import { LIMITS } from "../shared/limits";
import { objectKey } from "./db";
import { PermanentError } from "./errors";
import { browserEndpoint, type SessionPlan } from "./session";
import { assessUrl, authorizeNavigation, cloudflareDoh, isBlockedIp } from "./ssrf";

const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PHONE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

export type ArtifactKind = "desktop" | "phone" | "pdf" | "markdown";

type LivePlan = Extract<SessionPlan, { action: "connect" | "launch" }>;

function pool(env: Env) {
  return env.BROWSER_SESSION.get(env.BROWSER_SESSION.idFromName("pool"));
}

function cleanTitle(value: string): string {
  return value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
}

async function shotHeight(page: Page, fallback: number): Promise<number> {
  const measured = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    return Math.max(root?.scrollHeight ?? 0, body?.scrollHeight ?? 0);
  });
  return Math.min(LIMITS.maxShotHeight, Math.max(fallback, measured || fallback));
}

function extractMarkdown(): string {
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "CANVAS", "IFRAME", "OBJECT", "TEMPLATE"]);
  const lines: string[] = [];
  const textOf = (node: Element) => (node.textContent ?? "").replace(/\s+/g, " ").trim();
  const walk = (node: Node): void => {
    if (!(node instanceof Element)) return;
    if (skip.has(node.tagName)) return;
    const tag = node.tagName;
    if (/^H[1-6]$/.test(tag)) {
      const text = textOf(node);
      if (text) lines.push(`${"#".repeat(Number(tag.slice(1)))} ${text}`, "");
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
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function arm(page: Page): Promise<() => string | null> {
  let blocked: string | null = null;
  let hops = 0;
  await page.setBypassServiceWorker(true);
  page.on("dialog", (dialog) => {
    void dialog.dismiss();
  });
  page.on("response", (response) => {
    const target = response.url();
    if (target.startsWith("data:") || target.startsWith("blob:") || target.startsWith("about:")) return;
    const ip = response.remoteAddress().ip;
    if (!ip || isBlockedIp(ip)) blocked = blocked ?? "The page connected to a blocked address.";
  });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    void (async () => {
      try {
        const target = request.url();
        const navigation = request.isNavigationRequest() && request.frame() === page.mainFrame();
        if (target === "about:blank" || (!navigation && (target.startsWith("data:") || target.startsWith("blob:")))) {
          await request.continue();
          return;
        }
        if (request.isNavigationRequest() && request.resourceType() !== "document") {
          blocked = "Blocked a navigation that was not a document.";
          await request.abort("blockedbyclient");
          return;
        }
        if (navigation) {
          hops += 1;
          if (hops > LIMITS.maxRedirectHops + 1) {
            blocked = "The page redirected too many times.";
            await request.abort("blockedbyclient");
            return;
          }
          const decision = await authorizeNavigation(target, cloudflareDoh);
          if (!decision.ok) {
            blocked = decision.message;
            await request.abort("blockedbyclient");
            return;
          }
        } else {
          const decision = assessUrl(target);
          if (!decision.ok) {
            blocked = decision.message;
            await request.abort("blockedbyclient");
            return;
          }
        }
        await request.continue();
      } catch {
        blocked = blocked ?? "The request was blocked.";
        try {
          await request.abort("blockedbyclient");
        } catch {
          /* The request already settled. */
        }
      }
    })();
  });
  return () => blocked;
}

async function openPage(page: Page, url: string, kind: ArtifactKind, blocked: () => string | null): Promise<{ finalUrl: string; title: string }> {
  if (kind === "phone") {
    await page.setViewport({ width: LIMITS.phoneWidth, height: LIMITS.phoneHeight, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await page.setUserAgent(PHONE_UA);
  } else {
    await page.setViewport({ width: LIMITS.desktopWidth, height: LIMITS.desktopHeight, deviceScaleFactor: 1 });
    await page.setUserAgent(DESKTOP_UA);
  }
  page.setDefaultNavigationTimeout(LIMITS.navigationTimeoutMs);
  page.setDefaultTimeout(LIMITS.navigationTimeoutMs);

  let response: Awaited<ReturnType<Page["goto"]>>;
  try {
    response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: LIMITS.navigationTimeoutMs });
  } catch (err) {
    if (blocked()) throw new PermanentError(blocked() ?? "The page was blocked.");
    throw err;
  }
  if (blocked()) throw new PermanentError(blocked() ?? "The page was blocked.");
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
  if (blocked()) throw new PermanentError(blocked() ?? "The page was blocked.");

  const html = await page.content();
  if (html.length > LIMITS.maxHtmlBytes) throw new PermanentError("The page is too large.");
  const title = cleanTitle(await page.title());
  return { finalUrl: finalDecision.url, title };
}

async function produce(page: Page, kind: ArtifactKind): Promise<{ body: Uint8Array | string; contentType: string; filename: "desktop.png" | "phone.png" | "page.pdf" | "page.md" }> {
  if (kind === "markdown") {
    const markdown = (await page.evaluate(extractMarkdown)).slice(0, LIMITS.maxMarkdownChars);
    return { body: markdown || "_The page had no text._", contentType: "text/markdown; charset=utf-8", filename: "page.md" };
  }
  if (kind === "pdf") {
    const body = await page.pdf({ printBackground: true, format: "A4", timeout: LIMITS.navigationTimeoutMs });
    if (body.byteLength > LIMITS.maxPdfBytes) throw new PermanentError("The PDF is too large.");
    return { body, contentType: "application/pdf", filename: "page.pdf" };
  }
  const width = kind === "phone" ? LIMITS.phoneWidth : LIMITS.desktopWidth;
  const fallback = kind === "phone" ? LIMITS.phoneHeight : LIMITS.desktopHeight;
  const height = await shotHeight(page, fallback);
  const body = await page.screenshot({
    type: "png",
    clip: { x: 0, y: 0, width, height },
    captureBeyondViewport: true,
  });
  if (body.byteLength > LIMITS.maxScreenshotBytes) throw new PermanentError("The screenshot is too large.");
  return { body, contentType: "image/png", filename: kind === "phone" ? "phone.png" : "desktop.png" };
}

export async function captureArtifact(env: Env, plan: LivePlan, captureId: string, url: string, kind: ArtifactKind): Promise<{ mode: "connect" | "launch"; sessionId: string; note: string; finalUrl: string; title: string }> {
  const binding = browserEndpoint(env.BROWSER);
  if (!binding) throw new PermanentError("Browser Rendering is not configured.");
  const session = pool(env);
  let browser: Browser | null = null;
  let mode: "connect" | "launch" = plan.action === "connect" ? "connect" : "launch";
  let sessionId = "";
  let note = plan.note;
  try {
    if (plan.action === "connect") {
      try {
        browser = await connect(binding, plan.sessionId);
        sessionId = browser.sessionId();
      } catch (err) {
        console.error(JSON.stringify({ event: "browser_connect_failed", error: String(err).slice(0, 200) }));
        await session.forget(plan.sessionId);
        browser = null;
      }
    }
    if (!browser) {
      browser = await launch(binding, { keep_alive: LIMITS.keepAliveMs });
      sessionId = browser.sessionId();
      mode = "launch";
      note = "Launched a fresh browser with keep_alive of 5 minutes.";
      const replace = plan.action === "launch" ? plan.replace : true;
      if (replace) await session.remember(sessionId);
    }

    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      const blocked = await arm(page);
      const opened = await openPage(page, url, kind, blocked);
      const artifact = await produce(page, kind);
      await env.BUCKET.put(objectKey(captureId, artifact.filename), artifact.body, {
        httpMetadata: { contentType: artifact.contentType },
      });
      return { mode, sessionId, note, finalUrl: opened.finalUrl, title: opened.title };
    } finally {
      await context.close();
    }
  } finally {
    if (browser) {
      try {
        await browser.disconnect();
      } catch (err) {
        console.error(JSON.stringify({ event: "browser_disconnect_failed", error: String(err).slice(0, 200) }));
      }
    }
    if (sessionId) await session.release(sessionId);
  }
}
