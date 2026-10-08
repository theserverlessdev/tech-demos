export type MemoryKind = "fact" | "decision";

export type MemoryItem = {
  id: string;
  kind: MemoryKind;
  text: string;
  author: string;
  source: string;
  createdAt: number;
};

export type Citation = {
  kind: MemoryKind;
  id: string;
  snippet: string;
  author: string;
  source: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  sources: Citation[];
  createdAt: number;
};

export type OrgView = {
  id: string;
  expiresAt: number;
  wiped: boolean;
  facts: MemoryItem[];
  decisions: MemoryItem[];
  messages: ChatMessage[];
};

export type CreatedOrg = OrgView & {
  sessionToken: string;
  ingestToken: string;
};

export type ChatResult = {
  answer: string;
  sources: Citation[];
  model: string;
  grounded: boolean;
};

export type AppConfig = {
  turnstileSiteKey: string;
  model: string;
  orgTtlHours: string;
  turnstileConfigured: boolean;
};

export type ApiError = {
  error: { code: string; message: string };
};
