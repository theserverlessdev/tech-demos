import { expect, test } from "bun:test";
import { challengeShape, s256Challenge, verifierShape, verifyS256 } from "../src/worker/pkce";

const VERIFIER = "a".repeat(43);

test("S256 challenge matches the verifier", async () => {
  const challenge = await s256Challenge(VERIFIER);
  expect(challengeShape(challenge)).toBeTrue();
  expect(await verifyS256(VERIFIER, challenge)).toBeTrue();
});

test("wrong verifier fails", async () => {
  const challenge = await s256Challenge(VERIFIER);
  expect(await verifyS256("b".repeat(43), challenge)).toBeFalse();
});

test("plain / short values are rejected", async () => {
  expect(verifierShape("short")).toBeFalse();
  expect(challengeShape("short")).toBeFalse();
  expect(await verifyS256("short", await s256Challenge(VERIFIER))).toBeFalse();
});
