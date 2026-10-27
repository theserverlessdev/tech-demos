export const DAILY_CAP = 200;

export type ClaimResult = {
  ok: boolean;
  used: number;
  remaining: number;
  cap: number;
  resetsAt: string;
};

export type Counter = {
  get(day: string): Promise<number> | number;
  set(day: string, count: number): Promise<void> | void;
};

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Midnight UTC after `now`, as an ISO string. */
export function nextMidnightUtc(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

export function capMessage(cap: number): string {
  return `Ask the Hub has answered ${cap} questions today. It resets at midnight UTC.`;
}

/**
 * Read-then-write one day's counter. Callers that share a counter must run this
 * one at a time. AskCap does that with blockConcurrencyWhile.
 */
export async function claimDay(counter: Counter, now: Date, cap = DAILY_CAP): Promise<ClaimResult> {
  const resetsAt = nextMidnightUtc(now);
  const used = await counter.get(utcDay(now));
  if (used >= cap) return { ok: false, used, remaining: 0, cap, resetsAt };
  const next = used + 1;
  await counter.set(utcDay(now), next);
  return { ok: true, used: next, remaining: cap - next, cap, resetsAt };
}

/** Promise chain with the same shape as a Durable Object input lock. */
export function createLock() {
  let tail: Promise<unknown> = Promise.resolve();
  return function lock<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = tail.then(() => fn());
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
