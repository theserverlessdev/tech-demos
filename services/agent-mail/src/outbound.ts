import {
  audit,
  canAccessAgent,
  getAgent,
  getCount,
  getDraft,
  getInbox,
  getMessage,
  getMessageById,
  getSettings,
  getThread,
  insertDraft,
  insertMessage,
  insertThread,
  latestMessage,
  listThreadMessageIds,
  markDraft,
  releaseCount,
  touchThread,
  tryConsume,
  updateDraftContent,
} from "./db";
import { decide, effectivePolicy, inboxLists } from "./policy";
import type { AgentRow, CreatedBy, DraftReason, DraftRow, InboxRow, MessageRow, ThreadRow, UserRow, Via } from "./types";
import {
  HttpError,
  MAX_HTML_CHARS,
  MAX_RECIPIENTS,
  MAX_TEXT_CHARS,
  buildReferences,
  capText,
  formatMessageId,
  htmlToText,
  newId,
  originOf,
  parseJson,
  listMatches,
  snippetOf,
  utcDay,
} from "./util";

export type SendBody = {
  to: string[];
  cc: string[];
  subject: string;
  text: string | null;
  html: string | null;
  thread: ThreadRow | null;
  replyTo: MessageRow | null;
};

export type SendResult =
  | { outcome: "sent"; messageId: string; providerMessageId: string | null; threadId: string; draftId: string | null }
  | { outcome: "drafted"; draftId: string; status: "pending"; reason: DraftReason; threadId: string | null; statusUrl: string };

type Actor = { type: "agent" | "user"; id: string };

export async function requestSend(
  env: Env,
  input: {
    inbox: InboxRow;
    agent: AgentRow;
    actor: Actor;
    createdBy: CreatedBy;
    via: Via;
    body: SendBody;
  },
): Promise<SendResult> {
  assertInbox(input.inbox, input.agent);
  const recipients = recipientsOf(input.body);
  const decision = await evaluate(env, input.inbox, input.agent, recipients, input.body.thread);
  if (decision.outcome === "blocked") {
    await audit(env.DB, {
      actor_type: input.actor.type,
      actor_id: input.actor.id,
      action: "send.blocked",
      target_type: "inbox",
      target_id: input.inbox.id,
      detail: { reason: "blocklist" },
    });
    throw new HttpError(403, "blocklist", "A recipient is on the block list.");
  }
  if (decision.outcome === "draft") {
    return saveDraft(env, input, decision.reason);
  }
  try {
    return await deliver(env, input, null);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const drafted = await saveDraft(env, input, "send_failed");
    return drafted;
  }
}

export async function approveDraft(env: Env, user: UserRow, draftId: string): Promise<SendResult> {
  const loaded = await loadPending(env, draftId);
  if (!canAccessAgent(user, loaded.agent)) throw new HttpError(404, "not_found", "No pending draft has this id.");
  const settings = await getSettings(env.DB);
  if (settings.global_kill) throw new HttpError(409, "kill_global", "The global kill switch is on. Turn it off, then approve.");
  if (loaded.agent.kill_switch) throw new HttpError(409, "kill_agent", "The agent kill switch is on. Turn it off, then approve.");
  const recipients = [...parseJson<string[]>(loaded.draft.to_addrs, []), ...parseJson<string[]>(loaded.draft.cc_addrs, [])];
  const lists = inboxLists(loaded.inbox);
  if (recipients.some((email) => listMatches(lists.blocklist, email))) {
    throw new HttpError(403, "blocklist", "A recipient is on the block list.");
  }
  const body = bodyFromDraft(loaded.draft, loaded.thread, loaded.replyTo);
  try {
    const sent = await deliver(
      env,
      { inbox: loaded.inbox, agent: loaded.agent, actor: { type: "user", id: user.id }, createdBy: "owner", via: "panel", body },
      loaded.draft.id,
    );
    await audit(env.DB, {
      actor_type: "user",
      actor_id: user.id,
      action: "draft.approved",
      target_type: "draft",
      target_id: loaded.draft.id,
      detail: { messageId: sent.outcome === "sent" ? sent.messageId : null },
    });
    return sent;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    await audit(env.DB, {
      actor_type: "user",
      actor_id: user.id,
      action: "send.failed",
      target_type: "draft",
      target_id: loaded.draft.id,
      detail: {},
    });
    throw new HttpError(502, "send_failed", "The mail provider did not accept the message. The draft is still pending.");
  }
}

export async function editDraft(
  env: Env,
  user: UserRow,
  draftId: string,
  fields: { to: string[]; cc: string[]; subject: string; text: string | null; html: string | null },
): Promise<DraftRow> {
  const loaded = await loadPending(env, draftId);
  if (!canAccessAgent(user, loaded.agent)) throw new HttpError(404, "not_found", "No pending draft has this id.");
  const to = fields.to;
  const cc = fields.cc;
  if (to.length + cc.length === 0 || to.length + cc.length > MAX_RECIPIENTS) {
    throw new HttpError(400, "bad_request", `Use 1 to ${MAX_RECIPIENTS} recipients.`);
  }
  const subject = (fields.subject.trim() || "(no subject)").slice(0, 998);
  await updateDraftContent(env.DB, draftId, {
    to_addrs: JSON.stringify(to),
    cc_addrs: JSON.stringify(cc),
    subject,
    text_body: fields.text,
    html_body: fields.html,
  });
  await audit(env.DB, {
    actor_type: "user",
    actor_id: user.id,
    action: "draft.edited",
    target_type: "draft",
    target_id: draftId,
    detail: { subject },
  });
  const updated = await getDraft(env.DB, draftId);
  if (!updated) throw new HttpError(404, "not_found", "No pending draft has this id.");
  return updated;
}

export async function rejectDraft(env: Env, user: UserRow, draftId: string, note: string | null): Promise<DraftRow> {
  const loaded = await loadPending(env, draftId);
  if (!canAccessAgent(user, loaded.agent)) throw new HttpError(404, "not_found", "No pending draft has this id.");
  const now = Date.now();
  await markDraft(env.DB, draftId, { status: "rejected", decided_at: now, decided_by: user.id, decision_note: note, sent_message_id: null });
  await audit(env.DB, {
    actor_type: "user",
    actor_id: user.id,
    action: "draft.rejected",
    target_type: "draft",
    target_id: draftId,
    detail: { note: note ?? "" },
  });
  const updated = await getDraft(env.DB, draftId);
  if (!updated) throw new HttpError(404, "not_found", "No draft has this id.");
  return updated;
}

async function loadPending(env: Env, draftId: string): Promise<{ draft: DraftRow; inbox: InboxRow; agent: AgentRow; thread: ThreadRow | null; replyTo: MessageRow | null }> {
  const draft = await getDraft(env.DB, draftId);
  if (!draft || draft.status !== "pending") throw new HttpError(404, "not_found", "No pending draft has this id.");
  const inbox = await getInbox(env.DB, draft.inbox_id);
  const agent = await getAgent(env.DB, draft.agent_id);
  if (!inbox || !agent) throw new HttpError(404, "not_found", "No pending draft has this id.");
  const thread = draft.thread_id ? await getThread(env.DB, draft.thread_id) : null;
  const replyTo = draft.reply_to_message_id ? await getMessageById(env.DB, draft.reply_to_message_id) : null;
  return { draft, inbox, agent, thread, replyTo };
}

function bodyFromDraft(draft: DraftRow, thread: ThreadRow | null, replyTo: MessageRow | null): SendBody {
  return {
    to: parseJson<string[]>(draft.to_addrs, []),
    cc: parseJson<string[]>(draft.cc_addrs, []),
    subject: draft.subject,
    text: draft.text_body,
    html: draft.html_body,
    thread,
    replyTo,
  };
}

function recipientsOf(body: SendBody): string[] {
  const all = [...body.to, ...body.cc];
  if (all.length === 0 || all.length > MAX_RECIPIENTS) {
    throw new HttpError(400, "bad_request", `Use 1 to ${MAX_RECIPIENTS} recipients.`);
  }
  if (!body.text && !body.html) throw new HttpError(400, "bad_request", "Add text or HTML.");
  return all;
}

function assertInbox(inbox: InboxRow, agent: AgentRow): void {
  if (inbox.agent_id !== agent.id) throw new HttpError(404, "not_found", "No inbox has this id.");
  if (inbox.status !== "active") throw new HttpError(409, "inbox_disabled", "This inbox is disabled.");
}

async function evaluate(env: Env, inbox: InboxRow, agent: AgentRow, recipients: string[], thread: ThreadRow | null) {
  const settings = await getSettings(env.DB);
  const day = utcDay();
  const lists = inboxLists(inbox);
  return decide({
    policy: effectivePolicy(inbox, agent.policy),
    globalKill: settings.global_kill === 1,
    agentKill: agent.kill_switch === 1,
    agentCap: agent.daily_send_cap,
    agentSent: await getCount(env.DB, `agent:${agent.id}`, day),
    inboxCap: inbox.daily_send_cap,
    inboxSent: inbox.daily_send_cap == null ? 0 : await getCount(env.DB, `inbox:${inbox.id}`, day),
    listMode: inbox.list_mode,
    allowlist: lists.allowlist,
    blocklist: lists.blocklist,
    recipients,
    isReply: thread != null,
    threadStartedByExternal: thread?.started_by === "external",
  });
}

async function saveDraft(
  env: Env,
  input: { inbox: InboxRow; agent: AgentRow; actor: Actor; createdBy: CreatedBy; body: SendBody },
  reason: DraftReason,
): Promise<SendResult> {
  const now = Date.now();
  const subject = (input.body.subject.trim() || "(no subject)").slice(0, 998);
  const draft = await insertDraft(env.DB, {
    id: newId(),
    agent_id: input.agent.id,
    inbox_id: input.inbox.id,
    thread_id: input.body.thread?.id ?? null,
    reply_to_message_id: input.body.replyTo?.id ?? null,
    to_addrs: JSON.stringify(input.body.to),
    cc_addrs: JSON.stringify(input.body.cc),
    subject,
    text_body: input.body.text,
    html_body: input.body.html,
    original_subject: subject,
    original_text: input.body.text,
    original_html: input.body.html,
    reason,
    created_by: input.createdBy,
    created_at: now,
  });
  await audit(env.DB, {
    actor_type: input.actor.type,
    actor_id: input.actor.id,
    action: "send.drafted",
    target_type: "draft",
    target_id: draft.id,
    detail: { reason, inboxId: input.inbox.id },
  });
  return {
    outcome: "drafted",
    draftId: draft.id,
    status: "pending",
    reason,
    threadId: draft.thread_id,
    statusUrl: `${originOf(env)}/v1/drafts/${draft.id}`,
  };
}

async function deliver(
  env: Env,
  input: { inbox: InboxRow; agent: AgentRow; actor: Actor; createdBy: CreatedBy; via: Via; body: SendBody },
  draftId: string | null,
): Promise<SendResult> {
  const day = utcDay();
  const agentScope = `agent:${input.agent.id}`;
  const inboxScope = `inbox:${input.inbox.id}`;
  if (!(await tryConsume(env.DB, agentScope, day, input.agent.daily_send_cap))) {
    throw new HttpError(409, "cap_agent", "The agent reached its daily send cap.");
  }
  const inboxCapped = input.inbox.daily_send_cap != null;
  if (inboxCapped && !(await tryConsume(env.DB, inboxScope, day, input.inbox.daily_send_cap ?? 0))) {
    await releaseCount(env.DB, agentScope, day);
    throw new HttpError(409, "cap_inbox", "The inbox reached its daily send cap.");
  }
  try {
    const headers = await threadingHeaders(env, input.body);
    const fromEmail = `${input.inbox.local_part}@${env.MAIL_DOMAIN}`;
    const text = input.body.text ?? (input.body.html ? htmlToText(input.body.html) : "");
    const result = await env.EMAIL.send({
      from: input.inbox.display_name ? { email: fromEmail, name: input.inbox.display_name } : fromEmail,
      to: input.body.to,
      cc: input.body.cc.length ? input.body.cc : undefined,
      subject: input.body.subject.slice(0, 998),
      text,
      html: input.body.html ?? undefined,
      headers: Object.keys(headers).length ? headers : undefined,
    });
    const now = Date.now();
    let thread = input.body.thread;
    if (!thread) {
      const startedBy = input.createdBy === "owner" ? "owner" : "agent";
      thread = await insertThread(env.DB, {
        id: newId(),
        inbox_id: input.inbox.id,
        subject: input.body.subject.slice(0, 998),
        started_by: startedBy,
        now,
      });
    }
    const providerId = result.messageId ?? null;
    const cappedText = capText(text, MAX_TEXT_CHARS);
    const cappedHtml = capText(input.body.html, MAX_HTML_CHARS);
    const stored = await insertMessage(env.DB, {
      id: newId(),
      thread_id: thread.id,
      inbox_id: input.inbox.id,
      direction: "outbound",
      via: input.via,
      received_at: now,
      envelope_from: fromEmail,
      from_name: input.inbox.display_name,
      from_address: fromEmail,
      to_addrs: JSON.stringify(input.body.to),
      cc_addrs: JSON.stringify(input.body.cc),
      subject: input.body.subject.slice(0, 998),
      snippet: snippetOf(cappedText.value ?? ""),
      text_body: cappedText.value,
      html_body: cappedHtml.value,
      truncated: cappedText.cut || cappedHtml.cut ? 1 : 0,
      raw_size: 0,
      raw_r2_key: null,
      message_id: formatMessageId(providerId) || null,
      in_reply_to: headers["In-Reply-To"] ?? null,
      references_header: headers.References ?? null,
      date_header: new Date(now).toUTCString(),
      spam: 0,
      attachments: "[]",
      provider_message_id: providerId,
    });
    await touchThread(env.DB, thread.id, stored.subject, now);
    if (draftId) {
      await markDraft(env.DB, draftId, {
        status: "sent",
        decided_at: now,
        decided_by: input.actor.type === "user" ? input.actor.id : input.actor.id,
        decision_note: null,
        sent_message_id: stored.id,
      });
    }
    await audit(env.DB, {
      actor_type: input.actor.type,
      actor_id: input.actor.id,
      action: "send.sent",
      target_type: "message",
      target_id: stored.id,
      detail: { inboxId: input.inbox.id, draftId },
    });
    return { outcome: "sent", messageId: stored.id, providerMessageId: providerId, threadId: thread.id, draftId };
  } catch (err) {
    await releaseCount(env.DB, agentScope, day);
    if (inboxCapped) await releaseCount(env.DB, inboxScope, day);
    throw err;
  }
}

async function threadingHeaders(env: Env, body: SendBody): Promise<Record<string, string>> {
  if (!body.thread) return {};
  const ids = await listThreadMessageIds(env.DB, body.thread.id);
  const parent = body.replyTo?.message_id || ids[ids.length - 1] || "";
  const chain = ids.length ? ids : parent ? [parent] : [];
  const headers: Record<string, string> = {};
  const inReplyTo = formatMessageId(parent);
  const references = buildReferences(chain);
  if (inReplyTo) headers["In-Reply-To"] = inReplyTo;
  if (references) headers.References = references;
  return headers;
}

export async function resolveReplyTarget(env: Env, inbox: InboxRow, threadId: string | null, messageId: string | null): Promise<{ thread: ThreadRow | null; replyTo: MessageRow | null }> {
  if (messageId) {
    const message = (await getMessage(env.DB, inbox.id, messageId)) ?? (await findByHeaderId(env, inbox.id, messageId));
    if (!message) throw new HttpError(404, "not_found", "No message has this id.");
    const thread = await getThread(env.DB, message.thread_id);
    if (!thread || thread.inbox_id !== inbox.id) throw new HttpError(404, "not_found", "No message has this id.");
    return { thread, replyTo: message };
  }
  if (threadId) {
    const thread = await getThread(env.DB, threadId);
    if (!thread || thread.inbox_id !== inbox.id) throw new HttpError(404, "not_found", "No thread has this id.");
    const replyTo = await latestMessage(env.DB, thread.id);
    return { thread, replyTo };
  }
  return { thread: null, replyTo: null };
}

async function findByHeaderId(env: Env, inboxId: string, messageId: string): Promise<MessageRow | null> {
  const formatted = formatMessageId(messageId);
  const row = await env.DB
    .prepare("SELECT * FROM messages WHERE inbox_id = ? AND (message_id = ? OR message_id = ?) LIMIT 1")
    .bind(inboxId, formatted, messageId)
    .first<MessageRow>();
  return row;
}
