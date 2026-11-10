import { audit } from "./db";
import { logEvent } from "./util";

const API = "https://api.cloudflare.com/client/v4";

type FetchLike = typeof fetch;

let fetchForTests: FetchLike | null = null;

/** Test-only. The Worker uses global fetch unless ENVIRONMENT is "test". */
export function setRoutingFetchForTests(fn: FetchLike | null, env: Env): void {
  if (env.ENVIRONMENT !== "test") throw new Error("Routing fetch overrides are for tests only.");
  fetchForTests = fn;
}

export function inboxAddress(env: Env, localPart: string): string {
  return `${localPart}@${env.MAIL_DOMAIN}`;
}

export function routingRuleText(env: Env, localPart: string): string {
  const worker = env.ROUTING_WORKER_NAME?.trim() || "agent-mail";
  return `${inboxAddress(env, localPart)} -> worker ${worker}`;
}

export function missingRuleNotice(env: Env, localPart: string): string {
  return `routing rule missing: add it in Cloudflare. ${routingRuleText(env, localPart)}`;
}

function configured(value: string | undefined): boolean {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 && !trimmed.startsWith("replace-with");
}

export function routingReady(env: Env): boolean {
  return configured(env.CF_ROUTING_TOKEN) && configured(env.CF_ZONE_ID) && configured(env.ROUTING_WORKER_NAME);
}

type RuleBody = {
  name: string;
  enabled: boolean;
  matchers: { type: "literal"; field: "to"; value: string }[];
  actions: { type: "worker"; value: string[] }[];
};

function ruleBody(env: Env, localPart: string, enabled: boolean): RuleBody {
  const address = inboxAddress(env, localPart);
  return {
    name: address,
    enabled,
    matchers: [{ type: "literal", field: "to", value: address }],
    actions: [{ type: "worker", value: [env.ROUTING_WORKER_NAME!.trim()] }],
  };
}

function rulesUrl(env: Env, ruleId?: string): string {
  const base = `${API}/zones/${env.CF_ZONE_ID!.trim()}/email/routing/rules`;
  return ruleId ? `${base}/${ruleId}` : base;
}

async function cf(env: Env, url: string, init: RequestInit): Promise<{ ok: true; id: string | null } | { ok: false; message: string }> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${env.CF_ROUTING_TOKEN!.trim()}`);
  headers.set("content-type", "application/json");
  let response: Response;
  try {
    const doFetch = fetchForTests ?? fetch;
    response = await doFetch(url, { ...init, headers });
  } catch (err) {
    logEvent("routing", { outcome: "network", error: err instanceof Error ? err.name : "error" });
    return { ok: false, message: "The routing API could not be reached." };
  }
  let payload: { success?: boolean; result?: { id?: string }; errors?: { message?: string }[] } = {};
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    payload = {};
  }
  if (!response.ok || payload.success === false) {
    const message = payload.errors?.find((item) => item.message)?.message || `HTTP ${response.status}`;
    logEvent("routing", { outcome: "rejected", status: response.status });
    return { ok: false, message };
  }
  return { ok: true, id: payload.result?.id ?? null };
}

export async function createRoutingRule(env: Env, localPart: string, actorId: string | null): Promise<{ ruleId: string | null; notice: string | null }> {
  const notice = missingRuleNotice(env, localPart);
  if (!routingReady(env)) {
    await audit(env.DB, {
      actor_type: actorId ? "user" : "system",
      actor_id: actorId,
      action: "routing.skipped",
      target_type: "inbox",
      detail: { address: inboxAddress(env, localPart), reason: "unconfigured" },
    });
    return { ruleId: null, notice };
  }
  const created = await cf(env, rulesUrl(env), { method: "POST", body: JSON.stringify(ruleBody(env, localPart, true)) });
  if (!created.ok || !created.id) {
    await audit(env.DB, {
      actor_type: actorId ? "user" : "system",
      actor_id: actorId,
      action: "routing.failed",
      detail: { address: inboxAddress(env, localPart), message: created.ok ? "no id" : created.message },
    });
    return { ruleId: null, notice };
  }
  await audit(env.DB, {
    actor_type: actorId ? "user" : "system",
    actor_id: actorId,
    action: "routing.created",
    detail: { address: inboxAddress(env, localPart), ruleId: created.id },
  });
  return { ruleId: created.id, notice: null };
}

export async function setRoutingRuleEnabled(env: Env, localPart: string, ruleId: string, enabled: boolean, actorId: string): Promise<string | null> {
  if (!routingReady(env)) return missingRuleNotice(env, localPart);
  const updated = await cf(env, rulesUrl(env, ruleId), {
    method: "PUT",
    body: JSON.stringify(ruleBody(env, localPart, enabled)),
  });
  if (!updated.ok) return missingRuleNotice(env, localPart);
  await audit(env.DB, {
    actor_type: "user",
    actor_id: actorId,
    action: enabled ? "routing.enabled" : "routing.disabled",
    detail: { address: inboxAddress(env, localPart), ruleId },
  });
  return null;
}

export async function deleteRoutingRule(env: Env, localPart: string, ruleId: string, actorId: string): Promise<string | null> {
  const manual = `Remove this rule in Cloudflare: ${routingRuleText(env, localPart)}`;
  if (!routingReady(env)) return manual;
  const removed = await cf(env, rulesUrl(env, ruleId), { method: "DELETE" });
  if (!removed.ok && !/rule not found|\b404\b/i.test(removed.message)) return manual;
  await audit(env.DB, {
    actor_type: "user",
    actor_id: actorId,
    action: "routing.deleted",
    detail: { address: inboxAddress(env, localPart), ruleId },
  });
  return null;
}
