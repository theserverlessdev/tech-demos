import { MINUTE_MS } from "./limits";

/** Next expiry, or null when the created_at ceiling would not move. */
export function nextExpiry(opts: {
  createdAt: number;
  expiresAt: number;
  now: number;
  minutes: number;
  ceilingMinutes: number;
}): number | null {
  const ceiling = opts.createdAt + opts.ceilingMinutes * MINUTE_MS;
  const expiresAt = Math.min(Math.max(opts.expiresAt, opts.now) + opts.minutes * MINUTE_MS, ceiling);
  return expiresAt <= opts.expiresAt ? null : expiresAt;
}
