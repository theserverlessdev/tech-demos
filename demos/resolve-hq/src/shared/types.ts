export type TicketStatus = "open" | "pending" | "resolved";
export type TicketPriority = "low" | "normal" | "high" | "urgent";
export type AuthorKind = "customer" | "agent";
export type MessageVia = "seed" | "queue" | "agent" | "web";
export type DraftSource = "workers-ai" | "fallback";
export type SessionGate = "turnstile" | "local" | "off";
export type AiStatus = "ready" | "stub" | "off";
export type TurnstileAction = "session" | "draft" | "write";

export type TicketSummary = {
  id: string;
  number: number;
  subject: string;
  customerName: string;
  customerEmail: string;
  status: TicketStatus;
  priority: TicketPriority;
  assignee: string | null;
  createdAt: number;
  updatedAt: number;
  lastPreview: string;
  lastVia: MessageVia | null;
  messageCount: number;
  sandbox: boolean;
};

export type Message = {
  id: string;
  ticketId: string;
  authorKind: AuthorKind;
  authorName: string;
  authorEmail: string | null;
  body: string;
  via: MessageVia;
  createdAt: number;
};

export type Attachment = {
  id: string;
  ticketId: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: number;
};

export type TicketDetail = TicketSummary & {
  messages: Message[];
  attachments: Attachment[];
};

export type InboundMail = {
  ticketId: string;
  messageId: string;
  visitorId: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  body: string;
};

export type DraftResult = {
  draft: string;
  model: string;
  source: DraftSource;
  finishReason: string | null;
};

export type Health = {
  ok: true;
  model: string;
  tickets: number;
  mailMode: string;
  session: SessionGate;
  siteKey: string | null;
  testSiteKey: boolean;
  ai: AiStatus;
  budget: { dailyCap: number; used: number; remaining: number };
};
