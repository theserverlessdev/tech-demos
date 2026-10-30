export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface LakeBucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, value: Uint8Array | ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

export interface Env {
  ASSETS: Fetcher;
  LAKE: LakeBucket;
  CATALOG_REGISTRY: DurableObjectNamespace;
  CATALOGS: DurableObjectNamespace;
  QUERY_LIMIT: RateLimitBinding;
  TOKEN_LIMIT: RateLimitBinding;
  READ_LIMIT: RateLimitBinding;
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  QUACK_JWT_SECRET?: string;
  CONNECTION_SIGNING_SECRET?: string;
  DEV?: string;
  LAKE_BUCKET?: string;
  DAILY_QUERY_CAP?: string;
  TOKEN_TTL_SECONDS?: string;
}
