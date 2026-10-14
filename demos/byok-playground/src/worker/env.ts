import type { LIMITS } from "../shared/limits";

export type RateLimitBinding = {
  limit(input: { key: string }): Promise<{ success: boolean }>;
};

/** Bindings from wrangler.jsonc. Secrets are optional on the generated Env. */
export interface DemoEnv {
  AI?: Ai;
  DB: D1Database;
  ASSETS: Fetcher;
  CHAT_LIMIT: RateLimitBinding;
  MODELS_LIMIT: RateLimitBinding;
  COMPARE_LIMIT: RateLimitBinding;
  AI_MODEL: string;
  DAILY_COMPARE_CAP: string;
  IP_COMPARE_CAP: string;
  ENVIRONMENT: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET?: string;
  IP_HASH_SECRET?: string;
}

export type Cap = typeof LIMITS;
