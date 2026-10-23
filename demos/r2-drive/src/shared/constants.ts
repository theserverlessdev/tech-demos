/** Per-drive caps. Tight on purpose: this demo must not be a file host. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_DRIVE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 200;

/** Enforced on every request, by the Durable Object alarm, and by cron. */
export const DRIVE_TTL_MS = 60 * 60 * 1000;
export const VERIFY_TTL_MS = 15 * 60 * 1000;
export const AUDIT_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** Drives created at verify time. Emails sent are counted separately. */
export const DAILY_MINT_CAP = 40;
export const DAILY_EMAIL_CAP = 40;

export const MAX_LOCKS_PER_DRIVE = 64;
export const MAX_SHARED_LOCKS_PER_PATH = 8;
export const MAX_LOCK_OWNER_BYTES = 1024;

/** A frozen drive stays for evidence until an admin releases it, or this long. */
export const FROZEN_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** Authenticated requests that reach the Durable Object, for the life of that drive. */
export const MAX_DRIVE_REQUESTS = 3000;

export const AUP_VERSION = "2026-10-23.3";

/** Relative object keys longer than this are rejected with 414. R2's limit is 1024. */
export const MAX_KEY_BYTES = 900;

/** AppleDouble and .DS_Store writes are accepted only under this size. */
export const FINDER_MAX_BYTES = 64 * 1024;

export const DAV_CSP = "default-src 'none'; sandbox";

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
  DAV_GLOBAL: "7607",
  REPORT: "7608",
  ADMIN: "7609",
  VERIFY: "7610",
  WS: "7611",
  READ: "7612",
  DAV_DRIVE: "7613",
} as const;

export type LimitName = keyof typeof RATE_LIMIT_IDS;

export const DRIVE_ID_RE = /^drv_[a-f0-9]{32}$/;

export const AUP_TEXT =
  "This is a short-lived sandbox for testing WebDAV with small documents. Only text and PDF documents are accepted. Office files are not accepted. The drive is private and wiped within an hour.";
