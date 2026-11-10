import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { boundToken, lookupPresentedToken, tokensMatch } from "./approve-token";
import { consumeApproveToken, getAgent, getDraft, getInbox, getSettings, releaseApproveToken } from "./db";
import { approveDraftAs, rejectDraftAs } from "./outbound";
import type { DraftRow } from "./types";
import { HttpError, esc, htmlToText, originOf, sha256Hex } from "./util";

const PREVIEW_CHARS = 500;
const hits = new Map<string, { n: number; reset: number }>();

export const approveLinks = new Hono<{ Bindings: Env }>();

approveLinks.get("/a/done", (c) => {
  const result = new URL(c.req.url).searchParams.get("result");
  const message = result === "sent" ? "Sent." : result === "rejected" ? "Rejected. Nothing was sent." : "Done.";
  return page(c, shell("Done", `<h1>${esc(message)}</h1><p><a href="/admin">Open the admin panel</a></p>`));
});

approveLinks.get("/a/:token", async (c) => {
  const preview = await loadPreview(c.env, c.req.param("token"));
  if (!preview) return page(c, neutral());
  return page(c, review(c.req.param("token"), preview, null));
});

approveLinks.post("/a/:token", async (c) => {
  if (postedTooOften(c.req.header("cf-connecting-ip") ?? "local")) return page(c, neutral(), 429);
  if (!sameOrigin(c.req.raw)) return page(c, neutral());
  const pathToken = c.req.param("token");
  const body = await readFields(c.req.raw);
  if (!(await tokensMatch(pathToken, body.token))) return page(c, neutral());
  const preview = await loadPreview(c.env, pathToken);
  if (!preview) return page(c, neutral());
  if (body.action !== "approve" && body.action !== "reject") return page(c, review(pathToken, preview, null));

  const now = Date.now();
  const consumed = await consumeApproveToken(c.env.DB, await sha256Hex(boundToken(pathToken)), now);
  if (!consumed || consumed.draft_id !== preview.draftId) return page(c, neutral());

  try {
    if (body.action === "reject") {
      await rejectDraftAs(c.env, preview.draftId, { type: "approve_link", id: consumed.id }, null);
      return done(c, "rejected");
    }
    await approveDraftAs(c.env, preview.draftId, { type: "approve_link", id: consumed.id });
    return done(c, "sent");
  } catch (err) {
    const draft = await getDraft(c.env.DB, preview.draftId);
    if (!draft || draft.status === "pending") await releaseApproveToken(c.env.DB, consumed.id);
    if (err instanceof HttpError) return page(c, review(pathToken, preview, err.message), err.status as ContentfulStatusCode);
    throw err;
  }
});

type Preview = { draftId: string; from: string; to: string; subject: string; body: string; agentName: string; adminUrl: string };

async function loadPreview(env: Env, raw: string): Promise<Preview | null> {
  const settings = await getSettings(env.DB);
  if (settings.approve_links !== 1) return null;
  const row = await lookupPresentedToken(env, raw);
  const now = Date.now();
  if (!row || row.used_at != null || row.expires_at <= now) return null;
  const draft = await getDraft(env.DB, row.draft_id);
  if (!draft || draft.status !== "pending") return null;
  const inbox = await getInbox(env.DB, draft.inbox_id);
  const agent = await getAgent(env.DB, draft.agent_id);
  if (!inbox || !agent) return null;
  const fromEmail = `${inbox.local_part}@${env.MAIL_DOMAIN}`;
  const from = inbox.display_name ? `${inbox.display_name} <${fromEmail}>` : fromEmail;
  const to = parseList(draft.to_addrs).concat(parseList(draft.cc_addrs)).join(", ");
  return {
    draftId: draft.id,
    from,
    to,
    subject: draft.subject,
    body: previewBody(draft),
    agentName: agent.name,
    adminUrl: `${originOf(env)}/admin/drafts/${draft.id}`,
  };
}

function previewBody(draft: DraftRow): string {
  const source = draft.text_body?.trim() ? draft.text_body : draft.html_body ? htmlToText(draft.html_body) : "";
  const cleaned = source.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  return cleaned.length > PREVIEW_CHARS ? `${cleaned.slice(0, PREVIEW_CHARS)}…` : cleaned;
}

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function review(raw: string, preview: Preview, error: string | null): string {
  const notice = error ? `<p class="notice">${esc(error)}</p>` : "";
  return shell(
    preview.subject,
    `${notice}<p class="muted">${esc(preview.agentName)}</p>
    <h1>${esc(preview.subject)}</h1>
    <p><b>From</b> ${esc(preview.from)}</p>
    <p><b>To</b> ${esc(preview.to)}</p>
    <pre>${esc(preview.body)}</pre>
    <form method="post" action="/a/${esc(raw)}">
      <input type="hidden" name="token" value="${esc(raw)}">
      <input type="hidden" name="action" value="approve">
      <button class="go">Approve &amp; send</button>
    </form>
    <form method="post" action="/a/${esc(raw)}">
      <input type="hidden" name="token" value="${esc(raw)}">
      <input type="hidden" name="action" value="reject">
      <button class="stop">Reject</button>
    </form>
    <p><a href="${esc(preview.adminUrl)}">Edit in admin</a></p>`,
  );
}

function neutral(): string {
  return shell(
    "Link not active",
    `<h1>This link is not active</h1><p>It may have been used, expired, or turned off.</p><p><a href="/admin">Open the admin panel</a></p>`,
  );
}

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>
body { margin: 0; background: #0e0e11; color: #f3efe7; font: 16px/1.45 ui-sans-serif, system-ui, sans-serif; }
main { max-width: 32rem; margin: 0 auto; padding: 1rem; }
h1 { font-size: 1.25rem; }
.muted { color: #9c978f; }
.notice { background: #2a160f; border: 1px solid #c2410c; border-radius: 8px; padding: 0.6rem 0.8rem; }
pre { white-space: pre-wrap; word-break: break-word; background: #17171c; border-radius: 8px; padding: 0.8rem; }
button { width: 100%; min-height: 3rem; font: inherit; border-radius: 10px; }
.go { background: #c2410c; color: white; border: 0; }
.stop { margin-top: 0.6rem; background: transparent; color: #f3efe7; border: 1px solid #2c2c33; }
a { color: #f3efe7; }
</style></head><body><main>${body}</main></body></html>`;
}

function page(c: Context, body: string, status: ContentfulStatusCode = 200): Response {
  stamp(c);
  return c.html(body, status);
}

function done(c: Context, result: "sent" | "rejected"): Response {
  stamp(c);
  return c.redirect(`/a/done?result=${result}`, 303);
}

function stamp(c: Context): void {
  c.header("cache-control", "no-store");
  c.header("referrer-policy", "no-referrer");
  c.header("x-robots-tag", "noindex");
}

function sameOrigin(request: Request): boolean {
  // Referrer-Policy: no-referrer makes Chrome send Origin: null on this form POST.
  // Sec-Fetch-Site is set by the browser and is same-origin only for our page.
  if (request.headers.get("sec-fetch-site") === "same-origin") return true;
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  return origin === new URL(request.url).origin;
}

function postedTooOften(ip: string): boolean {
  if (hits.size > 2000) hits.clear();
  const now = Date.now();
  const row = hits.get(ip);
  if (!row || row.reset < now) {
    hits.set(ip, { n: 1, reset: now + 60_000 });
    return false;
  }
  row.n += 1;
  return row.n > 30;
}

async function readFields(request: Request): Promise<{ token: string; action: string }> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as { token?: unknown; action?: unknown } | null;
    return { token: typeof body?.token === "string" ? body.token : "", action: typeof body?.action === "string" ? body.action : "" };
  }
  const form = await request.formData();
  const token = form.get("token");
  const action = form.get("action");
  return { token: typeof token === "string" ? token : "", action: typeof action === "string" ? action : "" };
}
