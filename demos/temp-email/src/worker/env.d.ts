/** Checked-in Env so `bun run typecheck` works without generated worker-configuration.d.ts. */
interface Env {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  ASSETS: Fetcher;
  CREATE_LIMIT: RateLimit;
  READ_LIMIT: RateLimit;
  SMTP_LIMIT: RateLimit;
  GATE_LIMIT: RateLimit;
  WEB_CREATE_LIMIT: RateLimit;
  MAIL_DOMAIN: string;
  PUBLIC_ORIGIN: string;
  WEB_TTL_MINUTES: string;
  MAX_TTL_MINUTES: string;
  HOSTED_MODE: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY?: string;
  AGENT_API_KEY?: string;
}
