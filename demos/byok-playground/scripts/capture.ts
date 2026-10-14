// Local capture: bun run scripts/capture.ts [baseUrl]
import { chromium, type Page } from "playwright";
import { mkdir } from "node:fs/promises";

const base = (process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const out = new URL("../artifacts/", import.meta.url).pathname;
const url = `${base}/`;

async function fillEndpoint(page: Page) {
  await page.locator("#api-key").fill("sk-mock-local-key");
  await page.locator("#base-url").fill("http://127.0.0.1:8799/v1");
  await page.locator("#model").fill("mock-gpt");
}

async function stampMock(page: Page) {
  await page.evaluate(() => {
    const existing = document.getElementById("mock-stamp");
    if (existing) return;
    const banner = document.createElement("div");
    banner.id = "mock-stamp";
    banner.textContent = "local mock · not production";
    banner.setAttribute("aria-hidden", "true");
    banner.style.cssText =
      "position:absolute;top:0;left:0;right:0;z-index:9999;background:#c2410c;color:#fff7f3;text-align:center;padding:6px 10px;font:600 13px/1.3 ui-sans-serif,system-ui,sans-serif;pointer-events:none;";
    document.body.style.position = "relative";
    document.body.style.paddingTop = "28px";
    document.body.prepend(banner);
  });
}

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
await mkdir(out, { recursive: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: `${out}raw`, size: { width: 1280, height: 800 } },
});
const page = await context.newPage();
page.on("pageerror", (err) => console.error(err.message));

await page.addInitScript(() => localStorage.setItem("theme", "dark"));
await page.goto(url, { waitUntil: "load" });
await page.waitForFunction(() => (document.getElementById("session-note")?.textContent ?? "").includes("Signed session"), null, { timeout: 15_000 });
await stampMock(page);
await fillEndpoint(page);
await page.locator("#list-models").click();
await page.waitForFunction(() => /\d+ models/.test(document.getElementById("models-note")?.textContent ?? ""), null, { timeout: 15_000 });
await page.locator("#prompt").fill("Say hello in one short sentence.");
await page.locator("#send").click();
await page.waitForFunction(() => {
  const last = document.querySelector(".bubble.assistant div");
  return Boolean(last && last.textContent && last.textContent.length > 8 && !(document.getElementById("send") as HTMLButtonElement | null)?.disabled);
}, null, { timeout: 20_000 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}desktop-chat.png`, fullPage: true });

await page.getByRole("tab", { name: "Compare" }).click();
await page.waitForTimeout(400);
await page.locator("#compare").click();
await page.waitForFunction(() => {
  const yours = document.getElementById("yours-out")?.textContent ?? "";
  const ours = document.getElementById("ours-out")?.textContent ?? "";
  const idle = !(document.getElementById("compare") as HTMLButtonElement | null)?.disabled;
  return yours.length > 4 && ours.length > 4 && idle;
}, null, { timeout: 20_000 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}desktop-compare.png`, fullPage: true });

await page.getByRole("tab", { name: "Capabilities" }).click();
await page.waitForTimeout(400);
await page.locator("#run-caps").click();
await page.waitForFunction(() => document.querySelectorAll(".cap").length >= 4 && !(document.getElementById("run-caps") as HTMLButtonElement | null)?.disabled, null, { timeout: 25_000 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}desktop-capabilities.png`, fullPage: true });

const video = page.video();
await context.close();
const raw = video ? await video.path() : "";
if (raw) {
  const proc = Bun.spawn(["ffmpeg", "-y", "-i", raw, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "32", "-preset", "slow", "-vf", "scale=960:-2", "-an", "-movflags", "+faststart", `${out}byok-playground-demo.mp4`], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(err.slice(-500));
  }
}

const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const phone = await mobile.newPage();
await phone.addInitScript(() => localStorage.setItem("theme", "dark"));
await phone.goto(url, { waitUntil: "load" });
await phone.waitForFunction(() => (document.getElementById("session-note")?.textContent ?? "").includes("Signed session"), null, { timeout: 15_000 });
await stampMock(phone);
await fillEndpoint(phone);
await phone.locator("#prompt").fill("Hello from a 390px phone layout.");
await phone.screenshot({ path: `${out}mobile-390.png`, fullPage: true });
await mobile.close();
await browser.close();
console.log(`Wrote artifacts under ${out}`);
