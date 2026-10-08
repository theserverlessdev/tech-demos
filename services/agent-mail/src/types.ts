export type Role = "admin" | "user";
export type PolicyName = "auto" | "draft" | "reply_only_auto";
export type ListMode = "none" | "allow" | "block";
export type UnknownPolicy = "reject" | "quarantine";
export type StartedBy = "external" | "agent" | "owner";
export type Direction = "inbound" | "outbound";
export type Via = "smtp" | "api" | "panel";
export type DraftStatus = "pending" | "sent" | "rejected";
export type CreatedBy = "agent" | "owner";

export type DraftReason =
  | "policy_draft"
  | "reply_only"
  | "cap_agent"
  | "cap_inbox"
  | "allowlist"
  | "kill_agent"
  | "kill_global"
  | "send_failed";

export type UserRow = {
  id: string;
  email: string;
  role: Role;
  display_name: string | null;
  invited_by: string | null;
  created_at: number;
  disabled: number;
};

export type AgentRow = {
  id: string;
  owner_user_id: string;
  name: string;
  policy: PolicyName;
  daily_send_cap: number;
  kill_switch: number;
  webhook_url: string | null;
  webhook_secret_enc: string | null;
  created_at: number;
};

export type InboxRow = {
  id: string;
  agent_id: string;
  local_part: string;
  display_name: string | null;
  policy_override: PolicyName | null;
  daily_send_cap: number | null;
  list_mode: ListMode;
  allowlist: string;
  blocklist: string;
  status: "active" | "disabled";
  created_at: number;
  routing_rule_id: string | null;
};

export type ApiKeyRow = {
  id: string;
  agent_id: string;
  name: string;
  key_hash: string;
  key_hint: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
};

export type ThreadRow = {
  id: string;
  inbox_id: string;
  subject: string;
  started_by: StartedBy;
  last_message_at: number;
  created_at: number;
};

export type MessageRow = {
  seq: number;
  id: string;
  thread_id: string;
  inbox_id: string;
  direction: Direction;
  via: Via;
  received_at: number;
  envelope_from: string | null;
  from_name: string | null;
  from_address: string | null;
  to_addrs: string;
  cc_addrs: string;
  subject: string;
  snippet: string;
  text_body: string | null;
  html_body: string | null;
  truncated: number;
  raw_size: number;
  raw_r2_key: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  date_header: string | null;
  spam: number;
  attachments: string;
  provider_message_id: string | null;
};

export type DraftRow = {
  id: string;
  agent_id: string;
  inbox_id: string;
  thread_id: string | null;
  reply_to_message_id: string | null;
  to_addrs: string;
  cc_addrs: string;
  subject: string;
  text_body: string | null;
  html_body: string | null;
  original_subject: string;
  original_text: string | null;
  original_html: string | null;
  status: DraftStatus;
  reason: string;
  created_by: CreatedBy;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
  decision_note: string | null;
  sent_message_id: string | null;
};

export type SettingsRow = {
  id: number;
  global_kill: number;
  unknown_policy: UnknownPolicy;
  spam_ttl_days: number;
};

export type QuarantineRow = {
  id: string;
  local_part: string;
  envelope_from: string;
  subject: string | null;
  raw_r2_key: string;
  spam: number;
  received_at: number;
};

export type AuditRow = {
  id: string;
  at: number;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: string;
};

export type AttachmentMeta = {
  filename: string | null;
  mimeType: string;
  disposition: string | null;
  size: number;
  r2Key: string | null;
};

export type Decision =
  | { outcome: "send" }
  | { outcome: "draft"; reason: DraftReason }
  | { outcome: "blocked"; reason: "blocklist" };
