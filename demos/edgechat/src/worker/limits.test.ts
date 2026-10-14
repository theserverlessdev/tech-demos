import { expect, test } from "bun:test";
import { newBucket, takeToken } from "./limits.ts";

test("socket bucket allows 5 sends then rejects until the window refills", () => {
  const start = 1_000_000;
  const bucket = newBucket(start);
  for (let i = 0; i < 5; i++) expect(takeToken(bucket, start)).toBe(true);
  expect(takeToken(bucket, start)).toBe(false);
  expect(takeToken(bucket, start + 1_999)).toBe(false);
  expect(takeToken(bucket, start + 2_000)).toBe(true);
});
