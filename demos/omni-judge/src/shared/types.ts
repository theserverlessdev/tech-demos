export type Modality = "image" | "audio" | "video";

export type ChoiceOption = { id: string; label: string };

export type ChoiceQuestion = {
  id: string;
  instructions: string;
  options: ChoiceOption[];
};

export type AnswerBar = { id: string; label: string; probability: number };

export type JudgmentAnswer = {
  id: string;
  instructions: string;
  topId: string;
  topLabel: string;
  confidence: number;
  bars: AnswerBar[];
};

export type CostNote = {
  usd: number | null;
  note: string;
};

export type ChainStep = {
  name: string;
  model: string;
  latencyMs: number;
  cost: CostNote;
};

export type JudgmentResult = {
  answers: JudgmentAnswer[];
  latencyMs: number;
  model: string;
  source: "clef-omni" | "local-stub" | "chain" | "chain-stub";
  cost: CostNote;
  /** Whisper transcript or vision caption. Model text, untrusted. */
  untrustedText: string | null;
  steps: ChainStep[];
};

export type JudgmentView = {
  id: string;
  pairId: string | null;
  kind: "omni" | "compare";
  modality: Modality;
  label: string;
  sampleId: string | null;
  mediaId: string | null;
  status: "pending" | "complete" | "error";
  error: string | null;
  questions: ChoiceQuestion[];
  result: JudgmentResult | null;
  createdAt: number;
  expiresAt: number;
};

export type SessionPayload = {
  siteKey: string | null;
  testWidget: boolean;
  stub: boolean;
  perVisitorHour: number;
  visitorUsed: number;
  networkUsed: number;
  dailyCap: number;
  retentionHours: number;
};

export type SampleId = "voicemail" | "machine" | "gallery" | "package" | "clip";
