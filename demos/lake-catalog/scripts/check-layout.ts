import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { handleRequest } from "../src/worker/http";
import { memoryDeps } from "./memory";

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
  const deps = memoryDeps();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/") || url.pathname === "/quack") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(key, value);
      }
      const request = new Request(`http://127.0.0.1${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: body.byteLength ? body : undefined,
      });
      const response = await handleRequest(request, deps, url.pathname);
      const payload = response ? Buffer.from(await response.arrayBuffer()) : Buffer.from("missing");
      const out = new Headers(response?.headers);
      res.writeHead(response?.status ?? 404, Object.fromEntries(out.entries()));
      res.end(payload);
      return;
    }
    const filePath = path.join(publicDir, url.pathname === "/" ? "index.html" : url.pathname);
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const file = await readFile(filePath);
      res.writeHead(200, { "content-type": TYPES[path.extname(filePath)] ?? "application/octet-stream" });
      res.end(file);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  const port = await listen(server);
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch {
    return chromium.launch({
      executablePath: "/opt/google/chrome/chrome",
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      headless: true,
    });
  }
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
      body: "var opts;window.turnstile={render:function(el,o){opts=o;o.callback('XXXX.DUMMY.TOKEN.XXXX');return 'w';},reset:function(){setTimeout(function(){opts.callback('XXXX.DUMMY.TOKEN.XXXX');},30);}};",
    });
  });
}

let failed = false;
const server = await start();
await import("node:fs/promises").then((fs) => fs.mkdir(shots, { recursive: true }));
const browser = await launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  recordVideo: { dir: shots, size: { width: 1280, height: 900 } },
});
const page = await context.newPage();
await page.addInitScript(() => localStorage.setItem("theme", "dark"));
await stubTurnstile(page);

try {
  await page.goto(`${server.origin}/`, { waitUntil: "domcontentloaded" });
  await page.locator("#map").getByText("orders-do").waitFor();
  await page.waitForFunction(() => document.getElementById("turnstile")?.dataset.ready === "1");
  await page.screenshot({ path: path.join(shots, "desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await assertFits(page, "390");
  await assertTarget(page, "#run");
  await assertTarget(page, ".role");
  await assertTarget(page, ".chip");
  await page.screenshot({ path: path.join(shots, "mobile-390.png") });
  await page.getByRole("button", { name: "Viewer: mask and filter" }).click();
  await page.locator("#run").click();
  await page.locator("#explain").getByText("rewrite", { exact: true }).waitFor();
  await page.locator("#rows").getByText("null").first().waitFor();
  await page.locator("#snippet").getByText("TOKEN").waitFor();
  await assertFits(page, "390 result");
  await page.screenshot({ path: path.join(shots, "mobile-390-result.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  await assertFits(page, "desktop result");
  await page.locator("#explain").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, "desktop-result.png") });
  await page.waitForTimeout(900);
  await page.locator("#status").getByText("Check passed").waitFor();
  await page.getByRole("button", { name: "Guest: blocked columns" }).click();
  await page.locator("#run").click();
  await page.locator("#explain").getByText("deny", { exact: true }).waitFor();
  await page.locator("#explain").scrollIntoViewIfNeeded();
  await page.waitForTimeout(900);
  await page.locator("#status").getByText("Check passed").waitFor();
  await page.getByRole("button", { name: "Analyst: full table" }).click();
  await page.locator("#run").click();
  await page.locator("#explain").getByText("allow", { exact: true }).waitFor();
  await page.locator("#rows").getByText("internal-lab").first().waitFor();
  await page.locator("#explain").scrollIntoViewIfNeeded();
  await page.waitForTimeout(1100);
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
