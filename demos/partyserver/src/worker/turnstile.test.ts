import { expect, test } from "bun:test";
import { TEST_TURNSTILE_SECRET, TEST_TURNSTILE_SITE_KEY, assessTurnstile, siteverifyHostOk } from "./turnstile";

test("missing secret is closed", () => {
  expect(assessTurnstile({ secret: "", siteKey: "real-site", allowTestCredentials: false })).toBe("closed");
});

test("production rejects the always-pass test secret", () => {
  expect(assessTurnstile({ secret: TEST_TURNSTILE_SECRET, siteKey: "real-site", allowTestCredentials: false })).toBe("closed");
});

test("local flag accepts the published test pair", () => {
  expect(assessTurnstile({ secret: TEST_TURNSTILE_SECRET, siteKey: TEST_TURNSTILE_SITE_KEY, allowTestCredentials: true })).toBe("open");
});

test("a real pair is open without the local flag", () => {
  expect(assessTurnstile({ secret: "real-secret", siteKey: "real-site", allowTestCredentials: false })).toBe("open");
});

test("example.com is only a test host when local credentials are allowed", () => {
  expect(
    siteverifyHostOk({
      resultHost: "example.com",
      requestHost: "tech-demos.theserverless.dev",
      action: "create-room",
      allowTestCredentials: true,
    }),
  ).toBe(true);
  expect(
    siteverifyHostOk({
      resultHost: "example.com",
      requestHost: "tech-demos.theserverless.dev",
      action: "create-room",
      allowTestCredentials: false,
    }),
  ).toBe(false);
});

test("localhost tokens do not skip the hostname bind in production", () => {
  expect(
    siteverifyHostOk({
      resultHost: "localhost",
      requestHost: "tech-demos.theserverless.dev",
      action: "create-room",
      allowTestCredentials: false,
    }),
  ).toBe(false);
});

test("a matching production host and action pass", () => {
  expect(
    siteverifyHostOk({
      resultHost: "tech-demos.theserverless.dev",
      requestHost: "tech-demos.theserverless.dev",
      action: "create-room",
      allowTestCredentials: false,
    }),
  ).toBe(true);
});
