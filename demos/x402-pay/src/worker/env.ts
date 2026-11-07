import type { PayAgent } from "./agent";
import type { PayMCP } from "./mcp";

export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  AI: {
    run(
      model: string,
      input: { messages: { role: string; content: string }[]; max_tokens: number },
    ): Promise<unknown>;
  };
  PAY_MCP: DurableObjectNamespace<PayMCP>;
  PAY_AGENT: DurableObjectNamespace<PayAgent>;
  SESSION_LIMIT: RateLimitBinding;
  CALL_LIMIT: RateLimitBinding;
  CONFIRM_LIMIT: RateLimitBinding;
  READ_LIMIT: RateLimitBinding;
  AI_MODEL: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  LOCAL_DEV?: string;
  X402_MODE?: string;
  MOCK_FACILITATOR_ORIGIN?: string;
  X402_PAYEE_ADDRESS?: string;
  X402_CLIENT_PRIVATE_KEY?: string;
}
