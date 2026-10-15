// Capture 390px proof of the local preview. bun run scripts/capture.ts
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const base = process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8787";
const out = `${import.meta.dir}/../artifacts`;
mkdirSync(out, { recursive: true });

const DUMMY = "XXXX.DUMMY.TOKEN.XXXX";

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  permissions: ["clipboard-read", "clipboard-write"],
  recordVideo: { dir: `${out}/video-tmp`, size: { width: 390, height: 844 } },
});
const page = await context.newPage();

async function metrics() {
  return page.evaluate(() => ({
    inner: window.innerWidth,
    scroll: document.documentElement.scrollWidth,
    layout: document.querySelector(".layout")?.scrollWidth ?? 0,
    detail: document.querySelector(".pane-detail")?.scrollWidth ?? 0,
    split: document.querySelector(".split")?.scrollWidth ?? 0,
  }));
}

await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#title");
await page.screenshot({ path: `${out}/mobile.png`, fullPage: false });

// Seed via API with the same origin so the visitor cookie is shared, then open the task.
const seeded = await page.evaluate(async (token) => {
  const created = await fetch("/api/tasks", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Reverse a greeting", turnstileToken: token }),
  });
  const body = await created.json();
  if (!created.ok) return { ok: false, body };
  const run = await fetch(`/api/tasks/${body.id}/run`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction: "Add a reverse function to src/task.ts", turnstileToken: token }),
  });
  const runBody = await run.json();
  return { ok: run.ok && created.ok, created: body, run: runBody };
}, DUMMY);

if (!seeded.ok) {
  console.error("seed failed", seeded);
  await browser.close();
  process.exit(1);
}

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".task");
await page.click(".task");
await page.waitForSelector("#diff-code");
await page.waitForTimeout(400);

const afterOpen = await metrics();
console.log("after open", afterOpen);
if (afterOpen.scroll > 390 || afterOpen.layout > 390 || afterOpen.detail > 390) {
  console.error("FAIL  task view is wider than 390px", afterOpen);
  await page.screenshot({ path: `${out}/mobile-wide.png`, fullPage: true });
  await browser.close();
  process.exit(1);
}

await page.screenshot({ path: `${out}/mobile.png`, fullPage: true });

const desk = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const deskPage = await desk.newPage();
await deskPage.goto(base, { waitUntil: "load" });
await deskPage.evaluate(async (token) => {
  const created = await fetch("/api/tasks", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Reverse a greeting", turnstileToken: token }),
  });
  const body = await created.json();
  await fetch(`/api/tasks/${body.id}/run`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction: "Add a reverse function to src/task.ts", turnstileToken: token }),
  });
}, DUMMY);
await deskPage.reload({ waitUntil: "domcontentloaded" });
await deskPage.click(".task");
await deskPage.waitForSelector("#diff-code");
const deskMetrics = await deskPage.evaluate(() => ({
  inner: window.innerWidth,
  scroll: document.documentElement.scrollWidth,
}));
console.log("desktop", deskMetrics);
if (deskMetrics.scroll > 1280) {
  console.error("FAIL  desktop scrollWidth", deskMetrics);
  process.exit(1);
}
await deskPage.screenshot({ path: `${out}/desk.png`, fullPage: false });
await desk.close();

await page.click("#token-btn").catch(() => undefined);
await page.waitForSelector("#token-copy", { state: "visible" });
await page.click("#token-copy");
await page.waitForFunction(
  () => {
    const copy = document.getElementById("token-copy")?.textContent ?? "";
    const hint = document.getElementById("run-hint")?.textContent ?? "";
    return copy === "Copied" || /copied|Select the command/i.test(hint);
  },
  { timeout: 3000 },
);
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}/mobile-token.png`, fullPage: true });
await page.evaluate(() => document.querySelector("#diff")?.scrollIntoView({ block: "center" }));
await page.waitForTimeout(1200);

const video = page.video();
await page.close();
await context.close();
if (video) {
  const path = await video.path();
  const dest = `${out}/walkthrough.mp4`;
  const { renameSync } = await import("node:fs");
  renameSync(path, dest);
  console.log("video", dest);
}
await browser.close();
console.log("seed", seeded);
console.log("wrote screenshots to", out);
