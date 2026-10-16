import { expect, test } from "bun:test";
import { DEMO_D, DEMO_KID, rejectDemoSigningKey } from "../src/worker/jwks";

test("demo-key guard rejects the committed key outside local", () => {
  expect(rejectDemoSigningKey({ kid: DEMO_KID, d: DEMO_D }, { ENVIRONMENT: "" })).toBeTrue();
  expect(rejectDemoSigningKey({ kid: DEMO_KID, d: "other" }, { ENVIRONMENT: "production" })).toBeTrue();
  expect(rejectDemoSigningKey({ kid: "other", d: DEMO_D }, {})).toBeTrue();
});

test("demo-key guard allows the committed key in local and other keys anywhere", () => {
  expect(rejectDemoSigningKey({ kid: DEMO_KID, d: DEMO_D }, { ENVIRONMENT: "local" })).toBeFalse();
  expect(rejectDemoSigningKey({ kid: "prod-1", d: "not-the-demo-d" }, { ENVIRONMENT: "" })).toBeFalse();
});
