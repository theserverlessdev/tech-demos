// Local desk capture: bun run scripts/capture.ts [baseUrl]
import { chromium, type Page } from "playwright";
import { mkdir } from "node:fs/promises";

const base = (process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const out = new URL("../artifacts/", import.meta.url).pathname;

async function waitEnabled(page: Page, selector: string) {
  await page.waitForFunction((sel) => {
    const node = document.querySelector(sel);
    return node instanceof HTMLButtonElement && !node.disabled;
  }, selector, { timeout: 20_000 });
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
const consoleErrors: string[] = [];
page.on("pageerror", (err) => consoleErrors.push(err.message));

await page.addInitScript(() => localStorage.setItem("theme", "dark"));
await page.goto(`${base}/demos/clef-gate/`, { waitUntil: "domcontentloaded" });
await waitEnabled(page, "#send");
await page.getByRole("button", { name: "Read the refund policy" }).click();
await page.waitForFunction(() => document.getElementById("gate-decision")?.textContent?.includes("allow"), null, { timeout: 20_000 });
await page.screenshot({ path: `${out}allow.png` });

await waitEnabled(page, "#send");
await page.getByRole("button", { name: "Email the customer" }).click();
await page.waitForSelector("#pending:not([hidden])", { timeout: 20_000 });
await page.screenshot({ path: `${out}ask-human.png` });
await page.getByRole("button", { name: "Approve" }).click();
await page.waitForFunction(() => document.body.textContent?.includes("Simulated email"), null, { timeout: 20_000 });

await page.getByRole("button", { name: "Clef-flash" }).click();
await waitEnabled(page, "#send");
await page.getByRole("button", { name: "Run DROP TABLE tickets" }).click();
await page.waitForFunction(() => document.getElementById("gate-decision")?.textContent?.includes("deny"), null, { timeout: 20_000 });
await page.screenshot({ path: `${out}denied.png` });

const video = page.video();
await context.close();
const raw = video ? await video.path() : "";
if (raw) {
  const ffmpeg = "ffmpeg";
  const proc = Bun.spawn([ffmpeg, "-y", "-i", raw, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", `${out}clef-gate-demo.mp4`], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(err.slice(-500));
  }
}
await browser.close();

if (consoleErrors.length) {
  console.error(consoleErrors.join("\n"));
  process.exit(1);
}
console.log(`Wrote ${out}allow.png, ask-human.png, denied.png, clef-gate-demo.mp4`);
