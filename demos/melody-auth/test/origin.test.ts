import { expect, test } from "bun:test";
import { originAllowed } from "../src/worker/origin";

test("same origin is allowed", () => {
  const req = new Request("http://127.0.0.1:8788/authorize", {
    headers: { origin: "http://127.0.0.1:8788" },
  });
  expect(originAllowed(req)).toBeTrue();
});

test("missing or null Origin is allowed for navigational POSTs", () => {
  expect(originAllowed(new Request("http://127.0.0.1:8788/authorize"))).toBeTrue();
  expect(
    originAllowed(new Request("http://127.0.0.1:8788/authorize", { headers: { origin: "null" } })),
  ).toBeTrue();
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
