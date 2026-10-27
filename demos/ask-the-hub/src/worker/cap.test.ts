import { expect, test } from "bun:test";
import { DAILY_CAP, claimDay, createLock, nextMidnightUtc, type Counter } from "./cap";

function memoryCounter(): Counter & { map: Map<string, number> } {
  const map = new Map<string, number>();
  return {
    map,
    async get(day) {
      const value = map.get(day) ?? 0;
      await Promise.resolve();
      return value;
    },
    async set(day, count) {
      await Promise.resolve();
      map.set(day, count);
    },
  };
}

test("the counter stops at 200 and names midnight UTC", async () => {
  const counter = memoryCounter();
  const now = new Date("2026-10-27T23:59:00.000Z");
  for (let i = 0; i < DAILY_CAP; i++) {
    const result = await claimDay(counter, now);
    expect(result.ok).toBe(true);
  }
  const blocked = await claimDay(counter, now);
  expect(blocked.ok).toBe(false);
  expect(blocked.used).toBe(200);
  expect(blocked.remaining).toBe(0);
  expect(blocked.resetsAt).toBe("2026-10-28T00:00:00.000Z");
  expect(nextMidnightUtc(now)).toBe("2026-10-28T00:00:00.000Z");
  const nextDay = await claimDay(counter, new Date("2026-10-28T00:00:00.000Z"));
  expect(nextDay.ok).toBe(true);
  expect(nextDay.used).toBe(1);
});

test("concurrent increments keep the cap at 200", async () => {
  const counter = memoryCounter();
  const lock = createLock();
  const now = new Date("2026-10-27T15:00:00.000Z");
  const results = await Promise.all(Array.from({ length: 250 }, () => lock(() => claimDay(counter, now))));
  expect(results.filter((result) => result.ok)).toHaveLength(200);
  expect(results.filter((result) => !result.ok)).toHaveLength(50);
  expect(counter.map.get("2026-10-27")).toBe(200);
  expect(results.find((result) => !result.ok)?.resetsAt).toBe("2026-10-28T00:00:00.000Z");
});

test("unlocked overlapping claims lose increments", async () => {
  const counter = memoryCounter();
  const now = new Date("2026-10-27T15:00:00.000Z");
  await Promise.all(Array.from({ length: 40 }, () => claimDay(counter, now)));
  expect(counter.map.get("2026-10-27")).toBeLessThan(40);
});
