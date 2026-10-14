import { describe, expect, test } from "bun:test";
import { LIMITS } from "../src/shared/limits";

describe("stream limiter", () => {
  test("the isolate concurrency lock is gone; rate limits cover chat", () => {
    expect("concurrentGlobal" in LIMITS).toBe(false);
    expect("concurrentPerIp" in LIMITS).toBe(false);
  });
});
