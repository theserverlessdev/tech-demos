import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

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
    const filePath = path.join(publicDir, rel);
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

async function overflow(page: import("playwright").Page): Promise<number> {
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
  await home.goto(`${server.origin}/`, { waitUntil: "networkidle" });
  const create = await home.locator("#create").boundingBox();
  const join = await home.locator("#join").boundingBox();
  if (!create || !join) throw new Error("home controls missing");
  if (create.height < 44 || join.height < 44) throw new Error(`touch target too small: ${create.height} ${join.height}`);
  if ((await overflow(home)) > 1) throw new Error("home overflows at 390px");
  const copy = await home.locator("body").innerText();
  if (!copy.toLowerCase().includes("misuse can be reported")) throw new Error("missing misuse line");
  await home.close();

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.goto(`${server.origin}/?preview=1`, { waitUntil: "networkidle" });
  await phone.locator("#room:not([hidden])").waitFor();
  await phone.locator("#qr svg").waitFor();
  const file = await phone.locator("#file").boundingBox();
  if (!file || file.height < 44) throw new Error("file control is not touch sized");
  const tape = await phone.locator("#tape li").count();
  if (tape < 4) throw new Error("tape is empty");
  if ((await overflow(phone)) > 1) throw new Error("room overflows at 390px");
  const qr = await phone.locator("#qr").boundingBox();
  const panel = await phone.locator(".tape-panel").boundingBox();
  if (!qr || !panel) throw new Error("room sections missing");
  if (panel.y < qr.y) throw new Error("tape should stack under the QR at 390px");
  await phone.close();

  const desk = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await desk.goto(`${server.origin}/?preview=1`, { waitUntil: "networkidle" });
  await desk.locator("#qr svg").waitFor();
  const lane = await desk.locator(".lane .card").boundingBox();
  const side = await desk.locator(".tape-panel").boundingBox();
  if (!lane || !side) throw new Error("desktop sections missing");
  if (side.x <= lane.x) throw new Error("tape should sit beside the lane on desktop");
  if ((await overflow(desk)) > 1) throw new Error("room overflows at 1280px");
  await desk.close();
  console.log("layout ok at 390px and 1280px");
} finally {
  await browser.close();
  await server.close();
}
