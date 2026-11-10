import { audit } from "./db";
import type { AgentRow } from "./types";
import { decryptString, hmacHex } from "./util";

export async function signBody(secret: string, body: string): Promise<string> {
  return `sha256=${await hmacHex(secret, body)}`;
}

export async function deliverWebhook(env: Env, agent: AgentRow, payload: Record<string, unknown>): Promise<void> {
  if (!agent.webhook_url || !agent.webhook_secret_enc || !env.WEBHOOK_KEY) return;
  let secret: string;
  try {
    secret = await decryptString(env.WEBHOOK_KEY, agent.webhook_secret_enc);
  } catch {
    await audit(env.DB, { actor_type: "system", actor_id: agent.id, action: "webhook.failed", target_type: "agent", target_id: agent.id, detail: { reason: "secret" } });
    return;
  }
  const body = JSON.stringify(payload);
  const signature = await signBody(secret, body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(agent.webhook_url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-mail-signature": signature },
      body,
      signal: controller.signal,
    });
    await audit(env.DB, {
      actor_type: "system",
      actor_id: agent.id,
      action: response.ok ? "webhook.delivered" : "webhook.failed",
      target_type: "agent",
      target_id: agent.id,
      detail: { status: response.status },
    });
  } catch {
    await audit(env.DB, {
      actor_type: "system",
      actor_id: agent.id,
      action: "webhook.failed",
      target_type: "agent",
      target_id: agent.id,
      detail: { reason: "network" },
    });
  } finally {
    clearTimeout(timer);
  }
}
