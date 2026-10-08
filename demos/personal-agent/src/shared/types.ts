export type RecallHit = {
  id: string;
  title: string;
  score: number;
};

export type ThreadMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  recalled: RecallHit[];
  createdAt: number;
};

export type NoteSummary = {
  id: string;
  title: string;
  createdAt: number;
};

export type NoteDetail = NoteSummary & {
  body: string;
};

export type SessionInfo = {
  expiresAt: number;
  noteCount: number;
  messageCount: number;
  ttlHours: number;
};

export type ChatReply = {
  reply: string;
  recalled: RecallHit[];
  source: "workers-ai" | "fallback";
  savedNote: NoteSummary | null;
};

export type ResearchCitation = {
  url: string;
  title: string;
  ok: boolean;
  error?: string;
};

export type ResearchReply = {
  summary: string;
  source: "workers-ai" | "fallback";
  citations: ResearchCitation[];
};

export type ConfigResponse = {
  siteKey: string;
  ttlHours: number;
  model: string;
  embedModel: string;
  allowlist: readonly string[];
};

export type HealthResponse = {
  ok: true;
  model: string;
  embedModel: string;
  turnstile: "configured" | "missing";
};
