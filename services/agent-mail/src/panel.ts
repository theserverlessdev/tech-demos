import type { AgentRow, ApiKeyRow, AuditRow, DraftRow, InboxRow, MessageRow, QuarantineRow, SettingsRow, UserRow } from "./types";
import { esc, lineDiff, parseAttachments, parseJson, srcdocAttr } from "./util";

const CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #0e0e11; color: #f3efe7; font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; }
a { color: #f3efe7; }
header { display: flex; gap: 1.25rem; align-items: center; padding: 0.85rem 1.25rem; border-bottom: 1px solid #2c2c33; background: #141418; }
.brand { color: #c2410c; font-weight: 700; letter-spacing: 0.04em; text-decoration: none; }
nav { display: flex; gap: 0.9rem; flex-wrap: wrap; }
nav a { color: #9c978f; text-decoration: none; }
nav a.on, nav a:hover { color: #f3efe7; }
main { max-width: 980px; margin: 0 auto; padding: 1.25rem; }
h1 { font-size: 1.35rem; margin: 0 0 0.75rem; }
h2 { font-size: 1rem; margin: 1.25rem 0 0.5rem; }
.card { background: #17171c; border: 1px solid #2c2c33; border-radius: 12px; padding: 1rem; margin: 0 0 1rem; }
.notice { background: #2a160f; border: 1px solid #c2410c; border-radius: 8px; padding: 0.6rem 0.8rem; margin-bottom: 1rem; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 0.45rem 0.4rem; border-bottom: 1px solid #2c2c33; vertical-align: top; }
th { color: #9c978f; font-weight: 600; font-size: 0.78rem; letter-spacing: 0.04em; text-transform: uppercase; }
label { display: block; margin: 0.55rem 0 0.2rem; color: #9c978f; }
input, textarea, select { width: 100%; background: #0e0e11; color: #f3efe7; border: 1px solid #2c2c33; border-radius: 8px; padding: 0.5rem 0.6rem; font: inherit; }
input[type="checkbox"] { width: auto; }
textarea { min-height: 8rem; }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
button, .btn { background: #c2410c; color: white; border: 0; border-radius: 8px; padding: 0.5rem 0.8rem; font: inherit; cursor: pointer; text-decoration: none; display: inline-block; }
.ghost { background: transparent; color: #f3efe7; border: 1px solid #2c2c33; }
.danger { background: #7f1d1d; }
.pill { display: inline-block; border-radius: 999px; padding: 0.05rem 0.5rem; background: #2c2c33; font-size: 0.78rem; }
.pill.warn { background: #7c2d12; }
.muted { color: #9c978f; }
pre, .diff { white-space: pre-wrap; word-break: break-word; font: 13px/1.45 ui-monospace, monospace; }
.diff div.add { color: #86efac; }
.diff div.del { color: #fca5a5; }
.key { font: 13px/1.45 ui-monospace, monospace; background: #0e0e11; padding: 0.8rem; border-radius: 8px; word-break: break-all; }
iframe.mail { width: 100%; min-height: 240px; border: 1px solid #2c2c33; border-radius: 8px; background: white; }
form.inline { display: inline; }
@media (max-width: 700px) { .row { grid-template-columns: 1fr; } header { align-items: flex-start; flex-direction: column; } }
`;

export function layout(opts: { title: string; path: string; user: UserRow; notice?: string; body: string }): string {
  const item = (href: string, label: string) => `<a class="${opts.path.startsWith(href) ? "on" : ""}" href="${href}">${label}</a>`;
  const admin = opts.user.role === "admin" ? `${item("/admin/users", "Users")}${item("/admin/settings", "Settings")}${item("/admin/quarantine", "Quarantine")}` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} — Agent Mail</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <a class="brand" href="/admin">Agent Mail</a>
  <nav>
    ${item("/admin/mail", "Mail")}
    ${item("/admin/drafts", "Drafts")}
    ${item("/admin/agents", "Agents")}
    ${item("/admin/audit", "Audit")}
    ${admin}
  </nav>
  <span class="muted" style="margin-left:auto">${esc(opts.user.email)}</span>
</header>
<main>
  ${opts.notice ? `<div class="notice">${esc(opts.notice)}</div>` : ""}
  ${opts.body}
</main>
</body>
</html>`;
}

export function publicHome(domain: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Mail</title><style>${CSS}</style></head>
<body><main><h1>Agent Mail</h1><p>Invite-only mail for agents on <b>${esc(domain)}</b>.</p><p class="muted">There is no public signup. Owners sign in at <a href="/admin">/admin</a>. Agents use <a href="/v1/openapi.json">/v1</a> with a bearer key.</p></main></body></html>`;
}

export function simplePage(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body><main><h1>${esc(title)}</h1><p>${esc(message)}</p></main></body></html>`;
}

function when(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function mailPage(user: UserRow, path: string, notice: string | undefined, messages: MessageRow[], domain: string): string {
  const rows = messages
    .map(
      (message) => `<tr>
      <td>${when(message.received_at)}</td>
      <td>${esc(message.direction)}</td>
      <td>${esc(message.from_address)}</td>
      <td><a href="/admin/mail/${esc(message.id)}">${esc(message.subject)}</a></td>
      <td class="muted">${esc(message.snippet)}</td>
    </tr>`,
    )
    .join("");
  return layout({
    title: "Mail",
    path,
    user,
    notice,
    body: `<h1>Mail</h1><div class="card"><table><thead><tr><th>When</th><th>Dir</th><th>From</th><th>Subject</th><th>Snippet</th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="muted">No mail yet.</td></tr>`}</tbody></table></div><p class="muted">Addresses use @${esc(domain)}.</p>`,
  });
}

export function messagePage(user: UserRow, message: MessageRow, domain: string): string {
  const attachments = parseAttachments(message.attachments)
    .map((part, index) =>
      part.r2Key
        ? `<li><a href="/admin/mail/${esc(message.id)}/attachments/${index}">${esc(part.filename || "attachment")}</a> <span class="muted">${esc(part.mimeType)} · ${part.size} bytes</span></li>`
        : `<li>${esc(part.filename || "attachment")} <span class="muted">no file</span></li>`,
    )
    .join("");
  const html = message.html_body
    ? `<h2>HTML</h2><iframe class="mail" sandbox srcdoc="${srcdocAttr(message.html_body)}"></iframe>`
    : "";
  const raw = message.raw_r2_key ? `<p><a href="/admin/mail/${esc(message.id)}/raw">Download raw .eml</a></p>` : "";
  return layout({
    title: message.subject,
    path: "/admin/mail",
    user,
    body: `<h1>${esc(message.subject)}</h1>
    <p class="muted">${esc(message.from_address)} → ${esc(parseJson<string[]>(message.to_addrs, []).join(", "))} · ${when(message.received_at)} · ${esc(message.direction)}</p>
    ${raw}
    <div class="card"><pre>${esc(message.text_body || "(no text part)")}</pre></div>
    ${html}
    ${attachments ? `<h2>Attachments</h2><ul>${attachments}</ul>` : ""}
    <p class="muted">Inbox domain @${esc(domain)}</p>`,
  });
}

export function draftsPage(user: UserRow, drafts: DraftRow[], notice?: string): string {
  const rows = drafts
    .map(
      (draft) => `<tr>
      <td>${when(draft.created_at)}</td>
      <td><span class="pill ${draft.status === "pending" ? "warn" : ""}">${esc(draft.status)}</span></td>
      <td>${esc(draft.reason)}</td>
      <td><a href="/admin/drafts/${esc(draft.id)}">${esc(draft.subject)}</a></td>
      <td class="muted">${esc(parseJson<string[]>(draft.to_addrs, []).join(", "))}</td>
    </tr>`,
    )
    .join("");
  return layout({
    title: "Drafts",
    path: "/admin/drafts",
    user,
    notice,
    body: `<h1>Drafts</h1><div class="card"><table><thead><tr><th>When</th><th>Status</th><th>Reason</th><th>Subject</th><th>To</th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="muted">No drafts.</td></tr>`}</tbody></table></div>`,
  });
}

export function draftPage(user: UserRow, draft: DraftRow, csrf: string, notice?: string): string {
  const original = draft.original_text ?? "";
  const current = draft.text_body ?? "";
  const diff = lineDiff(original, current)
    .map((line) => `<div class="${line.op === "+" ? "add" : line.op === "-" ? "del" : "same"}">${esc(`${line.op} ${line.text}`)}</div>`)
    .join("");
  const pending = draft.status === "pending";
  const actions = pending
    ? `<form method="post" action="/admin/drafts/${esc(draft.id)}/approve"><input type="hidden" name="csrf" value="${esc(csrf)}"><button>Approve and send</button></form>
       <form method="post" action="/admin/drafts/${esc(draft.id)}/reject" style="margin-top:0.5rem"><input type="hidden" name="csrf" value="${esc(csrf)}"><label>Reject note</label><input name="note"><button class="danger" style="margin-top:0.5rem">Reject</button></form>`
    : `<p>Decided ${when(draft.decided_at)}. ${draft.sent_message_id ? `Sent as <a href="/admin/mail/${esc(draft.sent_message_id)}">message</a>.` : ""}</p>`;
  const edit = pending
    ? `<h2>Edit</h2><form method="post" action="/admin/drafts/${esc(draft.id)}/edit">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <label>To</label><input name="to" value="${esc(parseJson<string[]>(draft.to_addrs, []).join(", "))}">
      <label>Cc</label><input name="cc" value="${esc(parseJson<string[]>(draft.cc_addrs, []).join(", "))}">
      <label>Subject</label><input name="subject" value="${esc(draft.subject)}">
      <label>Text</label><textarea name="text">${esc(draft.text_body ?? "")}</textarea>
      <label>HTML</label><textarea name="html">${esc(draft.html_body ?? "")}</textarea>
      <button style="margin-top:0.6rem">Save edit</button>
    </form>`
    : "";
  const preview = draft.html_body ? `<h2>HTML preview</h2><iframe class="mail" sandbox srcdoc="${srcdocAttr(draft.html_body)}"></iframe>` : "";
  return layout({
    title: draft.subject,
    path: "/admin/drafts",
    user,
    notice,
    body: `<h1>${esc(draft.subject)}</h1>
    <p><span class="pill warn">${esc(draft.status)}</span> <span class="muted">${esc(draft.reason)}</span></p>
    <div class="card">${actions}</div>
    <h2>Edit diff</h2><div class="card diff">${diff || `<div class="same">No text changes.</div>`}</div>
    ${preview}
    ${edit}`,
  });
}

export function agentsPage(user: UserRow, agents: AgentRow[], csrf: string, notice?: string): string {
  const rows = agents
    .map(
      (agent) => `<tr><td><a href="/admin/agents/${esc(agent.id)}">${esc(agent.name)}</a></td><td>${esc(agent.policy)}</td><td>${agent.daily_send_cap}</td><td>${agent.kill_switch ? "on" : "off"}</td></tr>`,
    )
    .join("");
  return layout({
    title: "Agents",
    path: "/admin/agents",
    user,
    notice,
    body: `<h1>Agents</h1>
    <div class="card"><table><thead><tr><th>Name</th><th>Policy</th><th>Daily cap</th><th>Kill</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="muted">No agents yet.</td></tr>`}</tbody></table></div>
    <div class="card"><h2>New agent</h2>
      <form method="post" action="/admin/agents">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <label>Name</label><input name="name" required>
        <div class="row"><div><label>Policy</label><select name="policy"><option value="draft">draft</option><option value="auto">auto</option><option value="reply_only_auto">reply_only_auto</option></select></div>
        <div><label>Daily send cap</label><input name="dailySendCap" type="number" min="0" value="50"></div></div>
        <button style="margin-top:0.7rem">Create agent</button>
      </form>
    </div>`,
  });
}

export function agentPage(
  user: UserRow,
  agent: AgentRow,
  inboxes: InboxRow[],
  keys: ApiKeyRow[],
  domain: string,
  csrf: string,
  notice?: string,
): string {
  const keyRows = keys
    .map(
      (key) => `<tr><td>${esc(key.name)}</td><td class="muted">${esc(key.key_hint)}</td><td>${when(key.created_at)}</td><td>${key.revoked_at ? "revoked" : "active"}</td><td>
      ${key.revoked_at ? "" : `<form class="inline" method="post" action="/admin/agents/${esc(agent.id)}/keys/${esc(key.id)}/revoke"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="ghost">Revoke</button></form>
      <form class="inline" method="post" action="/admin/agents/${esc(agent.id)}/keys/${esc(key.id)}/rotate"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="ghost">Rotate</button></form>`}
    </td></tr>`,
    )
    .join("");
  const inboxRows = inboxes
    .map(
      (inbox) => `<tr><td>${esc(inbox.local_part)}@${esc(domain)}</td><td>${esc(inbox.policy_override ?? "inherit")}</td><td>${inbox.daily_send_cap ?? "—"}</td><td>${esc(inbox.status)}</td></tr>`,
    )
    .join("");
  return layout({
    title: agent.name,
    path: "/admin/agents",
    user,
    notice,
    body: `<h1>${esc(agent.name)}</h1>
    <div class="card"><form method="post" action="/admin/agents/${esc(agent.id)}">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <label>Name</label><input name="name" value="${esc(agent.name)}">
      <div class="row">
        <div><label>Policy</label><select name="policy">${policyOptions(agent.policy)}</select></div>
        <div><label>Daily send cap</label><input name="dailySendCap" type="number" min="0" value="${agent.daily_send_cap}"></div>
      </div>
      <label><input type="checkbox" name="kill" ${agent.kill_switch ? "checked" : ""}> Kill switch</label>
      <label>Webhook URL</label><input name="webhookUrl" value="${esc(agent.webhook_url ?? "")}" placeholder="https://example.com/hooks/mail">
      <button style="margin-top:0.7rem">Save</button>
    </form>
    <form method="post" action="/admin/agents/${esc(agent.id)}/webhook" style="margin-top:0.6rem">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <button class="ghost" name="rotate" value="1">New webhook secret</button>
    </form></div>
    <h2>API keys</h2>
    <div class="card"><table><thead><tr><th>Name</th><th>Hint</th><th>Created</th><th>State</th><th></th></tr></thead><tbody>${keyRows || `<tr><td colspan="5" class="muted">No keys.</td></tr>`}</tbody></table>
      <form method="post" action="/admin/agents/${esc(agent.id)}/keys" style="margin-top:0.8rem">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <label>New key name</label><input name="name" value="primary">
        <button style="margin-top:0.5rem">Mint key</button>
      </form>
    </div>
    <h2>Inboxes</h2>
    <div class="card"><table><thead><tr><th>Address</th><th>Policy</th><th>Cap</th><th>Status</th></tr></thead><tbody>${inboxRows || `<tr><td colspan="4" class="muted">No inboxes.</td></tr>`}</tbody></table>
      <form method="post" action="/admin/agents/${esc(agent.id)}/inboxes" style="margin-top:0.8rem">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <div class="row"><div><label>Local part</label><input name="localPart" required placeholder="rescue"></div><div><label>Display name</label><input name="displayName"></div></div>
        <div class="row"><div><label>Policy override</label><select name="policy"><option value="">inherit</option><option>auto</option><option>draft</option><option>reply_only_auto</option></select></div>
        <div><label>Daily cap (empty = no extra cap)</label><input name="dailySendCap"></div></div>
        <button style="margin-top:0.6rem">Create inbox</button>
      </form>
    </div>
    ${inboxForms(inboxes, domain, csrf)}`,
  });
}

function inboxForms(inboxes: InboxRow[], domain: string, csrf: string): string {
  return inboxes
    .map((inbox) => {
      const allow = parseJson<string[]>(inbox.allowlist, []).join("\n");
      const block = parseJson<string[]>(inbox.blocklist, []).join("\n");
      return `<div class="card"><h2>${esc(inbox.local_part)}@${esc(domain)}</h2>
      <form method="post" action="/admin/inboxes/${esc(inbox.id)}">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <label>Display name</label><input name="displayName" value="${esc(inbox.display_name ?? "")}">
        <div class="row"><div><label>Policy override</label><select name="policy"><option value="" ${inbox.policy_override ? "" : "selected"}>inherit</option>${policyOptions(inbox.policy_override)}</select></div>
        <div><label>Daily cap</label><input name="dailySendCap" value="${inbox.daily_send_cap ?? ""}"></div></div>
        <label>List mode</label><select name="listMode"><option ${inbox.list_mode === "none" ? "selected" : ""}>none</option><option ${inbox.list_mode === "allow" ? "selected" : ""}>allow</option><option ${inbox.list_mode === "block" ? "selected" : ""}>block</option></select>
        <label>Allow list</label><textarea name="allowlist">${esc(allow)}</textarea>
        <label>Block list</label><textarea name="blocklist">${esc(block)}</textarea>
        <label>Status</label><select name="status"><option ${inbox.status === "active" ? "selected" : ""}>active</option><option ${inbox.status === "disabled" ? "selected" : ""}>disabled</option></select>
        <button style="margin-top:0.6rem">Save inbox</button>
      </form></div>`;
    })
    .join("");
}

function policyOptions(selected: string | null): string {
  return ["auto", "draft", "reply_only_auto"]
    .map((policy) => `<option value="${policy}" ${selected === policy ? "selected" : ""}>${policy}</option>`)
    .join("");
}

export function secretPage(user: UserRow, title: string, secret: string, back: string): string {
  return layout({
    title,
    path: "/admin/agents",
    user,
    body: `<h1>${esc(title)}</h1><p>Copy this value now. It is not shown again.</p><div class="key">${esc(secret)}</div><p><a class="btn" href="${esc(back)}">Back</a></p>`,
  });
}

export function usersPage(user: UserRow, users: UserRow[], csrf: string, notice?: string): string {
  const rows = users
    .map(
      (row) => `<tr><td>${esc(row.email)}</td><td>${esc(row.role)}</td><td>${row.disabled ? "disabled" : "active"}</td><td>${row.id === user.id || row.disabled ? "" : `<form class="inline" method="post" action="/admin/users/${esc(row.id)}/disable"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="ghost">Disable</button></form>`}</td></tr>`,
    )
    .join("");
  return layout({
    title: "Users",
    path: "/admin/users",
    user,
    notice,
    body: `<h1>Users</h1><div class="card"><table><thead><tr><th>Email</th><th>Role</th><th>State</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="card"><h2>Invite</h2><form method="post" action="/admin/users"><input type="hidden" name="csrf" value="${esc(csrf)}"><label>Email</label><input name="email" type="email" required><label>Role</label><select name="role"><option>user</option><option>admin</option></select><button style="margin-top:0.6rem">Invite</button></form></div>`,
  });
}

export function auditPage(user: UserRow, rows: AuditRow[]): string {
  const body = rows
    .map(
      (row) => `<tr><td>${when(row.at)}</td><td>${esc(row.actor_type)}</td><td>${esc(row.action)}</td><td class="muted">${esc(row.target_id ?? "")}</td><td class="muted">${esc(row.detail)}</td></tr>`,
    )
    .join("");
  return layout({
    title: "Audit",
    path: "/admin/audit",
    user,
    body: `<h1>Audit</h1><div class="card"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>${body || `<tr><td colspan="5" class="muted">No events.</td></tr>`}</tbody></table></div>`,
  });
}

export function settingsPage(user: UserRow, settings: SettingsRow, csrf: string, notice?: string): string {
  return layout({
    title: "Settings",
    path: "/admin/settings",
    user,
    notice,
    body: `<h1>Settings</h1><div class="card"><form method="post" action="/admin/settings">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <label><input type="checkbox" name="globalKill" ${settings.global_kill ? "checked" : ""}> Global kill switch</label>
      <label>Unknown address</label><select name="unknownPolicy"><option ${settings.unknown_policy === "reject" ? "selected" : ""}>reject</option><option ${settings.unknown_policy === "quarantine" ? "selected" : ""}>quarantine</option></select>
      <label>Spam TTL days</label><input name="spamTtlDays" type="number" min="1" max="365" value="${settings.spam_ttl_days}">
      <button style="margin-top:0.7rem">Save</button>
    </form></div>`,
  });
}

export function quarantinePage(user: UserRow, rows: QuarantineRow[]): string {
  const body = rows
    .map((row) => `<tr><td>${when(row.received_at)}</td><td>${esc(row.local_part)}</td><td>${esc(row.envelope_from)}</td><td>${esc(row.subject ?? "")}</td><td>${row.spam ? "yes" : "no"}</td></tr>`)
    .join("");
  return layout({
    title: "Quarantine",
    path: "/admin/quarantine",
    user,
    body: `<h1>Quarantine</h1><p class="muted">Unknown addresses are stored here when the unknown policy is quarantine. Only spam rows expire.</p><div class="card"><table><thead><tr><th>When</th><th>Local part</th><th>From</th><th>Subject</th><th>Spam</th></tr></thead><tbody>${body || `<tr><td colspan="5" class="muted">Empty.</td></tr>`}</tbody></table></div>`,
  });
}
