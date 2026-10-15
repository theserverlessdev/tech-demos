import { expect, test } from "bun:test";
import { demoPath, redirectSource, rewriteDemoPath, safeRedirectTarget } from "./src/index.ts";

test("demoPath uses a trailing slash", () => {
  expect(demoPath("hello-dynamic")).toBe("/demos/hello-dynamic/");
});

test("rewriteDemoPath requires a / boundary", () => {
  expect(rewriteDemoPath("/demos/temp-email", "temp-email")).toBe("/");
  expect(rewriteDemoPath("/demos/temp-email/", "temp-email")).toBe("/");
  expect(rewriteDemoPath("/demos/temp-email/inbox/x", "temp-email")).toBe("/inbox/x");
  expect(rewriteDemoPath("/demos/temp-email.evil.example", "temp-email")).toBe("/demos/temp-email.evil.example");
  expect(rewriteDemoPath("/demos/temp-emailx", "temp-email")).toBe("/demos/temp-emailx");
});

test("safeRedirectTarget keeps the origin and rejects prefix tricks", () => {
  const origin = "https://email.lomvic.com";
  const ok = safeRedirectTarget("https://tech-demos.theserverless.dev/demos/temp-email/inbox?x=1", "temp-email", origin);
  expect(ok?.href).toBe("https://email.lomvic.com/inbox?x=1");

  const evil = safeRedirectTarget(
    "https://tech-demos.theserverless.dev/demos/temp-email.evil.example",
    "temp-email",
    origin,
  );
  expect(evil?.origin).toBe("https://email.lomvic.com");
  expect(evil?.href).toBe("https://email.lomvic.com/demos/temp-email.evil.example");

  expect(safeRedirectTarget("https://hub.example/demos/x", "x", "not-a-url")).toBeNull();
});

test("redirectSource is self-contained and uses new URL + origin check", () => {
  const source = redirectSource("temp-email", "https://email.lomvic.com");
  expect(source).toContain('const prefix = "/demos/" + slug');
  expect(source).toContain("new URL(rest || \"/\", origin)");
  expect(source).toContain("target.origin !== new URL(origin).origin");
  expect(source).not.toContain("${env.PUBLIC_ORIGIN}${rest}");
});
