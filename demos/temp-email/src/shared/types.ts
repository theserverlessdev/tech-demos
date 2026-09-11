/** Shapes of the /api/v1 responses. The Worker and the browser client both import this file. */

export type InboxSource = "web" | "agent";
export type DeliveryVia = "smtp" | "sample" | "test";

export type InboxInfo = {
  address: string;
  localPart: string;
  domain: string;
  source: InboxSource;
  createdAt: number;
  expiresAt: number;
  messageCount: number;
};

/** Only the create call returns the token. The server keeps a SHA-256 hash of it. */
export type CreatedInbox = InboxInfo & { token: string };

export type AttachmentMeta = {
  filename: string | null;
  mimeType: string;
  disposition: string | null;
  size: number;
  /** R2 object key. Null when the part had no bytes. Never store blobs in D1. */
  r2Key: string | null;
};

export type MessageSummary = {
  id: string;
  seq: number;
  via: DeliveryVia;
  receivedAt: number;
  envelopeFrom: string;
  from: { name: string | null; address: string | null };
  subject: string;
  snippet: string;
  hasHtml: boolean;
  hasText: boolean;
  attachmentCount: number;
  codes: string[];
};

export type MessageFull = MessageSummary & {
  to: string | null;
  text: string | null;
  html: string | null;
  truncated: boolean;
  rawSize: number;
  messageId: string | null;
  date: string | null;
  links: string[];
  attachments: AttachmentMeta[];
};

export type MessageList = { inbox: InboxInfo; messages: MessageSummary[]; cursor: number };
export type WaitResult = { inbox: InboxInfo; messages: MessageFull[]; cursor: number; timedOut: boolean };

export type MxStatus = { live: boolean; records: string[]; checkedAt: number };

export type AppConfig = {
  domain: string;
  webTtlMinutes: number;
  maxTtlMinutes: number;
  maxMessagesPerInbox: number;
  maxMessageBytes: number;
  mx: MxStatus;
  /** Owner-hosted public demo (email.lomvic.com). Self-host sets this false. */
  hosted: boolean;
  mint: {
    enabled: boolean;
    turnstileSiteKey: string | null;
    inboxLimit: number;
    createLimit: number;
  };
};

export type MintedKey = {
  id: string;
  name: string;
  /** Plaintext key. Only the mint response includes this. */
  key: string;
  createdAt: number;
  inboxLimit: number;
  createLimit: number;
};

export type KeyInfo = {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
  inboxLimit: number;
  activeInboxes: number;
  createLimit: number;
  createsInWindow: number;
};

export type ApiError = { error: { code: string; message: string } };
