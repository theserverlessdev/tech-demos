// Capture 390px screenshots + a short video of playground, consent, device, admin.
import { chromium } from "playwright";
import { copyFile, mkdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";

const base = (process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8788").replace(/\/$/, "");
const DUMMY = "XXXX.DUMMY.TOKEN.XXXX";
const outDir = resolve(import.meta.dir, "../artifacts");
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  recordVideo: { dir: outDir, size: { width: 390, height: 844 } },
});
const page = await context.newPage();
const email = `ada+${Date.now()}@example.com`;

function overflowOk() {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
}

await page.goto(`${base}/playground.html`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#pkce-start", { timeout: 15_000 });
await page.waitForTimeout(500);
await page.screenshot({ path: resolve(outDir, "playground-390.png"), fullPage: true });

await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#start-signup", { timeout: 15_000 });
await page.locator("#start-signup").click();
await page.waitForSelector("#auth-form", { timeout: 15_000 });
await page.waitForTimeout(400);
await page.screenshot({ path: resolve(outDir, "signin-390.png"), fullPage: true });

await page.locator("#email").fill(email);
await page.locator("#password").fill("correct-horse");
await page.evaluate((token) => {
  const hidden = document.getElementById("turnstile-token") as HTMLInputElement | null;
  if (hidden) hidden.value = token;
  const submit = document.getElementById("submit") as HTMLButtonElement | null;
  if (submit) submit.disabled = false;
}, DUMMY);
await page.locator("#submit").click();
await page.waitForSelector("text=wants access", { timeout: 20_000 });
await page.waitForTimeout(400);
await page.screenshot({ path: resolve(outDir, "consent-390.png"), fullPage: true });
await page.locator("button[type=submit]", { hasText: "Allow" }).click();
await page.waitForSelector("#tokens:not([hidden])", { timeout: 20_000 });
await page.waitForTimeout(400);
await page.screenshot({ path: resolve(outDir, "tokens-390.png"), fullPage: true });

const homeOverflow = await overflowOk();
if (homeOverflow.scrollWidth > 390) throw new Error(`horizontal overflow at 390px: ${JSON.stringify(homeOverflow)}`);

await page.goto(`${base}/device`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("text=Device authorization", { timeout: 10_000 });
await page.waitForTimeout(300);
await page.screenshot({ path: resolve(outDir, "device-390.png"), fullPage: true });

await page.goto(`${base}/admin`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#users", { timeout: 10_000 });
await page.waitForFunction(() => document.body.innerText.includes("@"), { timeout: 10_000 });
await page.waitForTimeout(400);
await page.screenshot({ path: resolve(outDir, "admin-390.png"), fullPage: true });

const video = page.video();
await context.close();
await browser.close();
if (video) {
  const src = await video.path();
  const dest = resolve(outDir, "melody-auth-flow.mp4");
  await copyFile(src, dest);
  await unlink(src).catch(() => {});
  console.log(`video ${dest}`);
}
console.log(`playground ${resolve(outDir, "playground-390.png")}`);
console.log(`consent ${resolve(outDir, "consent-390.png")}`);
console.log(`device ${resolve(outDir, "device-390.png")}`);
console.log(`admin ${resolve(outDir, "admin-390.png")}`);
