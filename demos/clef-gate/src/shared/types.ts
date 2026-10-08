export const CLEF_MODELS = ["clef", "clef-flash"] as const;
export type ClefModel = (typeof CLEF_MODELS)[number];

export const GATE_DECISIONS = ["allow", "deny", "ask-human"] as const;
export type GateDecision = (typeof GATE_DECISIONS)[number];

export type Probabilities = Record<GateDecision, number>;

export type GateSource = "clef" | "local-heuristic" | "unavailable";

export type HumanOutcome = "approve" | "deny" | "expired";

export const TURN_LIMIT = 16;

export type GateCard = {
  decisionId: string;
  tool: string;
  argsSummary: string;
  decision: GateDecision;
  probabilities: Probabilities;
  confidence: number;
  latencyMs: number;
  source: GateSource;
  model: string;
  reason: string;
  humanOutcome: HumanOutcome | null;
};

export type TranscriptMessage = {
  id: number;
  role: "user" | "assistant" | "tool" | "gate";
  content: string;
  at: number;
  gate: GateCard | null;
};

export type PendingCall = {
  id: string;
  decisionId: string;
  tool: string;
  argsSummary: string;
  expiresAt: number;
};

export type SessionView = {
  id: string;
  model: ClefModel;
  expiresAt: number;
  turns: number;
  turnLimit: number;
  messages: TranscriptMessage[];
  pending: PendingCall | null;
};

export type AuditRow = {
  id: string;
  tool: string;
  argsSummary: string;
  decision: GateDecision;
  probabilities: Probabilities;
  confidence: number;
  latencyMs: number;
  model: string;
  source: GateSource;
  humanOutcome: HumanOutcome | null;
  createdAt: number;
};

export type PublicConfig = {
  turnstileSiteKey: string;
  testSiteKey: boolean;
  confidenceFloor: number;
  models: { id: ClefModel; label: string }[];
  tools: { name: string; blurb: string }[];
};

export type HealthBody = {
  ok: true;
  chatModel: string;
  clef: string;
  clefFlash: string;
  siteKeyMode: "test" | "custom";
};

export function emptyProbabilities(): Probabilities {
  return { allow: 0, deny: 0, "ask-human": 0 };
}
