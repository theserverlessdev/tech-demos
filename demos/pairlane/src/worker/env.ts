import type { CreateCap } from "./cap-do";
import type { PairRoom } from "./room";

export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ASSETS: Fetcher;
  ROOM: DurableObjectNamespace<PairRoom>;
  CREATE_CAP: DurableObjectNamespace<CreateCap>;
  CREATE_LIMIT: RateLimitBinding;
  CONNECT_LIMIT: RateLimitBinding;
  READ_LIMIT: RateLimitBinding;
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_LOCAL?: string;
  TURN_URLS?: string;
  TURN_USERNAME?: string;
  TURN_CREDENTIAL?: string;
}
