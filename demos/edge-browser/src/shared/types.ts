import type { StepName } from "./limits";

export type StepStatus = "pending" | "running" | "done" | "error";

export type CaptureStep = {
  name: StepName;
  status: StepStatus;
  at: number | null;
};

export type CaptureStatus = "queued" | "running" | "complete" | "error";

export type BrowserMode = "" | "connect" | "launch" | "stub";

export type SummarySource = "" | "workers-ai" | "excerpt";

export type CaptureListItem = {
  id: string;
  url: string;
  title: string;
  status: CaptureStatus;
  createdAt: number;
  expiresAt: number;
};

export type CaptureView = {
  id: string;
  url: string;
  finalUrl: string;
  title: string;
  status: CaptureStatus;
  steps: CaptureStep[];
  error: string | null;
  browserMode: BrowserMode;
  sessionId: string;
  sessionNote: string;
  summarySource: SummarySource;
  summary: string | null;
  markdown: string | null;
  hasDesktop: boolean;
  hasPhone: boolean;
  hasPdf: boolean;
  createdAt: number;
  expiresAt: number;
};

export type SessionPayload = {
  siteKey: string | null;
  capturesPerHour: number;
  capturesUsed: number;
  networkUsed: number;
  dailyCap: number;
  retentionHours: number;
};

export type CaptureParams = {
  captureId: string;
  visitorId: string;
};
