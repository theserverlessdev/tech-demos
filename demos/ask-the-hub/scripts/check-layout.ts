import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { ASK_ORIGIN } from "../../../apps/hub/src/ask-palette.ts";
import { renderGallery } from "../../../apps/hub/src/gallery.ts";
import { demos } from "../../../apps/hub/src/registry.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const shots = path.join(root, "artifacts");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve(address.port);
    });
  });
}

async function start(): Promise<{ origin: string; close: () => Promise<void> }> {
  const gallery = renderGallery(demos);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/api/config") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ siteKey: "0x4AAAAAAFRUoj5qDpf7XyIW", dev: true }));
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }
    if (url.pathname === "/api/search" && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        chunks: [{ source: "r2-drive/README.md", score: 0.91, snippet: "A one-hour WebDAV drive on Workers, with locks in SQLite." }],
      }));
      return;
    }
    if (url.pathname === "/api/ask" && req.method === "POST") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"response":"R2 Drive "}\n\n');
      await new Promise((resolve) => setTimeout(resolve, 350));
      res.write('data: {"response":"is a WebDAV drive on Workers."}\n\n');
      res.end();
      return;
    }
    if (url.pathname === "/hub" || url.pathname === "/hub/") {
      const html = gallery.split(ASK_ORIGIN).join(`http://127.0.0.1:${port}`);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    const filePath = path.join(publicDir, url.pathname === "/" ? "index.html" : url.pathname);
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const body = await readFile(filePath);
      res.writeHead(200, { "content-type": TYPES[path.extname(filePath)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  const port = await listen(server);
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function assertFits(page: Page, label: string) {
  const box = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  if (box.scroll > box.client + 1) throw new Error(`${label} overflows by ${box.scroll - box.client}px`);
}

async function assertTarget(page: Page, selector: string) {
  const handle = page.locator(selector).first();
  await handle.waitFor({ state: "visible" });
  const box = await handle.boundingBox();
  if (!box || box.height < 44 || box.width < 44) {
    throw new Error(`${selector} is ${box?.width}x${box?.height}`);
  }
}

async function stubTurnstile(page: Page) {
  await page.route("**/*", async (route) => {
    if (!route.request().url().includes("challenges.cloudflare.com")) {
      await route.continue();
      return;
    }
    await route.fulfill({
      contentType: "application/javascript",
      body: "window.turnstile={render:function(el,opts){opts.callback('preview-token');return 'w';},reset:function(){}};",
    });
  });
}

let failed = false;
const server = await start();
await import("node:fs/promises").then((fs) => fs.mkdir(shots, { recursive: true }));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: shots, size: { width: 1280, height: 800 } },
});
const page = await context.newPage();
await stubTurnstile(page);

try {
  await page.goto(`${server.origin}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(shots, "demo-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await assertFits(page, "demo 390");
  await assertTarget(page, "#ask");
  await assertTarget(page, ".chip");
  await page.screenshot({ path: path.join(shots, "demo-390.png") });
  await page.waitForFunction(() => {
    const api = (window as unknown as { turnstile?: { render?: unknown } }).turnstile;
    return document.getElementById("turnstile")?.dataset.ready === "1" && typeof api?.render === "function";
  });
  await page.locator(".chip").first().click();
  await page.locator("#ask").click();
  await page.locator("#answer").getByText("WebDAV drive on Workers").waitFor();
  await page.locator("#chunks").getByText("r2-drive/README.md").waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shots, "demo-390-answer.png") });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, "demo-desktop-answer.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${server.origin}/hub`, { waitUntil: "domcontentloaded" });
  await page.locator("#ask-open").waitFor({ state: "visible" });
  await assertFits(page, "hub 390");
  await assertTarget(page, "#ask-open");
  await assertTarget(page, "#ask-bubble");
  await page.screenshot({ path: path.join(shots, "hub-390.png") });
  await page.locator("#ask-open").click();
  await page.locator("#ask-dialog").waitFor({ state: "visible" });
  await assertTarget(page, "#ask-go");
  await assertTarget(page, "#ask-close");
  await page.waitForFunction(() => document.getElementById("ask-turnstile")?.getAttribute("data-ready") === "1");
  await page.locator(".ask-chip").first().click();
  await page.locator("#ask-go").click();
  await page.locator("#ask-answer").getByText("WebDAV").waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shots, "hub-390-answer.png") });

  await page.setViewportSize({ width: 1280, height: 800 });
  await assertFits(page, "hub desktop");
  await page.screenshot({ path: path.join(shots, "hub-desktop.png") });
  console.log("layout checks passed");
} catch (err) {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  failed = true;
} finally {
  await context.close();
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
