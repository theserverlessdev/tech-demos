import { expect, test } from "bun:test";
import { consumeAuthCode } from "../src/worker/codes";

const now = 1_700_000_000_000;

test("a fresh unused code is accepted", () => {
  expect(consumeAuthCode({ usedAt: null, expiresAt: now + 60_000 }, now)).toEqual({ ok: true });
});

test("code reuse is rejected", () => {
  expect(consumeAuthCode({ usedAt: now - 1, expiresAt: now + 60_000 }, now)).toEqual({ ok: false, reason: "used" });
});

test("expired and missing codes are rejected", () => {
  expect(consumeAuthCode({ usedAt: null, expiresAt: now }, now)).toEqual({ ok: false, reason: "expired" });
  expect(consumeAuthCode(null, now)).toEqual({ ok: false, reason: "missing" });
});
