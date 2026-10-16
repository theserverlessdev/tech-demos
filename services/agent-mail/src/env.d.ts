declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    MAIL_BUCKET: R2Bucket;
    EMAIL: SendEmail;
    MAIL_DOMAIN: string;
    PUBLIC_ORIGIN: string;
    /** Issuer. Example: https://theserverlessdev.cloudflareaccess.com */
    TEAM_DOMAIN: string;
    /** Access application AUD tag. */
    POLICY_AUD: string;
    /** Email that becomes the first admin on first valid Access login. */
    ADMIN_EMAIL: string;
    /** Hours a one-tap approval link stays valid. Default 168 (7 days). */
    APPROVE_LINK_TTL_HOURS?: string;
  /** Zone id for theserverless.dev. Used to write Email Routing rules. */
  CF_ZONE_ID?: string;
  /** Worker name used in literal Email Routing rules. */
  ROUTING_WORKER_NAME?: string;
  /** Optional. Zone Email Routing Rules:Edit. When unset, inboxes are created without a rule. */
  CF_ROUTING_TOKEN?: string;
    /** AES key for webhook secrets, and the CSRF key. Set with wrangler secret put. */
    WEBHOOK_KEY: string;
    /** Set to "test" only by the vitest config. Never set this in production. */
    ENVIRONMENT?: string;
    /** Public JWK. Used only when ENVIRONMENT is "test". */
    ACCESS_TEST_JWK?: string;
    /** Private JWK. Test-only. The Worker never reads it. */
    ACCESS_TEST_PRIVATE_JWK?: string;
    /** When set, localhost requests may skip Access and use this email. */
    DEV_PANEL_EMAIL?: string;
    TEST_MIGRATIONS?: { name: string; queries: string[] }[];
  }
}

interface Env extends Cloudflare.Env {}
