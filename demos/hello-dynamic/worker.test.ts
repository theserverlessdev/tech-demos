import { expect, test } from "bun:test";
import worker from "./worker.js";

test("escapes and caps ?name=", async () => {
  const res = await worker.fetch(new Request("https://hub.test/demos/hello-dynamic/?name=<script>alert(1)</script>"));
  const html = await res.text();
  expect(html).toContain("Hello, &lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).not.toContain("<script>alert(1)</script>");

  const long = "A".repeat(80);
  const capped = await (await worker.fetch(new Request(`https://hub.test/?name=${long}`))).text();
  expect(capped).toContain(`Hello, ${"A".repeat(64)}`);
  expect(capped).not.toContain("A".repeat(65));
});

test("shows the loader id, x-dynamic-worker header, and back link", async () => {
  const res = await worker.fetch(
    new Request("https://hub.test/", { headers: { "x-dynamic-worker": "hello-dynamic:deadbeef" } }),
  );
  expect(res.headers.get("x-dynamic-worker")).toBe("hello-dynamic:deadbeef");
  const html = await res.text();
  expect(html).toContain("hello-dynamic:deadbeef");
  expect(html).toContain("← All demos");
  expect(html).toContain("https://tech-demos.theserverless.dev/");
});
