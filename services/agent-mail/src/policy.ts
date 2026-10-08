import type { Decision, DraftReason, InboxRow, ListMode, PolicyName } from "./types";
import { listMatches, parseJson } from "./util";

export function effectivePolicy(inbox: InboxRow, agentPolicy: PolicyName): PolicyName {
  return inbox.policy_override ?? agentPolicy;
}

export type PolicyInput = {
  policy: "auto" | "draft" | "reply_only_auto";
  globalKill: boolean;
  agentKill: boolean;
  agentCap: number;
  agentSent: number;
  inboxCap: number | null;
  inboxSent: number;
  listMode: ListMode;
  allowlist: string[];
  blocklist: string[];
  recipients: string[];
  isReply: boolean;
  threadStartedByExternal: boolean;
};

export function decide(input: PolicyInput): Decision {
  if (input.recipients.some((email) => listMatches(input.blocklist, email))) {
    return { outcome: "blocked", reason: "blocklist" };
  }
  const held = holdReason(input);
  if (held) return { outcome: "draft", reason: held };
  if (input.policy === "draft") return { outcome: "draft", reason: "policy_draft" };
  if (input.policy === "reply_only_auto" && !(input.isReply && input.threadStartedByExternal)) {
    return { outcome: "draft", reason: "reply_only" };
  }
  return { outcome: "send" };
}

function holdReason(input: PolicyInput): DraftReason | null {
  if (input.globalKill) return "kill_global";
  if (input.agentKill) return "kill_agent";
  if (input.agentCap <= 0 || input.agentSent >= input.agentCap) return "cap_agent";
  if (input.inboxCap != null && (input.inboxCap <= 0 || input.inboxSent >= input.inboxCap)) return "cap_inbox";
  if (input.listMode === "allow" && input.recipients.some((email) => !listMatches(input.allowlist, email))) {
    return "allowlist";
  }
  return null;
}

export function inboxLists(inbox: InboxRow): { allowlist: string[]; blocklist: string[] } {
  return {
    allowlist: parseJson<string[]>(inbox.allowlist, []),
    blocklist: parseJson<string[]>(inbox.blocklist, []),
  };
}
