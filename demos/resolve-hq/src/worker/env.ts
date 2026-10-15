export function isLocalEnv(env: Env): boolean {
  return `${env.ENVIRONMENT}` === "local";
}

/** Empty and REPLACE_ME mean Turnstile is not configured. */
export function publicSiteKey(env: Env): string | null {
  const key = env.TURNSTILE_SITE_KEY?.trim() ?? "";
  if (!key || key === "REPLACE_ME") return null;
  return key;
}

export {};

declare global {
  interface Env {
    AI?: Ai;
    DB: D1Database;
    ATTACHMENTS: R2Bucket;
    INBOUND: Queue;
    ASSETS: Fetcher;
    WRITE_LIMIT: RateLimit;
    SESSION_LIMIT: RateLimit;
    AI_LIMIT: RateLimit;
    UPLOAD_LIMIT: RateLimit;
    HEALTH_LIMIT: RateLimit;
    AI_MODEL: string;
    DEV_MAIL_MODE: string;
    ENVIRONMENT: string;
    TURNSTILE_SITE_KEY: string;
    TURNSTILE_SECRET?: string;
    SESSION_SECRET?: string;
    DAILY_DRAFT_CAP: string;
    IP_DRAFT_CAP: string;
  }
}
