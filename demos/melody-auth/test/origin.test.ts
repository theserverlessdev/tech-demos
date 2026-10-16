import { expect, test } from "bun:test";
import { originAllowed, publicBase } from "../src/worker/origin";

test("same origin is allowed", () => {
  const req = new Request("http://127.0.0.1:8788/authorize", {
    headers: { origin: "http://127.0.0.1:8788" },
  });
  expect(originAllowed(req)).toBeTrue();
});

test("missing Origin is allowed; Origin null is rejected", () => {
  expect(originAllowed(new Request("http://127.0.0.1:8788/authorize"))).toBeTrue();
  expect(
    originAllowed(new Request("http://127.0.0.1:8788/authorize", { headers: { origin: "null" } })),
  ).toBeFalse();
});

test("sec-fetch-site cross-site is rejected", () => {
  const req = new Request("http://127.0.0.1:8788/authorize", {
    headers: { origin: "http://127.0.0.1:8788", "sec-fetch-site": "cross-site" },
  });
  expect(originAllowed(req)).toBeFalse();
});

test("hub Origin is no longer accepted", () => {
  const req = new Request("https://melody-auth.tech-demos.theserverless.dev/authorize", {
    headers: { origin: "https://tech-demos.theserverless.dev" },
  });
  expect(originAllowed(req)).toBeFalse();
});

test("localhost Origin is only accepted on a local request host", () => {
  const local = new Request("http://localhost:8788/authorize", {
    headers: { origin: "http://127.0.0.1:8788" },
  });
  expect(originAllowed(local)).toBeTrue();

  const prod = new Request("https://melody-auth.tech-demos.theserverless.dev/authorize", {
    headers: { origin: "http://localhost:8788" },
  });
  expect(originAllowed(prod)).toBeFalse();
});

test("production issuer is the auth subdomain only", () => {
  const req = new Request("https://tech-demos.theserverless.dev/demos/melody-auth/.well-known/openid-configuration");
  expect(publicBase(req, { ENVIRONMENT: "" }).issuer).toBe("https://melody-auth.tech-demos.theserverless.dev");
  const local = new Request("http://127.0.0.1:8788/.well-known/openid-configuration");
  expect(publicBase(local, { ENVIRONMENT: "local" }).issuer).toBe("http://127.0.0.1:8788");
});
