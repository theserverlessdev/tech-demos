// 390px desk capture: bun run scripts/capture.ts [baseUrl]
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
  executablePath: "/opt/google/chrome/chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
await mkdir(out, { recursive: true });
await mkdir(`${out}raw`, { recursive: true });

const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  recordVideo: { dir: `${out}raw`, size: { width: 390, height: 844 } },
});
const page = await context.newPage();
const consoleErrors: string[] = [];
page.on("pageerror", (err) => consoleErrors.push(err.message));
await page.route("**/turnstile/v0/api.js*", (route) => route.fulfill({
  contentType: "application/javascript",
  body: `window.turnstile={render(el,opts){setTimeout(()=>opts.callback("XXXX.DUMMY.TOKEN.XXXX"),20);return "w";}};`,
}));
await page.addInitScript(() => localStorage.setItem("theme", "dark"));
await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
await waitEnabled(page, "#extract");

await page.locator("#samples").getByRole("button", { name: "Invoice", exact: true }).click();
const pause = (ms: number) => page.waitForTimeout(ms);
await page.locator("#state").evaluate((node) => node.scrollIntoView({ block: "center" }));
await pause(900);
await page.screenshot({ path: `${out}input-390.png` });

await page.locator("#extract").evaluate((node) => node.scrollIntoView({ block: "center" }));
await pause(400);
await page.locator("#extract").click();
await page.waitForFunction(() => {
  const panel = document.getElementById("results");
  return !!panel && !panel.hidden && panel.querySelectorAll("mark.hl").length > 0 && panel.textContent?.includes("INV-2291");
}, null, { timeout: 20_000 });
await page.locator("#results .source").evaluate((node) => node.scrollIntoView({ block: "start" }));
await pause(1100);
await page.screenshot({ path: `${out}results-390.png` });
const range = page.locator("#results .range");
if (await range.count()) {
  await range.first().evaluate((node) => node.scrollIntoView({ block: "center" }));
  await pause(900);
}
const flagged = page.locator("#results .flag");
if (await flagged.count()) {
  await flagged.first().evaluate((node) => node.scrollIntoView({ block: "center" }));
  await pause(800);
}

await page.locator("#comparison h2").evaluate((node) => node.scrollIntoView({ block: "start" }));
await page.waitForFunction(() => {
  const text = document.getElementById("comparison")?.textContent ?? "";
  return text.includes("Schema-valid") && text.includes("Yes") && text.includes("No");
}, null, { timeout: 10_000 });
await pause(1100);
await page.screenshot({ path: `${out}comparison-390.png` });

await waitEnabled(page, "#decide");
await page.locator("#decide").evaluate((node) => node.scrollIntoView({ block: "center" }));
await pause(400);
await page.locator("#decide").click();
await page.waitForFunction(() => {
  const choice = document.querySelector("#decision-body h2")?.textContent ?? "";
  return choice === "refund" || choice === "escalate" || choice === "approve";
}, null, { timeout: 20_000 });
await page.locator("#decision-body h2").evaluate((node) => node.scrollIntoView({ block: "center" }));
await pause(1100);

await page.locator("#batch").evaluate((node) => node.scrollIntoView({ block: "center" }));
await waitEnabled(page, "#batch");
await pause(400);
await page.locator("#batch").click();
await page.waitForSelector("#review .review-card", { timeout: 20_000 });
await page.locator("#refresh").evaluate((node) => node.scrollIntoView({ block: "start" }));
await pause(900);
await page.screenshot({ path: `${out}review-390.png` });
await page.locator("#review .review-card h3").first().evaluate((node) => node.scrollIntoView({ block: "start" }));
await pause(700);
await page.locator("#review .review-card").first().getByRole("button", { name: "Accept" }).click();
await page.waitForFunction(() => document.querySelector("#review .review-card .meta")?.textContent === "accepted", null, { timeout: 20_000 });
await pause(900);

const phoneWidth = await page.evaluate(() => document.documentElement.scrollWidth);
if (phoneWidth > 390) consoleErrors.push(`page wider than viewport: ${phoneWidth}`);

const chartContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const chartPage = await chartContext.newPage();
chartPage.on("pageerror", (err) => consoleErrors.push(err.message));
await chartPage.route("**/turnstile/v0/api.js*", (route) => route.fulfill({
  contentType: "application/javascript",
  body: `window.turnstile={render(el,opts){setTimeout(()=>opts.callback("XXXX.DUMMY.TOKEN.XXXX"),20);return "w";}};`,
}));
await chartPage.goto(`${base}/`, { waitUntil: "domcontentloaded" });
await waitEnabled(chartPage, "#extract");
await chartPage.locator("#samples").getByRole("button", { name: "Insurance claim", exact: true }).click();
await chartPage.locator("#extract").click();
await chartPage.waitForSelector("#results svg.chart", { timeout: 20_000 });
await chartPage.waitForSelector("#results .range", { timeout: 10_000 });
const chartWidth = await chartPage.evaluate(() => document.documentElement.scrollWidth);
if (chartWidth > 390) consoleErrors.push(`claim page wider than viewport: ${chartWidth}`);
await chartContext.close();

const hintContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
});
const hintPage = await hintContext.newPage();
await hintPage.addInitScript(() => localStorage.setItem("theme", "dark"));
hintPage.on("pageerror", (err) => consoleErrors.push(err.message));
await hintPage.route("**/turnstile/v0/api.js*", (route) => route.fulfill({
  contentType: "application/javascript",
  body: `window.turnstile={render(el,opts){setTimeout(()=>opts.callback("XXXX.DUMMY.TOKEN.XXXX"),20);return "w";}};`,
}));
await hintPage.goto(`${base}/`, { waitUntil: "domcontentloaded" });
await waitEnabled(hintPage, "#extract");
await hintPage.fill("#state", "");
await hintPage.setInputFiles("#file", new URL("../public/samples/receipt.png", import.meta.url).pathname);
await hintPage.locator("#extract").click();
await hintPage.waitForFunction(() => (document.getElementById("comparison")?.textContent ?? "").includes("Compare needs pasted text."), null, { timeout: 20_000 });
await hintPage.locator("#comparison").evaluate((node) => node.scrollIntoView({ block: "start" }));
await hintPage.screenshot({ path: `${out}hint-390.png` });
await hintContext.close();

const branchContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
});
const branchPage = await branchContext.newPage();
await branchPage.addInitScript(() => localStorage.setItem("theme", "dark"));
branchPage.on("pageerror", (err) => consoleErrors.push(err.message));
await branchPage.route("**/turnstile/v0/api.js*", (route) => route.fulfill({
  contentType: "application/javascript",
  body: `window.turnstile={render(el,opts){setTimeout(()=>opts.callback("XXXX.DUMMY.TOKEN.XXXX"),20);return "w";}};`,
}));
await branchPage.route("**/api/extract", (route) => route.fulfill({
  contentType: "application/json",
  body: JSON.stringify({
    source: "clairic",
    model: "@cf/cloudflare/clairic",
    stateText: "Invoice INV-2291 from Northwind Supply.",
    answers: {
      invoice_number: { type: "text", value: "INV-2291", confidence: 0.99, span: [8, 16] },
      total: { type: "number", value: 1080, confidence: 0.97 },
    },
    usage: { state_tokens: 20, image_tokens: 0, schema_tokens: 40, input_tokens: 60, output_tokens: 0, passes: 1 },
    latencyMs: 180,
    costUsd: 0.000006,
    review: [],
    photoUnread: false,
    truncated: true,
    labelled: true,
    comparison: {
      source: "llama",
      model: "@cf/meta/llama-3.2-3b-instruct",
      latencyMs: 20,
      costUsd: null,
      schemaValid: false,
      reasons: ["llama_failed: compare_timeout"],
      parsed: null,
      rawPreview: "",
      usage: { state_tokens: 0, image_tokens: 0, schema_tokens: 0, input_tokens: 0, output_tokens: 0, passes: 0 },
    },
  }),
}));
await branchPage.goto(`${base}/`, { waitUntil: "domcontentloaded" });
await waitEnabled(branchPage, "#extract");
await branchPage.locator("#samples").getByRole("button", { name: "Invoice", exact: true }).click();
await branchPage.locator("#extract").click();
await branchPage.waitForFunction(() => {
  const text = document.body.textContent ?? "";
  return text.includes("Clairic truncated this document") && text.includes("Estimated cost unknown");
}, null, { timeout: 20_000 });
await branchPage.locator("#results").evaluate((node) => node.scrollIntoView({ block: "start" }));
await branchPage.screenshot({ path: `${out}truncated-390.png` });
await branchPage.locator("#comparison").evaluate((node) => node.scrollIntoView({ block: "start" }));
await branchPage.screenshot({ path: `${out}unknown-cost-390.png` });
await branchContext.close();

const video = page.video();
await context.close();
const raw = video ? await video.path() : "";
if (raw) {
  const proc = Bun.spawn([
    "ffmpeg", "-y", "-i", raw,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    `${out}clairic-intake-390.mp4`,
  ], { stdout: "ignore", stderr: "pipe" });
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
console.log(`Wrote ${out}input-390.png, results-390.png, comparison-390.png, review-390.png, hint-390.png, truncated-390.png, unknown-cost-390.png, clairic-intake-390.mp4`);
