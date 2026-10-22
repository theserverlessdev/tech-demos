import { describe, expect, test } from "bun:test";
import { budgetDecision, dayKey, guardFailure, rateLimitResult } from "../src/shared/budget";
import { LIMITS } from "../src/shared/limits";
import { refundCalls, reserveCalls, spendUsed } from "../src/worker/db";
import { asD1, memoryDb } from "./helpers";

const open = {
  bodyBytes: 100,
  stateChars: 20,
  images: 0,
  imageBytes: 0,
  remoteImage: false,
  turnstileOk: true,
  rateOk: true,
  budgetOk: true,
};

describe("budget and rate limit", () => {
  test("a failed limiter blocks the call and a passing one does not", () => {
    expect(rateLimitResult(true).ok).toBe(true);
    const blocked = rateLimitResult(false);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe("rate_limited");
  });

  test("the daily budget stops before the cap and counts a batch as many calls", () => {
    expect(budgetDecision(0, 12).ok).toBe(true);
    expect(budgetDecision(30, 12).ok).toBe(false);
    const edge = budgetDecision(LIMITS.dailyCalls, 1);
    expect(edge.ok).toBe(false);
    if (!edge.ok) expect(edge.message).toContain("0 paid calls");
    expect(budgetDecision(39, 1)).toEqual({ ok: true, remaining: 0 });
  });

  test("the conditional insert is the backstop when two reservations race the cap", async () => {
    const db = asD1(memoryDb());
    const now = Date.parse("2026-10-22T12:00:00Z");
    expect(dayKey(now)).toBe("2026-10-22");
    expect(await reserveCalls(db, "ip", now, 30, 40)).toBe("ok");
    expect(await reserveCalls(db, "ip", now, 12, 40)).toBe("ip");
    expect(await spendUsed(db, "ip", now)).toBe(30);
    expect(await reserveCalls(db, "ip", now, 10, 40)).toBe("ok");
    expect(await spendUsed(db, "ip", now)).toBe(40);
    expect(await spendUsed(db, "*", now)).toBe(40);
    expect(await reserveCalls(db, "other", now, 40, 40)).toBe("ok");
  });

  test("a refund returns the reserved calls to the network and the shared cap", async () => {
    const db = asD1(memoryDb());
    const now = Date.parse("2026-10-22T12:00:00Z");
    expect(await reserveCalls(db, "ip", now, 12)).toBe("ok");
    await refundCalls(db, "ip", now, 12);
    expect(await spendUsed(db, "ip", now)).toBe(0);
    expect(await spendUsed(db, "*", now)).toBe(0);
  });

  test("the shared daily cap stops every network with one statement", async () => {
    const db = asD1(memoryDb());
    const now = Date.parse("2026-10-22T12:00:00Z");
    expect(await reserveCalls(db, "a", now, 30, 40, 50)).toBe("ok");
    expect(await reserveCalls(db, "b", now, 30, 40, 50)).toBe("global");
    expect(await spendUsed(db, "b", now)).toBe(0);
    expect(await spendUsed(db, "*", now)).toBe(30);
  });

  test("the body cap covers a 1.5 MB image plus the text field", () => {
    const floor = Math.ceil((LIMITS.maxImageBytes * 4) / 3) + LIMITS.maxStateChars * 6 + 64 * 1024;
    expect(LIMITS.maxBodyBytes).toBeGreaterThanOrEqual(floor);
  });

  test("the guard rejects a remote image, a huge body, and a failed check before the model", () => {
    expect(guardFailure(open)).toBeNull();
    expect(guardFailure({ ...open, remoteImage: true })?.code).toBe("bad_image");
    expect(guardFailure({ ...open, bodyBytes: LIMITS.maxBodyBytes + 1 })?.code).toBe("too_large");
    expect(guardFailure({ ...open, turnstileOk: false })?.code).toBe("turnstile_failed");
    expect(guardFailure({ ...open, rateOk: false })?.code).toBe("rate_limited");
    expect(guardFailure({ ...open, budgetOk: false })?.code).toBe("budget");
  });
});
