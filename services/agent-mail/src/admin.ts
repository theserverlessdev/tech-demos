import { Hono, type Context } from "hono";
import { attachmentResponse, readJson, type AppEnv } from "./api";
import { resolvePanelUser } from "./access";
import {
  audit,
  canAccessAgent,
  countAdmins,
  getAgent,
  getDraft,
  getInbox,
  getKey,
  getUserById,
  getMessageById,
  getSettings,
  insertAgent,
  insertApiKey,
  insertInbox,
  insertUser,
  listAgents,
  listAudit,
  listDrafts,
  listInboxes,
  listKeys,
  listQuarantine,
  listRecentMessages,
  listUsers,
  revokeKey,
  setUserDisabled,
  setWebhookSecret,
  updateAgent,
  updateInbox,
  updateSettings,
} from "./db";
import { approveDraft, editDraft, rejectDraft } from "./outbound";
import {
  agentPage,
  agentsPage,
  auditPage,
  draftPage,
  draftsPage,
  mailPage,
  messagePage,
  quarantinePage,
  secretPage,
  settingsPage,
  usersPage,
} from "./panel";
import type { AgentRow, InboxRow, ListMode, PolicyName, UserRow } from "./types";
import {
  DEFAULT_AGENT_CAP,
  HttpError,
  MAX_NAME,
  base64Url,
  checkLocalPart,
  csrfToken,
  encryptString,
  keyHint,
  newApiKey,
  newId,
  normalizeEmail,
  normalizeRecipients,
  sha256Hex,
  splitList,
} from "./util";

export const admin = new Hono<AppEnv>();

admin.use("/admin", loadUser);
admin.use("/admin/*", loadUser);

admin.get("/admin", (c) => c.redirect("/admin/mail", 302));

admin.get("/admin/mail", async (c) => {
  const user = c.get("user")!;
  const messages = await listRecentMessages(c.env.DB, user, 40);
  return c.html(mailPage(user, "/admin/mail", notice(c), messages, c.env.MAIL_DOMAIN));
});

admin.get("/admin/mail/:id", async (c) => {
  const message = await messageFor(c);
  return c.html(messagePage(c.get("user")!, message, c.env.MAIL_DOMAIN));
});

admin.get("/admin/mail/:id/raw", async (c) => {
  const message = await messageFor(c);
  if (!message.raw_r2_key) throw new HttpError(404, "not_found", "No raw file is stored for this message.");
  const object = await c.env.MAIL_BUCKET.get(message.raw_r2_key);
  if (!object) throw new HttpError(404, "not_found", "The file is gone.");
  return new Response(object.body, { headers: { "content-type": "message/rfc822", "content-disposition": 'attachment; filename="message.eml"' } });
});

admin.get("/admin/mail/:id/attachments/:index", async (c) => attachmentResponse(c.env, await messageFor(c), c.req.param("index")));

admin.get("/admin/drafts", async (c) => {
  const user = c.get("user")!;
  const status = new URL(c.req.url).searchParams.get("status");
  return c.html(draftsPage(user, await listDrafts(c.env.DB, user, status), notice(c)));
});

admin.get("/admin/drafts/:id", async (c) => {
  const user = c.get("user")!;
  const draft = await ownedDraft(c);
  return c.html(draftPage(user, draft, await csrfToken(c.env, user.id), notice(c)));
});

admin.post("/admin/drafts/:id/approve", async (c) => {
  const user = c.get("user")!;
  await formGuard(c, user);
  const result = await approveDraft(c.env, user, c.req.param("id"));
  return finish(c, result, "/admin/drafts?notice=Sent");
});

admin.post("/admin/drafts/:id/reject", async (c) => {
  const user = c.get("user")!;
  const body = await formGuard(c, user);
  const draft = await rejectDraft(c.env, user, c.req.param("id"), str(body.note));
  return finish(c, { id: draft.id, status: draft.status }, `/admin/drafts/${draft.id}?notice=Rejected`);
});

admin.post("/admin/drafts/:id/edit", async (c) => {
  const user = c.get("user")!;
  const body = await formGuard(c, user);
  const draft = await editDraft(c.env, user, c.req.param("id"), {
    to: normalizeRecipients(splitList(str(body.to) ?? "")),
    cc: normalizeRecipients(splitList(str(body.cc) ?? "")),
    subject: str(body.subject) ?? "",
    text: str(body.text),
    html: str(body.html),
  });
  return finish(c, { id: draft.id, status: draft.status }, `/admin/drafts/${draft.id}?notice=Saved`);
});

admin.get("/admin/agents", async (c) => {
  const user = c.get("user")!;
  return c.html(agentsPage(user, await listAgents(c.env.DB, user), await csrfToken(c.env, user.id), notice(c)));
});

admin.post("/admin/agents", async (c) => {
  const user = c.get("user")!;
  const body = await formGuard(c, user);
  const name = cleanName(str(body.name) ?? "");
  const agent = await insertAgent(c.env.DB, {
    id: newId(),
    owner_user_id: user.id,
    name,
    policy: policyOf(body.policy, "draft"),
    daily_send_cap: intField(body.dailySendCap ?? DEFAULT_AGENT_CAP, "dailySendCap", 0, 10000),
    created_at: Date.now(),
  });
  await audit(c.env.DB, { actor_type: "user", actor_id: user.id, action: "agent.created", target_type: "agent", target_id: agent.id, detail: { name } });
  return finish(c, { id: agent.id }, `/admin/agents/${agent.id}?notice=Agent+created`);
});

admin.get("/admin/agents/:id", async (c) => {
  const user = c.get("user")!;
  const agent = await ownedAgent(c);
  const [inboxes, keys] = await Promise.all([listInboxes(c.env.DB, agent.id), listKeys(c.env.DB, agent.id)]);
  return c.html(agentPage(user, agent, inboxes, keys, c.env.MAIL_DOMAIN, await csrfToken(c.env, user.id), notice(c)));
});

admin.post("/admin/agents/:id", async (c) => {
  const user = c.get("user")!;
  const agent = await ownedAgent(c);
  const body = await formGuard(c, user);
  const name = cleanName(str(body.name) ?? agent.name);
  const webhookUrl = cleanWebhook(str(body.webhookUrl));
  await updateAgent(c.env.DB, agent.id, {
    name,
    policy: policyOf(body.policy, agent.policy),
    daily_send_cap: intField(body.dailySendCap ?? agent.daily_send_cap, "dailySendCap", 0, 10000),
    kill_switch: flag(body.kill) ? 1 : 0,
    webhook_url: webhookUrl,
  });
  await audit(c.env.DB, { actor_type: "user", actor_id: user.id, action: "agent.updated", target_type: "agent", target_id: agent.id, detail: { kill: flag(body.kill) } });
  return finish(c, { id: agent.id }, `/admin/agents/${agent.id}?notice=Saved`);
});

admin.post("/admin/agents/:id/keys", async (c) => {
  const user = c.get("user")!;
  const agent = await ownedAgent(c);
  const body = await formGuard(c, user);
  const minted = await mint(c.env, user, agent, cleanName(str(body.name) ?? "key"));
  return reveal(c, user, "API key", minted.key, `/admin/agents/${agent.id}`, minted);
});

admin.post("/admin/agents/:id/keys/:keyId/revoke", async (c) => {
  const user = c.get("user")!;
  const agent = await ownedAgent(c);
  await formGuard(c, user);
  const key = await getKey(c.env.DB, c.req.param("keyId"));
  if (!key || key.agent_id !== agent.id) throw new HttpError(404, "not_found", "No key has this id.");
  await revokeKey(c.env.DB, key.id, Date.now());
  await audit(c.env.DB, { actor_type: "user", actor_id: user.id, action: "key.revoked", target_type: "api_key", target_id: key.id, detail: {} });
  return finish(c, { revoked: true }, `/admin/agents/${agent.id}?notice=Key+revoked`);
});

admin.post("/admin/agents/:id/keys/:keyId/rotate", async (c) => {
  const user = c.get("user")!;
  const agent = await ownedAgent(c);
  await formGuard(c, user);
  const key = await getKey(c.env.DB, c.req.param("keyId"));
  if (!key || key.agent_id !== agent.id) throw new HttpError(404, "not_found", "No key has this id.");
  await revokeKey(c.env.DB, key.id, Date.now());
  const minted = await mint(c.env, user, agent, key.name);
  await audit(c.env.DB, { actor_type: "user", actor_id: user.id, action: "key.rotated", target_type: "api_key", target_id: key.id, detail: { newKeyId: minted.id } });
  return reveal(c, user, "Rotated API key", minted.key, `/admin/agents/${agent.id}`, minted);
});

admin.post("/admin/agents/:id/webhook", async (c) => {
  const user = c.get("user")!;
  const agent = await ownedAgent(c);
  await formGuard(c, user);
  if (!c.env.WEBHOOK_KEY) throw new HttpError(500, "misconfigured", "WEBHOOK_KEY is not set.");
  const secret = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const url = agent.webhook_url;
  await setWebhookSecret(c.env.DB, agent.id, await encryptString(c.env.WEBHOOK_KEY, secret), url);
  await audit(c.env.DB, { actor_type: "user", actor_id: user.id, action: "webhook.rotated", target_type: "agent", target_id: agent.id, detail: {} });
  return reveal(c, user, "Webhook secret", secret, `/admin/agents/${agent.id}`, { secret });
});

admin.post("/admin/agents/:id/inboxes", async (c) => {
  const user = c.get("user")!;
  const agent = await ownedAgent(c);
  const body = await formGuard(c, user);
  const localPart = (str(body.localPart) ?? "").trim().toLowerCase();
  const problem = checkLocalPart(localPart);
  if (problem) throw new HttpError(400, "bad_request", problem);
  let inbox: InboxRow;
  try {
    inbox = await insertInbox(c.env.DB, {
      id: newId(),
      agent_id: agent.id,
      local_part: localPart,
      display_name: str(body.displayName),
      policy_override: body.policy ? policyOf(body.policy, "draft") : null,
      daily_send_cap: optionalCap(body.dailySendCap),
      created_at: Date.now(),
    });
  } catch (err) {
    if (String(err).includes("UNIQUE")) throw new HttpError(409, "taken", "That address is already used.");
    throw err;
  }
  await audit(c.env.DB, { actor_type: "user", actor_id: user.id, action: "inbox.created", target_type: "inbox", target_id: inbox.id, detail: { localPart } });
  return finish(c, { id: inbox.id, address: `${localPart}@${c.env.MAIL_DOMAIN}` }, `/admin/agents/${agent.id}?notice=Inbox+created`);
});

admin.post("/admin/inboxes/:id", async (c) => {
  const user = c.get("user")!;
  const inbox = await ownedInbox(c);
  const body = await formGuard(c, user);
  const allowlist = splitList(str(body.allowlist) ?? "").slice(0, 100);
  const blocklist = splitList(str(body.blocklist) ?? "").slice(0, 100);
  const listRaw = str(body.listMode);
  const listMode: ListMode = listRaw === "allow" || listRaw === "block" ? listRaw : "none";
  const status = str(body.status) === "disabled" ? "disabled" : "active";
  await updateInbox(c.env.DB, inbox.id, {
    display_name: str(body.displayName),
    policy_override: body.policy ? policyOf(body.policy, "draft") : null,
    daily_send_cap: optionalCap(body.dailySendCap),
    list_mode: listMode,
    allowlist: JSON.stringify(allowlist),
    blocklist: JSON.stringify(blocklist),
    status,
  });
  await audit(c.env.DB, { actor_type: "user", actor_id: user.id, action: "inbox.updated", target_type: "inbox", target_id: inbox.id, detail: { listMode, status } });
  return finish(c, { id: inbox.id }, `/admin/agents/${inbox.agent_id}?notice=Inbox+saved`);
});

admin.get("/admin/users", async (c) => {
  const user = requireAdmin(c.get("user")!);
  return c.html(usersPage(user, await listUsers(c.env.DB), await csrfToken(c.env, user.id), notice(c)));
});

admin.post("/admin/users", async (c) => {
  const user = requireAdmin(c.get("user")!);
  const body = await formGuard(c, user);
  const email = normalizeEmail(str(body.email) ?? "");
  if (!email) throw new HttpError(400, "bad_request", "Enter a valid email address.");
  const role = str(body.role) === "admin" ? "admin" : "user";
  try {
    const created = await insertUser(c.env.DB, {
      id: newId(),
      email,
      role,
      display_name: null,
      invited_by: user.id,
      created_at: Date.now(),
    });
    await audit(c.env.DB, { actor_type: "user", actor_id: user.id, action: "user.invited", target_type: "user", target_id: created.id, detail: { email, role } });
    return finish(c, { id: created.id, email, role }, "/admin/users?notice=Invited");
  } catch (err) {
    if (String(err).includes("UNIQUE")) throw new HttpError(409, "taken", "That email is already invited.");
    throw err;
  }
});

admin.post("/admin/users/:id/disable", async (c) => {
  const user = requireAdmin(c.get("user")!);
  await formGuard(c, user);
  const target = await getUserById(c.env.DB, c.req.param("id"));
  if (!target) throw new HttpError(404, "not_found", "No user has this id.");
  if (target.id === user.id) throw new HttpError(400, "bad_request", "You cannot disable your own user.");
  if (target.role === "admin" && (await countAdmins(c.env.DB)) <= 1) {
    throw new HttpError(400, "bad_request", "Keep at least one admin.");
  }
  await setUserDisabled(c.env.DB, target.id, 1);
  await audit(c.env.DB, { actor_type: "user", actor_id: user.id, action: "user.disabled", target_type: "user", target_id: target.id, detail: {} });
  return finish(c, { disabled: true }, "/admin/users?notice=Disabled");
});

admin.get("/admin/audit", async (c) => c.html(auditPage(c.get("user")!, await listAudit(c.env.DB, 100))));

admin.get("/admin/settings", async (c) => {
  const user = requireAdmin(c.get("user")!);
  return c.html(settingsPage(user, await getSettings(c.env.DB), await csrfToken(c.env, user.id), notice(c)));
});

admin.post("/admin/settings", async (c) => {
  const user = requireAdmin(c.get("user")!);
  const body = await formGuard(c, user);
  const unknown = str(body.unknownPolicy) === "quarantine" ? "quarantine" : "reject";
  await updateSettings(c.env.DB, {
    global_kill: flag(body.globalKill) ? 1 : 0,
    unknown_policy: unknown,
    spam_ttl_days: intField(body.spamTtlDays ?? 30, "spamTtlDays", 1, 365),
  });
  await audit(c.env.DB, { actor_type: "user", actor_id: user.id, action: "settings.updated", detail: { globalKill: flag(body.globalKill), unknown } });
  return finish(c, { ok: true }, "/admin/settings?notice=Saved");
});

admin.get("/admin/quarantine", async (c) => {
  requireAdmin(c.get("user")!);
  return c.html(quarantinePage(c.get("user")!, await listQuarantine(c.env.DB, 100)));
});

async function loadUser(c: { req: { raw: Request }; env: Env; set: (key: "user", value: UserRow) => void }, next: () => Promise<void>): Promise<void> {
  c.set("user", await resolvePanelUser(c.req.raw, c.env));
  await next();
}

function requireAdmin(user: UserRow): UserRow {
  if (user.role !== "admin") throw new HttpError(403, "forbidden", "Only an admin can do this.");
  return user;
}

async function ownedAgent(c: { req: { param: (name: string) => string }; env: Env; get: (key: "user") => UserRow | undefined }): Promise<AgentRow> {
  const user = c.get("user")!;
  const agent = await getAgent(c.env.DB, c.req.param("id"));
  if (!agent || !canAccessAgent(user, agent)) throw new HttpError(404, "not_found", "No agent has this id.");
  return agent;
}

async function ownedInbox(c: { req: { param: (name: string) => string }; env: Env; get: (key: "user") => UserRow | undefined }): Promise<InboxRow> {
  const user = c.get("user")!;
  const inbox = await getInbox(c.env.DB, c.req.param("id"));
  if (!inbox) throw new HttpError(404, "not_found", "No inbox has this id.");
  const agent = await getAgent(c.env.DB, inbox.agent_id);
  if (!agent || !canAccessAgent(user, agent)) throw new HttpError(404, "not_found", "No inbox has this id.");
  return inbox;
}

async function ownedDraft(c: { req: { param: (name: string) => string }; env: Env; get: (key: "user") => UserRow | undefined }) {
  const user = c.get("user")!;
  const draft = await getDraft(c.env.DB, c.req.param("id"));
  if (!draft) throw new HttpError(404, "not_found", "No draft has this id.");
  const agent = await getAgent(c.env.DB, draft.agent_id);
  if (!agent || !canAccessAgent(user, agent)) throw new HttpError(404, "not_found", "No draft has this id.");
  return draft;
}

async function messageFor(c: { req: { param: (name: string) => string }; env: Env; get: (key: "user") => UserRow | undefined }) {
  const user = c.get("user")!;
  const message = await getMessageById(c.env.DB, c.req.param("id"));
  if (!message) throw new HttpError(404, "not_found", "No message has this id.");
  const inbox = await getInbox(c.env.DB, message.inbox_id);
  const agent = inbox ? await getAgent(c.env.DB, inbox.agent_id) : null;
  if (!inbox || !agent || !canAccessAgent(user, agent)) throw new HttpError(404, "not_found", "No message has this id.");
  return message;
}

async function mint(env: Env, user: UserRow, agent: AgentRow, name: string) {
  const key = newApiKey();
  const row = await insertApiKey(env.DB, {
    id: newId(),
    agent_id: agent.id,
    name,
    key_hash: await sha256Hex(key),
    key_hint: keyHint(key),
    created_at: Date.now(),
  });
  await audit(env.DB, { actor_type: "user", actor_id: user.id, action: "key.minted", target_type: "api_key", target_id: row.id, detail: { hint: row.key_hint } });
  return { id: row.id, name: row.name, hint: row.key_hint, key, createdAt: row.created_at };
}

async function formGuard(c: { req: { raw: Request; header: (name: string) => string | undefined }; env: Env }, user: UserRow): Promise<Record<string, unknown>> {
  const data = await readBody(c);
  if (!wantsJson(c)) {
    const expected = await csrfToken(c.env, user.id);
    if (data.csrf !== expected) throw new HttpError(403, "csrf", "The form expired. Reload the page.");
  }
  return data;
}

async function readBody(c: { req: { raw: Request; header: (name: string) => string | undefined } }): Promise<Record<string, unknown>> {
  if ((c.req.header("content-type") ?? "").includes("application/json")) return readJson(c.req.raw);
  const form = await c.req.raw.formData();
  const out: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function wantsJson(c: { req: { header: (name: string) => string | undefined } }): boolean {
  const type = c.req.header("content-type") ?? "";
  const accept = c.req.header("accept") ?? "";
  return type.includes("application/json") || accept.includes("application/json");
}

function finish(c: Context<AppEnv>, body: unknown, location: string): Response {
  if (wantsJson(c)) return c.json(body);
  return c.redirect(location, 303);
}

function reveal(c: Context<AppEnv>, user: UserRow, title: string, secret: string, back: string, jsonBody: unknown): Response {
  if (wantsJson(c)) return c.json(jsonBody, 201);
  return c.html(secretPage(user, title, secret, back));
}

function notice(c: { req: { url: string } }): string | undefined {
  return new URL(c.req.url).searchParams.get("notice") ?? undefined;
}

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function flag(value: unknown): boolean {
  return value === true || value === "on" || value === "true" || value === "1";
}

function intField(value: unknown, name: string, min: number, max: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new HttpError(400, "bad_request", `${name} must be an integer from ${min} to ${max}.`);
  }
  return number;
}

function optionalCap(value: unknown): number | null {
  if (value == null || value === "") return null;
  return intField(value, "dailySendCap", 0, 10000);
}

function policyOf(value: unknown, fallback: PolicyName): PolicyName {
  if (value === "auto" || value === "draft" || value === "reply_only_auto") return value;
  if (value == null || value === "") return fallback;
  throw new HttpError(400, "bad_request", "Policy must be auto, draft, or reply_only_auto.");
}

function cleanName(value: string): string {
  const name = value.trim();
  if (!name || name.length > MAX_NAME) throw new HttpError(400, "bad_request", `Use a name of 1 to ${MAX_NAME} characters.`);
  return name;
}

function cleanWebhook(value: string | null): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "bad_request", "Webhook URL is not valid.");
  }
  if (url.protocol !== "https:") throw new HttpError(400, "bad_request", "Webhook URL must use https.");
  return url.toString();
}
