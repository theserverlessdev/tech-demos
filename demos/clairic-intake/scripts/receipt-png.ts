// Draws the bundled receipt photo with headless Chrome. Commit public/samples/receipt.png.
import { mkdir } from "node:fs/promises";

const html = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;background:#d9d3c7;}
  article{width:420px;margin:28px auto;background:#f6f1e6;color:#221e18;font:18px/1.45 ui-monospace,monospace;
    padding:28px 26px 32px;box-shadow:0 10px 28px rgba(0,0,0,.18);transform:rotate(-1.4deg);}
  h1{font:700 22px/1.2 ui-monospace,monospace;letter-spacing:.12em;margin:0 0 8px;text-align:center;}
  p{margin:0;}
  .rule{border-top:1px dashed #221e18;margin:12px 0;}
  .row{display:flex;justify-content:space-between;gap:12px;}
  strong{font-size:20px;}
</style>
<article>
  <h1>NORTHWIND CAFE</h1>
  <p>Order 77245</p>
  <p>2026-07-01 13:34</p>
  <div class="rule"></div>
  <p class="row"><span>2 x drip coffee</span><span>$7.99</span></p>
  <div class="rule"></div>
  <p class="row"><span>Subtotal</span><span>$15.98</span></p>
  <p class="row"><span>Tax</span><span>$0.00</span></p>
  <p class="row"><span>Tip</span><span>$2.39</span></p>
  <p class="row"><strong>Total</strong><strong>$18.37</strong></p>
</article>`;

const dir = new URL("../public/samples/", import.meta.url);
await mkdir(dir, { recursive: true });
const pagePath = new URL("receipt.html", dir);
await Bun.write(pagePath, html);
const out = new URL("receipt.png", dir).pathname;
const chrome = "/opt/google/chrome/chrome";
const proc = Bun.spawn([
  chrome,
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--hide-scrollbars",
  "--no-first-run",
  "--user-data-dir=/tmp/clairic-receipt-chrome",
  "--virtual-time-budget=2000",
  "--timeout=8000",
  "--window-size=480,640",
  `--screenshot=${out}`,
  pagePath.href,
], { stdout: "pipe", stderr: "pipe" });
const code = await proc.exited;
if (code !== 0) {
  console.error(await new Response(proc.stderr).text());
  process.exit(code);
}
console.log(`wrote ${out}`);
