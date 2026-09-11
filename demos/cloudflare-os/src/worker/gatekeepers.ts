import { WorkerEntrypoint } from "cloudflare:workers";
import { COMPLETION_RESERVE_USD, meter, reserveBudget, usageCost, type Usage } from "./meter";
import type { Workspace } from "./workspace";

export type GatekeeperProps = { workspace: string; gadget: string };

export const WEB_ALLOWED_HOSTS = ["hn.algolia.com", "api.github.com", "en.wikipedia.org"];

const MAX_BODY_BYTES = 512_000;

function workspaceStub(env: Env, id: string): DurableObjectStub<Workspace> {
  return (env.WORKSPACES as unknown as DurableObjectNamespace<Workspace>).getByName(id);
}

/**
 * The WEB gatekeeper. Gadgets run with `globalOutbound: null`, so this binding is their only path to
 * the internet. Each read goes through the workspace approval queue before the request leaves.
 */
export class WebGatekeeper extends WorkerEntrypoint<Env, GatekeeperProps> {
  async getJson(rawUrl: string): Promise<unknown> {
    let url: URL;
    try {
      url = new URL(String(rawUrl));
    } catch {
      throw new Error("WEB.getJson needs an absolute URL.");
    }
    if (url.protocol !== "https:") throw new Error("WEB.getJson allows https only.");
    if (!WEB_ALLOWED_HOSTS.includes(url.hostname)) {
      throw new Error(`Denied: ${url.hostname} is not on the WEB gatekeeper allowlist (${WEB_ALLOWED_HOSTS.join(", ")}).`);
    }

    const { workspace, gadget } = this.ctx.props;
    const ws = workspaceStub(this.env, workspace);
    await ws.authorize(gadget, "WEB", `Read ${url.hostname}`, `GET ${url.pathname}${url.search}`.slice(0, 300));

    const started = Date.now();
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "tech-demos-cloudflare-os (+https://tech-demos.theserverless.dev)" },
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    await ws.recordGatekeeperCall(gadget, `WEB GET ${url.hostname} → ${res.status}`, Date.now() - started, res.ok);
    if (!res.ok) throw new Error(`WEB: ${url.hostname} returned HTTP ${res.status}.`);
    if (text.length > MAX_BODY_BYTES) throw new Error("WEB: the response is larger than 512 KB.");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("WEB: the response is not JSON.");
    }
  }
}

/** The AI gatekeeper. It meters each call against the workspace cost and the global daily budget. */
export class AiGatekeeper extends WorkerEntrypoint<Env, GatekeeperProps> {
  async complete(options: { system?: string; prompt: string; maxTokens?: number }): Promise<string> {
    const prompt = String(options?.prompt ?? "").slice(0, 8000);
    if (!prompt) throw new Error("AI.complete needs a prompt.");
    const system = String(options?.system ?? "You are a helpful assistant.").slice(0, 2000);
    const maxTokens = Math.min(Math.max(Number(options?.maxTokens) || 400, 16), 800);

    const { workspace, gadget } = this.ctx.props;
    const ws = workspaceStub(this.env, workspace);
    const { success } = await this.env.AGENT_LIMIT.limit({ key: `ai:${workspace}` });
    if (!success) throw new Error("AI: too many completions from this workspace. Wait a minute.");
    await ws.authorize(gadget, "AI", "Run a Workers AI completion", prompt.slice(0, 200));
    await reserveBudget(this.env, COMPLETION_RESERVE_USD);

    const started = Date.now();
    const run = this.env.AI.run(this.env.AI_MODEL as "@cf/zai-org/glm-5.3-flash", {
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.4,
      chat_template_kwargs: { enable_thinking: false },
    } as never) as Promise<{ choices?: { message?: { content?: string } }[]; usage?: Usage }>;
    let out: Awaited<typeof run>;
    try {
      out = await run;
    } catch (err) {
      await meter(this.env).settle(COMPLETION_RESERVE_USD, 0);
      throw err;
    }

    const cost = usageCost(out.usage);
    await meter(this.env).settle(COMPLETION_RESERVE_USD, cost.usd);
    await ws.addCost(cost);
    await ws.recordGatekeeperCall(gadget, `AI ${this.env.AI_MODEL} · ${cost.tokensOut} tokens`, Date.now() - started, true);
    return String(out.choices?.[0]?.message?.content ?? "")
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/<\/?think>/g, "")
      .trim();
  }
}
