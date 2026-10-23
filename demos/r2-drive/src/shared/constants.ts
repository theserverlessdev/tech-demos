/** Per-drive caps. Tight on purpose: this demo must not be a file host. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_DRIVE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 200;

/** Enforced on every request, by the Durable Object alarm, and by cron. */
export const DRIVE_TTL_MS = 60 * 60 * 1000;
export const VERIFY_TTL_MS = 15 * 60 * 1000;
export const AUDIT_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** Global mint cap stored in D1. The rate-limit binding window is one minute. */
export const DAILY_MINT_CAP = 40;
export const AUP_VERSION = "2026-10-23";

/**
 * Rate-limit namespace ids. Checked against the other demos on 2026-10-23.
 * The next free block started at 7601 (temp-email uses 7550–7552).
 */
export const RATE_LIMIT_IDS = {
  MINT_IP: "7601",
  MINT_EMAIL: "7602",
  MINT_GLOBAL: "7603",
  DAV_READ: "7604",
  DAV_WRITE: "7605",
  PAGE: "7606",
  REPORT: "7608",
  ADMIN: "7609",
  VERIFY: "7610",
  WS: "7611",
  READ: "7612",
} as const;

export type LimitName = keyof typeof RATE_LIMIT_IDS;

export const DRIVE_ID_RE = /^drv_[a-f0-9]{32}$/;

export const AUP_TEXT =
  "This is a one-hour demo drive. I will not upload sexual material involving anyone under 18, or anything else illegal. There are no share links. Files stay on my credential and are deleted within an hour.";
