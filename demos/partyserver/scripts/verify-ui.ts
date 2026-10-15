// bun run scripts/verify-ui.ts [baseUrl] [roomUrl]
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { CLOSE_FULL, MAX_CONNECTIONS } from "../src/shared/protocol";

const base = (process.argv.find((arg) => arg.startsWith("http") && !arg.includes("room=")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const roomUrl = process.argv.find((arg) => arg.includes("room="));
const out = new URL("../artifacts/", import.meta.url);
await mkdir(out, { recursive: true });

if (!roomUrl) throw new Error("pass a room URL");

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const landscape = await browser.newContext({ viewport: { width: 844, height: 390 }, colorScheme: "dark" });
const land = await landscape.newPage();
await land.addInitScript(() => localStorage.setItem("theme", "dark"));
await land.goto(roomUrl, { waitUntil: "domcontentloaded" });
await land.locator("#canvas").waitFor();
await land.waitForTimeout(300);
const wrap = await land.locator(".canvas-wrap").boundingBox();
if (!wrap) throw new Error("no canvas-wrap");
const tooTall = wrap.height > 390;
console.log("landscape wrap", Math.round(wrap.width), Math.round(wrap.height), tooTall ? "OVERFLOW" : "ok");
await land.screenshot({ path: `${out.pathname}/board-844x390.png` });
await landscape.close();
if (tooTall) throw new Error(`landscape canvas wrap is ${wrap.height}px, taller than 390`);

const sockets: WebSocket[] = [];
const id = new URL(roomUrl).searchParams.get("room");
if (!id) throw new Error("no room id");
for (let i = 0; i < MAX_CONNECTIONS; i++) {
  sockets.push(await openSocket(`${base.replace(/^http/, "ws")}/parties/board-room/${id}?_pk=full${i}`));
}

const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
const page = await phone.newPage();
await page.addInitScript(() => localStorage.setItem("theme", "dark"));
await page.goto(roomUrl, { waitUntil: "domcontentloaded" });
await page.locator("#status-text").waitFor();
await page.waitForFunction(() => {
  const text = document.getElementById("status-text")?.textContent ?? "";
  return text.includes("full") || text.includes("Reconnecting");
}, { timeout: 15_000 });
const status = await page.locator("#status-text").textContent();
console.log("ninth visitor status:", status);
await page.screenshot({ path: `${out.pathname}/full-room-390.png` });
if (status?.includes("Reconnecting")) throw new Error("ninth visitor still says Reconnecting");
if (!status?.toLowerCase().includes("full")) throw new Error(`unexpected ninth status: ${status}`);

for (const socket of sockets) {
  try { socket.close(); } catch { /* already closed */ }
}
await phone.close();
await browser.close();
console.log("ui checks passed");

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error(`open timeout ${url}`)), 5000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`open error ${url}`));
    });
    ws.addEventListener("close", (event) => {
      if (event.code === CLOSE_FULL) {
        clearTimeout(timer);
        reject(new Error("filled before expected"));
      }
    });
  });
}
