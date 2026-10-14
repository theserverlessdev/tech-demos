export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type CapabilityName = "streaming" | "tools" | "json_schema" | "vision";
export type CapabilityStatus = "pass" | "fail" | "unsupported";

export type CapabilityResult = {
  name: CapabilityName;
  status: CapabilityStatus;
  detail: string;
  raw: string;
  latencyMs: number;
};

export type SideMetrics = {
  side: "yours" | "ours";
  source: string;
  latencyMs: number;
  ttftMs: number | null;
  tokens: number | null;
  text: string;
  error: string | null;
};

export type PublicConfig = {
  ok: true;
  model: string;
  ai: "ready" | "stub" | "off";
  siteKey: string | null;
  testSiteKey: boolean;
  budget: { dailyCap: number; used: number; remaining: number };
  limits: {
    maxTokensMax: number;
    compareMaxTokens: number;
    requestBytes: number;
    timeoutMs: number;
  };
};
