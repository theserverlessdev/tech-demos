// Two-tab transfer against a running `bun run dev`. bun run scripts/capture.ts http://127.0.0.1:8794
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";

const base = (process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8794").replace(/\/$/, "");
const out = new URL("../artifacts/", import.meta.url);
await mkdir(out, { recursive: true });

const payload = new Uint8Array(1_500_000);
for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
const filePath = "/tmp/pairlane-sample.bin";
await writeFile(filePath, payload);

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-features=WebRtcHideLocalIpsWithMdns",
    "--use-fake-ui-for-media-stream",
  ],
});

function watch(page: Page, name: string) {
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log(`[${name}]`, msg.text());
  });
  page.on("pageerror", (err) => console.log(`[${name}]`, err.message));
}

const senderContext = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  colorScheme: "dark",
  recordVideo: { dir: out.pathname, size: { width: 1280, height: 800 } },
});
const receiverContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
  colorScheme: "dark",
  isMobile: true,
  hasTouch: true,
});
const sender = await senderContext.newPage();
const receiver = await receiverContext.newPage();
watch(sender, "sender");
watch(receiver, "receiver");

async function passCheck(page: Page) {
  const local = page.locator("#local-check");
  await local.waitFor({ state: "visible", timeout: 10_000 });
  await local.click();
  await page.locator("#create:enabled").click();
}

await sender.goto(`${base}/`, { waitUntil: "domcontentloaded" });
await passCheck(sender);
await sender.waitForURL(/[?&]r=/, { timeout: 15_000 });
await sender.locator("#qr svg").waitFor({ timeout: 10_000 });

const roomUrl = sender.url();
await receiver.goto(roomUrl, { waitUntil: "domcontentloaded" });
await receiver.locator("#qr svg").waitFor({ timeout: 10_000 });

await sender.locator("#status[data-kind='connected']").waitFor({ timeout: 20_000 });
await receiver.locator("#status[data-kind='connected']").waitFor({ timeout: 20_000 });
await sender.waitForTimeout(800);

await sender.locator("#file").setInputFiles(filePath);
await sender.locator("#status[data-kind='done']").waitFor({ timeout: 30_000 });
await receiver.locator("#status[data-kind='done']").waitFor({ timeout: 10_000 });
const senderText = await sender.locator("#status").innerText();
const receiverText = await receiver.locator("#status").innerText();
const tape = await sender.locator("#tape").innerText();
if (!senderText.includes("SHA-256 matches")) throw new Error(`sender status: ${senderText}`);
if (!receiverText.includes("SHA-256 matches")) throw new Error(`receiver status: ${receiverText}`);
if (!/offer ·/.test(tape) || !/answer ·/.test(tape) || !/ice ·/.test(tape)) {
  throw new Error(`tape missing signalling lines:\n${tape}`);
}
if (/sha256|sample\.bin/.test(tape)) throw new Error("tape contains file bytes");
await receiver.locator("#save").scrollIntoViewIfNeeded();
await sender.screenshot({ path: `${out.pathname}/room-desktop.png` });
await receiver.screenshot({ path: `${out.pathname}/room-390.png` });
await sender.waitForTimeout(1000);

await senderContext.close();
await receiverContext.close();
await browser.close();
console.log("transfer ok");
console.log(senderText);
console.log(receiverText);
console.log(tape);
