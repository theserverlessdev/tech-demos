// Records a local two-client pass. bun run scripts/capture.ts [baseUrl]
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const base = (process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const out = new URL("../artifacts/", import.meta.url);
await mkdir(out, { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const dark = () => localStorage.setItem("theme", "dark");
const contextA = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  colorScheme: "dark",
  recordVideo: { dir: out.pathname, size: { width: 1280, height: 800 } },
});
const contextB = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
await contextA.addInitScript(dark);
await contextB.addInitScript(dark);
const pageA = await contextA.newPage();
const pageB = await contextB.newPage();

await pageA.goto(`${base}/`, { waitUntil: "domcontentloaded" });
await pageA.locator("#name").fill("Ada");
await pageA.locator("#open-room").waitFor({ state: "visible" });
await pageA.locator("#open-room:enabled").waitFor({ timeout: 20_000 });
await pageA.screenshot({ path: `${out.pathname}/gate.png` });
await pageA.locator("#open-room").click();
await pageA.waitForURL(/room=/, { timeout: 15_000 });
await pageA.locator("#canvas").waitFor();

const roomUrl = pageA.url();
await pageB.goto(roomUrl, { waitUntil: "domcontentloaded" });
await pageB.locator("#board-name").fill("Kai");
await pageB.locator("#board-name").press("Tab");
await pageB.locator("#canvas").waitFor();

const boxA = await pageA.locator("#canvas").boundingBox();
const boxB = await pageB.locator("#canvas").boundingBox();
if (!boxA || !boxB) throw new Error("canvas has no box");

await stroke(pageA, boxA, 140, 180, [
  [560, 140],
  [680, 380],
  [220, 460],
  [160, 220],
]);
await pageB.locator("#canvas-hint").waitFor({ state: "hidden", timeout: 10_000 });
await pageA.waitForTimeout(400);
await stroke(pageB, boxB, 200, 80, [
  [80, 300],
  [420, 420],
]);
await pageA.waitForTimeout(500);
await pageA.locator("#people").getByText("Kai").waitFor({ timeout: 8_000 });
await pageA.screenshot({ path: `${out.pathname}/board.png` });
await pageB.screenshot({ path: `${out.pathname}/board-peer.png` });

const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
await mobile.addInitScript(dark);
const phone = await mobile.newPage();
await phone.goto(roomUrl, { waitUntil: "domcontentloaded" });
await phone.locator("#canvas").waitFor();
await phone.screenshot({ path: `${out.pathname}/board-mobile.png` });
await mobile.close();

const video = pageA.video();
await contextA.close();
await contextB.close();
if (video) {
  await video.saveAs(`${out.pathname}/partyserver-demo.mp4`);
}
await browser.close();
console.log("captured", roomUrl);

async function stroke(
  page: import("playwright").Page,
  box: { x: number; y: number },
  x: number,
  y: number,
  moves: Array<[number, number]>,
): Promise<void> {
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  for (const [dx, dy] of moves) {
    await page.mouse.move(box.x + dx, box.y + dy, { steps: 8 });
  }
  await page.mouse.up();
}
