import { expect, test } from "bun:test";
import { safeRedirectTarget } from "../../packages/shared/src/index.ts";

const origin = "https://email.lomvic.com";

test("hub path redirects onto the mail origin", () => {
  const target = safeRedirectTarget(
    "https://tech-demos.theserverless.dev/demos/temp-email/inbox/abc?n=1",
    "temp-email",
    origin,
  );
  expect(target?.href).toBe("https://email.lomvic.com/inbox/abc?n=1");
});

test("prefix without a slash boundary does not jump off the mail origin", () => {
  const target = safeRedirectTarget(
    "https://tech-demos.theserverless.dev/demos/temp-email.evil.example",
    "temp-email",
    origin,
  );
  expect(target?.origin).toBe(origin);
  expect(target?.hostname).toBe("email.lomvic.com");
  expect(target?.href).not.toBe("https://email.lomvic.com.evil.example");
});
