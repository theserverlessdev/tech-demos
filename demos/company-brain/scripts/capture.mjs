// Capture 390px screenshot + short video of the cited seed answer.
// Usage: bun scripts/capture.mjs [baseUrl]
import { chromium } from "playwright";
import { copyFile, mkdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";

const base = (process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");
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

await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#create", { timeout: 15_000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: resolve(outDir, "gate-390.png"), fullPage: true });

const hiddenBefore = await page.evaluate(() => {
  const el = document.getElementById("workspace");
  if (!el) return { missing: true };
  const style = getComputedStyle(el);
  return { hidden: el.hidden, display: style.display, scrollWidth: document.documentElement.scrollWidth };
});
if (hiddenBefore.display !== "none") throw new Error(`workspace should be hidden: ${JSON.stringify(hiddenBefore)}`);

const created = await page.evaluate(async (token) => {
  const res = await fetch("/api/orgs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ turnstileToken: token }),
    credentials: "include",
  });
  const data = await res.json();
  if (res.status !== 201 || !data.id) return { status: res.status, error: data };
  sessionStorage.setItem("company-brain-org", data.id);
  sessionStorage.setItem("company-brain-ingest", data.ingestToken);
  return { id: data.id, cited: data.messages?.some((message) => message.sources?.length) ?? false };
}, DUMMY);
if (!created.id) throw new Error(`create failed: ${JSON.stringify(created)}`);

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#workspace:not([hidden])", { timeout: 15_000 });
await page.waitForSelector(".cite", { timeout: 10_000 });
await page.waitForTimeout(500);

const afterCreate = await page.evaluate(() => {
  const workspace = document.getElementById("workspace");
  const send = document.getElementById("send");
  const sendBox = send?.getBoundingClientRect();
  return {
    hidden: workspace?.hidden ?? true,
    display: workspace ? getComputedStyle(workspace).display : "missing",
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    sendRight: sendBox ? Math.round(sendBox.right) : null,
    cite: document.querySelector(".cite")?.textContent ?? "",
    answer: document.querySelector(".bubble--assistant p")?.textContent ?? "",
  };
});
if (afterCreate.scrollWidth > 390) throw new Error(`horizontal overflow at 390px: ${JSON.stringify(afterCreate)}`);
if (!afterCreate.cite.includes("[fact:")) throw new Error(`cited answer missing: ${JSON.stringify(afterCreate)}`);

await page.waitForTimeout(1600);
await page.screenshot({ path: resolve(outDir, "mobile.png"), fullPage: true });
await page.screenshot({ path: resolve(outDir, "workspace.png"), fullPage: false });

await page.locator("[data-ask='What is the office wifi password?']").click();
const asked = await page.evaluate(async ({ orgId, token }) => {
  const res = await fetch(`/api/orgs/${orgId}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "What is the office wifi password?", turnstileToken: token }),
    credentials: "include",
  });
  return { status: res.status, data: await res.json() };
}, { orgId: created.id, token: DUMMY });
if (asked.status !== 200 || asked.data.answer !== "I don't know.") {
  throw new Error(`wifi path failed: ${JSON.stringify(asked)}`);
}
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".bubble--unknown", { timeout: 10_000 });
await page.waitForTimeout(1400);

await page.locator("#add-text").fill("The Austin warehouse has a bike cage on the south wall.");
await page.waitForTimeout(400);
await page.locator("#add-btn").click();
await page.waitForFunction(() => document.body.innerText.includes("bike cage"), { timeout: 10_000 });
await page.locator(".card", { hasText: "bike cage" }).scrollIntoViewIfNeeded();
await page.waitForTimeout(1200);

const video = page.video();
await context.close();
await browser.close();
if (video) {
  const src = await video.path();
  const dest = resolve(outDir, "walkthrough.mp4");
  await copyFile(src, dest);
  await unlink(src).catch(() => {});
  console.log(`video ${dest}`);
}
console.log(`mobile ${resolve(outDir, "mobile.png")}`);
console.log(`workspace ${resolve(outDir, "workspace.png")}`);
console.log(JSON.stringify({ hiddenBefore, afterCreate, created }, null, 2));
