export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ASSETS: Fetcher;
  AI_SEARCH: {
    get: (name: string) => {
      search: (params: { query: string }) => Promise<unknown>;
      chatCompletions: (params: {
        messages: { role: string; content: string }[];
        stream: true;
      }) => Promise<Response | ReadableStream>;
    };
  };
  ASK_CAP: DurableObjectNamespace;
  ASK_LIMIT: RateLimitBinding;
  SEARCH_LIMIT: RateLimitBinding;
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  DEV?: string;
  AI_SEARCH_INSTANCE?: string;
}
