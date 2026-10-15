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
await assertLandscapeBoard(land, 844, 390, `${out.pathname}/board-844x390.png`);
await landscape.close();

const widePhone = await browser.newContext({ viewport: { width: 932, height: 430 }, colorScheme: "dark" });
const wide = await widePhone.newPage();
await wide.addInitScript(() => localStorage.setItem("theme", "dark"));
await wide.goto(roomUrl, { waitUntil: "domcontentloaded" });
await wide.locator("#canvas").waitFor();
await wide.waitForTimeout(300);
await assertLandscapeBoard(wide, 932, 430, `${out.pathname}/board-932x430.png`);
await widePhone.close();

const narrowPhone = await browser.newContext({ viewport: { width: 667, height: 375 }, colorScheme: "dark" });
const narrow = await narrowPhone.newPage();
await narrow.addInitScript(() => localStorage.setItem("theme", "dark"));
await narrow.goto(roomUrl, { waitUntil: "domcontentloaded" });
await narrow.locator("#canvas").waitFor();
await narrow.waitForTimeout(300);
await assertLandscapeBoard(narrow, 667, 375, `${out.pathname}/board-667x375.png`);
await narrowPhone.close();

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
await page.waitForFunction(() => document.getElementById("workspace")?.classList.contains("is-fatal"), { timeout: 8_000 });
const canvasEvents = await page.locator("#canvas").evaluate((el) => getComputedStyle(el).pointerEvents);
const hintGone = await page.locator("#canvas-hint").evaluate((el) => {
  const node = el as HTMLElement;
  return node.hidden || getComputedStyle(node).display === "none";
});
const toolsLocked = await page.locator("#tool-pen").evaluate((el) => {
  const node = el as HTMLButtonElement;
  return node.disabled || getComputedStyle(node).pointerEvents === "none";
});
console.log("fatal canvas", canvasEvents, "hint hidden", hintGone, "pen locked", toolsLocked);
await page.screenshot({ path: `${out.pathname}/full-room-390.png` });
if (status?.includes("Reconnecting")) throw new Error("ninth visitor still says Reconnecting");
if (!status?.toLowerCase().includes("full")) throw new Error(`unexpected ninth status: ${status}`);
if (canvasEvents !== "none") throw new Error(`canvas still accepts pointers after fatal close: ${canvasEvents}`);
if (!hintGone) throw new Error("Draw here hint still visible after fatal close");
if (!toolsLocked) throw new Error("pen tool still live after fatal close");

for (const socket of sockets) {
  try { socket.close(); } catch { /* already closed */ }
}
await phone.close();
await browser.close();
console.log("ui checks passed");

async function assertLandscapeBoard(page: import("playwright").Page, width: number, height: number, path: string): Promise<void> {
  const wrap = await page.locator(".canvas-wrap").boundingBox();
  const aside = await page.locator(".aside").boundingBox();
  const title = await page.locator(".topbar__title").boundingBox();
  const actions = await page.locator(".topbar__actions").boundingBox();
  if (!wrap) throw new Error(`no canvas-wrap at ${width}×${height}`);
  if (!aside) throw new Error(`no aside at ${width}×${height}`);
  const pageBox = await page.evaluate(() => ({
    innerHeight: window.innerHeight,
    scrollHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    scrollY: window.scrollY || document.documentElement.scrollTop || document.body.scrollTop,
  }));
  const bottom = wrap.y + wrap.height;
  const tooTall = wrap.height > height;
  const tooShort = wrap.height < height * 0.5;
  const tooNarrow = wrap.width < width * 0.45;
  const stacked = aside.x < wrap.x + wrap.width - 8;
  const offScreen = bottom > pageBox.innerHeight + 1;
  const pageScrolls = pageBox.scrollHeight > pageBox.innerHeight + 1 || pageBox.scrollY > 0;
  const titleRight = !!(title && actions && title.x > actions.x + 8);
  const erase = await page.locator("#tool-erase").boundingBox();
  const toolsOffScreen = width === 844 && (!erase || erase.y + erase.height > pageBox.innerHeight + 1);
  console.log(
    `${width}x${height} wrap`,
    Math.round(wrap.width),
    Math.round(wrap.height),
    "bottom",
    Math.round(bottom),
    "vh",
    pageBox.innerHeight,
    "aside",
    Math.round(aside.x),
    tooTall || tooShort || tooNarrow || stacked || offScreen || pageScrolls || titleRight || toolsOffScreen ? "BAD" : "ok",
  );
  await page.screenshot({ path });
  if (tooTall) throw new Error(`${width}×${height} canvas wrap is ${wrap.height}px, taller than the viewport`);
  if (tooShort) throw new Error(`${width}×${height} canvas wrap is ${wrap.height}px, under half the viewport`);
  if (tooNarrow) throw new Error(`${width}×${height} canvas wrap is ${wrap.width}px, under 45% of the viewport`);
  if (stacked) throw new Error(`${width}×${height} tools are not beside the board`);
  if (offScreen) {
    throw new Error(`${width}×${height} board bottom is at ${bottom}px, past the ${pageBox.innerHeight}px viewport`);
  }
  if (pageScrolls) {
    throw new Error(`${width}×${height} page scrolls (scrollHeight ${pageBox.scrollHeight}, scrollY ${pageBox.scrollY})`);
  }
  if (titleRight) throw new Error(`${width}×${height} Partyboard title is to the right of the actions`);
  if (toolsOffScreen) throw new Error(`${width}×${height} Eraser is below the fold`);
}

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
