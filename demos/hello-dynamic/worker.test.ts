import { expect, test } from "bun:test";
import worker from "./worker.js";

test("escapes and caps ?name= on Unicode code points", async () => {
  const res = await worker.fetch(new Request("https://hub.test/demos/hello-dynamic/?name=<script>alert(1)</script>"));
  const html = await res.text();
  expect(html).toContain("Hello, &lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).not.toContain("<script>alert(1)</script>");

  const long = "A".repeat(80);
  const capped = await (await worker.fetch(new Request(`https://hub.test/?name=${long}`))).text();
  expect(capped).toContain(`Hello, ${"A".repeat(64)}`);
  expect(capped).not.toContain("A".repeat(65));
});

test("empty or whitespace ?name= greets world", async () => {
  const empty = await (await worker.fetch(new Request("https://hub.test/?name="))).text();
  const spaces = await (await worker.fetch(new Request("https://hub.test/?name=%20%20"))).text();
  const missing = await (await worker.fetch(new Request("https://hub.test/"))).text();
  expect(empty).toContain("Hello, world");
  expect(spaces).toContain("Hello, world");
  expect(missing).toContain("Hello, world");
  expect(empty).not.toContain("Hello, </h1>");
});

test("caps astral characters without splitting surrogates", async () => {
  const faces = "😀".repeat(70);
  const html = await (await worker.fetch(new Request(`https://hub.test/?name=${encodeURIComponent(faces)}`))).text();
  expect(html).toContain(`Hello, ${"😀".repeat(64)}`);
  expect(html).not.toContain("😀".repeat(65));
  expect(html).not.toContain("\uD83D</h1>");
});

test("shows the loader id in HTML and does not echo x-dynamic-worker", async () => {
  const res = await worker.fetch(
    new Request("https://hub.test/", { headers: { "x-dynamic-worker": "hello-dynamic:deadbeef" } }),
  );
  expect(res.headers.get("x-dynamic-worker")).toBeNull();
  const html = await res.text();
  expect(html).toContain("hello-dynamic:deadbeef");
  expect(html).toContain("← All demos");
  expect(html).toContain("https://tech-demos.theserverless.dev/");
});

test("serves a GET name form, wrap styles, 44px targets, and a meta CSP", async () => {
  const html = await (await worker.fetch(new Request("https://hub.test/"))).text();
  expect(html).toContain('<form method="get">');
  expect(html).toContain('name="name"');
  expect(html).not.toContain("maxlength=");
  expect(html).toContain('aria-label="Name"');
  expect(html).toContain('<a href="?name=Ankur">');
  expect(html).toContain("GET and HEAD only");
  expect(html).toContain("h1 {");
  expect(html).toContain("overflow-wrap: anywhere");
  expect(html).toContain("min-height: 44px");
  expect(html).toContain("font-size: 16px");
  expect(html).toContain("min-height: 100dvh");
  expect(html).toContain('content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'"');
  expect(html).toContain("globalOutbound: null");
});

test("isolate request counter increments across fetches", async () => {
  const a = await (await worker.fetch(new Request("https://hub.test/"))).text();
  const b = await (await worker.fetch(new Request("https://hub.test/"))).text();
  const na = Number(/request #(\d+)/i.exec(a)?.[1]);
  const nb = Number(/request #(\d+)/i.exec(b)?.[1]);
  expect(na).toBeGreaterThan(0);
  expect(nb).toBe(na + 1);
});
