export const LIMITS = {
  jsonBytes: 32_000,
  uploadBytes: 1_000_000,
  uploadContentLength: 1_100_000,
  messageBody: 8_000,
  subjectChars: 200,
  fromNameChars: 80,
  fromEmailChars: 254,
  draftSubjectChars: 200,
  draftMessageChars: 1_500,
  draftMessageCount: 4,
  listLimit: 50,
  sessionTtlMs: 12 * 60 * 60 * 1000,
  retainMs: 24 * 60 * 60 * 1000,
  dailyDraftCap: 80,
  ipDraftCap: 8,
  maxTokens: 2_000,
} as const;

export const SESSION_COOKIE = "rhq_session";
export const HUB_BASE_PATH = "/demos/resolve-hq";

export const ALLOWED_UPLOAD_TYPES = ["text/plain", "image/png", "image/jpeg", "application/pdf"] as const;
export type AllowedUploadType = (typeof ALLOWED_UPLOAD_TYPES)[number];

export const FROM_EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,189}$/;
export const TICKET_ID_RE = /^tkt_\w{1,40}$/;
export const ATTACHMENT_ID_RE = /^att_\w{1,40}$/;
