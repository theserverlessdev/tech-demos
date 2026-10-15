/** Deep-link ticket mint: 3 tries, 400ms × 2^(n-1) after the first failure. */
export const DEEP_JOIN_MAX = 3;
export const DEEP_BACKOFF_MS = 400;

export function deepBackoffMs(failedAttempts: number): number {
  if (failedAttempts <= 0) return 0;
  return DEEP_BACKOFF_MS * 2 ** (failedAttempts - 1);
}

export function deepJoinExhausted(attempts: number): boolean {
  return attempts >= DEEP_JOIN_MAX;
}

/** Turnstile re-solve must not replace a join/mint warning. */
export function shouldKeepJoinError(kind: string | undefined): boolean {
  return kind === "warn";
}
