declare global {
  interface DurableObjectState {
    exports: Record<string, unknown>;
  }

  interface Env {
    ASSETS: Fetcher;
    LOADER: WorkerLoader;
    AI: Ai;
    WORKSPACES: DurableObjectNamespace;
    METER: DurableObjectNamespace;
    AGENT_LIMIT: RateLimit;
    CODE_LIMIT: RateLimit;
    AI_MODEL: string;
    AI_DAILY_BUDGET_USD: string;
    DYNAMIC_WORKER_DAILY_CAP: string;
  }
}

export {};
