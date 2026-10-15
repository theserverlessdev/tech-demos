// Local capture: bun run scripts/capture.ts [baseUrl]
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";

const base = (process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const out = new URL("../artifacts/", import.meta.url).pathname;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((path): path is string => Boolean(path && existsSync(path)));

async function loadChromium() {
  try {
    return (await import("playwright")).chromium;
  } catch {
    return (await import("../../byok-playground/node_modules/playwright/index.mjs")).chromium;
  }
}

const chromium = await loadChromium();
const browser = await chromium.launch({
  executablePath: CHROME_CANDIDATES[0],
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
await mkdir(out, { recursive: true });

async function stamp(page: import("playwright").Page, label: string) {
  await page.evaluate((text) => {
    const existing = document.getElementById("local-stamp");
    if (existing) {
      existing.textContent = text;
      return;
    }
    const banner = document.createElement("div");
    banner.id = "local-stamp";
    banner.textContent = text;
    banner.setAttribute("aria-hidden", "true");
    banner.style.cssText =
      "position:sticky;top:0;z-index:9999;background:#c2410c;color:#fff7f3;text-align:center;padding:6px 10px;font:600 12px/1.3 ui-sans-serif,system-ui,sans-serif;pointer-events:none;";
    document.body.prepend(banner);
  }, label);
}

const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
const phonePage = await phone.newPage();
await phonePage.addInitScript(() => localStorage.setItem("theme", "dark"));
await phonePage.goto(`${base}/`, { waitUntil: "networkidle" });
await phonePage.waitForFunction(() => document.getElementById("count")?.textContent !== "0", null, { timeout: 15_000 });
await stamp(phonePage, "390×844 · local stub · not production");
await phonePage.waitForTimeout(400);
const phoneWidth = await phonePage.evaluate(() => document.documentElement.scrollWidth);
if (phoneWidth > 420) throw new Error(`phone inbox overflow: scrollWidth=${phoneWidth}`);
await phonePage.screenshot({ path: `${out}inbox-390.png`, fullPage: true });

await phonePage.locator(".ticket").first().click();
await phonePage.waitForSelector("#conv:not([hidden])", { timeout: 10_000 });
await phonePage.waitForTimeout(300);
await stamp(phonePage, "390×844 thread · local stub · not production");
await phonePage.screenshot({ path: `${out}thread-390.png`, fullPage: true });
await phone.close();

const desktop = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
const page = await desktop.newPage();
await page.addInitScript(() => localStorage.setItem("theme", "dark"));
await page.goto(`${base}/`, { waitUntil: "networkidle" });
await page.waitForFunction(() => document.getElementById("count")?.textContent !== "0", null, { timeout: 15_000 });
await stamp(page, "local stub · not production");
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}inbox.png` });
await page.locator(".ticket").first().click();
await page.waitForSelector("#conv:not([hidden])");
await page.locator("#draft").click();
await page.waitForFunction(() => {
  const path = document.getElementById("draft-path")?.textContent ?? "";
  return path.includes("Path:");
}, null, { timeout: 15_000 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}draft.png` });

const before = await page.locator(".ticket").count();
await page.locator("#simulate").click();
await page.waitForFunction((prev) => {
  const tickets = document.querySelectorAll(".ticket").length;
  const hint = document.getElementById("hint")?.textContent ?? "";
  return tickets > prev || hint.includes("Queue consumer wrote");
}, before, { timeout: 20_000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}inbound.png` });

await desktop.close();
await browser.close();
console.log("captured", {
  phoneInbox: `${out}inbox-390.png`,
  phoneThread: `${out}thread-390.png`,
  draft: `${out}draft.png`,
  inbound: `${out}inbound.png`,
  phoneWidth,
});
