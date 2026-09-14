export type TicketStatus = "open" | "pending" | "resolved";
export type TicketPriority = "low" | "normal" | "high" | "urgent";
export type AuthorKind = "customer" | "agent";
export type MessageVia = "seed" | "queue" | "agent" | "web";

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
  fromName: string;
  fromEmail: string;
  subject: string;
  body: string;
  ticketId?: string;
};

export type DraftResult = {
  draft: string;
  model: string;
};

export type Health = {
  ok: true;
  model: string;
  tickets: number;
};
