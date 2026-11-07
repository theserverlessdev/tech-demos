import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");

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
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.normalize(path.join(publicDir, rel));
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const body = await readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  const port = await listen(server);
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const server = await start();

try {
  const home = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await home.goto(`${server.origin}/`, { waitUntil: "domcontentloaded" });
  const start = await home.locator("#start").boundingBox();
  if (!start || start.height < 44) throw new Error("start control is not touch sized");
  if ((await overflow(home)) > 1) throw new Error("home overflows at 390px");
  const homeCopy = (await home.locator("body").innerText()).toLowerCase();
  if (!homeCopy.includes("confirm")) throw new Error("home is missing the confirm line");
  if (!homeCopy.includes("base sepolia")) throw new Error("home is missing Base Sepolia");
  await home.close();

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.goto(`${server.origin}/?preview=1`, { waitUntil: "domcontentloaded" });
  await phone.locator("#confirm:not([hidden])").waitFor();
  const accept = await phone.locator("#accept").boundingBox();
  const deny = await phone.locator("#deny").boundingBox();
  if (!accept || !deny || accept.height < 44 || deny.height < 44) throw new Error("confirm controls are not touch sized");
  if ((await overflow(phone)) > 1) throw new Error("preview overflows at 390px");
  const preview = await phone.locator("body").innerText();
  if (!preview.includes("Layout preview. Not a payment.")) throw new Error("preview is not labelled");
  const sheet = await phone.locator("#confirm").boundingBox();
  const tools = await phone.locator("#workspace .card").first().boundingBox();
  if (!sheet || !tools) throw new Error("preview sections missing");
  if (sheet.y < tools.y) throw new Error("confirm should stack under the tools at 390px");
  await phone.close();

  const desk = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await desk.goto(`${server.origin}/?preview=1`, { waitUntil: "domcontentloaded" });
  await desk.locator("#confirm:not([hidden])").waitFor();
  const lane = await desk.locator("#workspace > .card").boundingBox();
  const side = await desk.locator(".side").boundingBox();
  if (!lane || !side) throw new Error("desktop sections missing");
  if (side.x <= lane.x) throw new Error("timeline should sit beside the tools on desktop");
  if ((await overflow(desk)) > 1) throw new Error("preview overflows at 1280px");
  const deskCopy = await desk.locator("#status").innerText();
  if (!deskCopy.includes("Layout preview. Not a payment.")) throw new Error("desktop preview is not labelled");
  await desk.close();
  console.log("layout ok at 390px and 1280px");
} finally {
  await browser.close();
  await server.close();
}
