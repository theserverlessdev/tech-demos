import { expect, test } from "bun:test";
import { newBucket, noteStrike, sessionWriteKey, STRIKE_DECAY_MS, STRIKE_LIMIT, takeToken } from "./limits.ts";

test("socket bucket allows 5 sends then rejects until the window refills", () => {
  const start = 1_000_000;
  const bucket = newBucket(start);
  for (let i = 0; i < 5; i++) expect(takeToken(bucket, start)).toBe(true);
  expect(takeToken(bucket, start)).toBe(false);
  expect(takeToken(bucket, start + 1_999)).toBe(false);
  expect(takeToken(bucket, start + 2_000)).toBe(true);
});

test("session write keys are distinct from IP keys", () => {
  expect(sessionWriteKey("abc")).toBe("s:abc");
});

test("strikes decay after the window so a fast legitimate typer is not closed", () => {
  const start = 2_000_000;
  const bucket = newBucket(start);
  expect(noteStrike(bucket, start)).toBe(1);
  expect(noteStrike(bucket, start + 100)).toBe(2);
  expect(noteStrike(bucket, start + 200)).toBe(STRIKE_LIMIT);
  expect(noteStrike(bucket, start + STRIKE_DECAY_MS + 201)).toBe(1);
});

test("strikes on a pre-decay bucket (no struckAt) reset instead of stacking", () => {
  const bucket: ReturnType<typeof newBucket> = { tokens: 5, tokensAt: 1, strikes: 2, struckAt: 0 };
  expect(noteStrike(bucket, 3_000_000)).toBe(1);
});
