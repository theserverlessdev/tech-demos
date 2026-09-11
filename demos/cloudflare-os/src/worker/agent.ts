import type { BlueprintInfo, GadgetFiles, GadgetInfo, ToolCallRecord, Viewer } from "../shared/types";
import { AGENT_STEP_RESERVE_USD, meter, reserveBudget, usageCost, type Usage } from "./meter";
import { WEB_ALLOWED_HOSTS } from "./gatekeepers";

const MAX_STEPS = 6;

export interface AgentHost {
  env: Env;
  viewer: Viewer;
  gadgets(): GadgetInfo[];
  readme(id: string): string;
  readFile(id: string, path: string): string;
  blueprints(): BlueprintInfo[];
  createGadget(blueprintId: string, title?: string): Promise<GadgetInfo>;
  createCustomGadget(spec: { title: string; icon: string; bindings: string[]; files: GadgetFiles }): Promise<GadgetInfo>;
  writeFile(id: string, path: string, content: string): Promise<GadgetInfo>;
  callGadget(id: string, method: string, args: unknown): Promise<unknown>;
  focus(id: string): void;
  history(): { role: "user" | "assistant"; content: string }[];
  say(content: string): void;
  recordTool(tool: ToolCallRecord): void;
  setStatus(status: string | null): void;
  addCost(c: { usd: number; tokensIn: number; tokensOut: number }): void;
}

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string | Record<string, unknown> } };
type ChatOutput = {
  choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }[];
  // Some Workers AI models return the legacy shape.
  response?: string;
  tool_calls?: { name?: string; arguments?: unknown; id?: string; function?: { name: string; arguments: unknown } }[];
  usage?: Usage;
};

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  type: "function" as const,
  function: { name, description, parameters: { type: "object", properties, required } },
});

const TOOLS = [
  fn("listBlueprints", "List the gadget blueprints that you can create.", {}),
  fn("listGadgets", "List the gadgets in this workspace, with the methods from each README.", {}),
  fn(
    "createGadget",
    "Create a new gadget from a blueprint. Use this first when the user asks for a deck, a game, a board, or a news reader.",
    {
      blueprintId: { type: "string", description: "Blueprint id, for example slides, tictactoe, pixels, headlines." },
      title: { type: "string", description: "Optional tab title." },
    },
    ["blueprintId"],
  ),
  fn(
    "callGadget",
    "Call a public method on a gadget's Durable Object. Read the README methods first. Use this to fill a deck, make a move, draw pixels, or refresh data.",
    {
      gadget: { type: "string", description: "Gadget id, for example gadget2." },
      method: { type: "string" },
      args: { type: "array", description: "Positional arguments as a JSON array.", items: {} },
    },
    ["gadget", "method"],
  ),
  fn(
    "readFile",
    "Read a gadget file.",
    {
      gadget: { type: "string" },
      path: { type: "string", enum: ["server.js", "client.js", "README.md"] },
    },
    ["gadget", "path"],
  ),
  fn(
    "writeFile",
    "Replace one file of an existing gadget. The platform loads the new code into a new Dynamic Worker. The facet storage stays.",
    {
      gadget: { type: "string" },
      path: { type: "string", enum: ["server.js", "client.js", "README.md"] },
      content: { type: "string", description: "The complete new file content." },
    },
    ["gadget", "path", "content"],
  ),
  fn(
    "createCustomGadget",
    "Write a new gadget from scratch. Use this only when no blueprint fits.",
    {
      title: { type: "string" },
      icon: { type: "string", enum: ["presentation", "grid", "palette", "newspaper", "sparkle", "code"] },
      bindings: { type: "array", items: { type: "string", enum: ["WEB", "AI"] } },
      server_js: { type: "string", description: "Complete server.js." },
      client_js: { type: "string", description: "Complete client.js." },
      readme: { type: "string", description: "README.md with a ## Methods list." },
    },
    ["title", "server_js", "client_js", "readme"],
  ),
  fn("openGadget", "Show a gadget tab to everyone in the workspace.", { gadget: { type: "string" } }, ["gadget"]),
];

function methodsSection(readme: string): string {
  const idx = readme.indexOf("## Methods");
  const text = idx >= 0 ? readme.slice(idx) : readme;
  return text.slice(0, 1600);
}

function systemPrompt(host: AgentHost): string {
  const gadgets = host.gadgets();
  const gadgetList = gadgets.length
    ? gadgets
        .map((g) => `### ${g.id}: "${g.title}" (blueprint ${g.blueprint}, version ${g.version}, bindings ${g.bindings.join(", ") || "none"})\n${methodsSection(host.readme(g.id))}`)
        .join("\n\n")
    : "(none yet)";
  const blueprints = host
    .blueprints()
    .map((b) => `- ${b.id}: ${b.title}. ${b.description}${b.bindings.length ? ` Bindings: ${b.bindings.join(", ")}.` : ""}`)
    .join("\n");

  return `You are the agent in a Cloudflare OS workspace. This is a small demo slice of Cloudflare OS on theserverless.dev. The user talking to you is "${host.viewer.name}".

A workspace holds Gadgets. A gadget is a small app:
- server.js exports \`class Gadget extends DurableObject\`. It runs in its own Dynamic Worker, loaded by the Worker Loader, as a Durable Object facet with a private SQLite database.
- client.js builds the UI with DOM code in a sandboxed iframe. The global \`gadget\` is a Cap'n Web RPC stub to the server class. The global \`RpcTarget\` exists for callbacks. The global \`gadgetInfo\` is { id, title, viewer: { name, color } }.
- Gadgets have no network (globalOutbound is null). They reach outside only through bindings: this.env.WEB.getJson(url) (hosts: ${WEB_ALLOWED_HOSTS.join(", ")}; a person approves each read) and this.env.AI.complete({ system, prompt, maxTokens }).

## Blueprints
${blueprints}

## Gadgets in this workspace
${gadgetList}

## How to work
- When the user asks for a thing (a deck, a game, a drawing, news), create a gadget from the matching blueprint, then fill it with callGadget. For example, create "slides" and then call setDeck with real content about the topic.
- To act inside an existing gadget, call its methods with callGadget. For example, make a tic-tac-toe move or draw with pixels.paintMany.
- For pixel drawings, call drawPreset when a preset fits (bolt, heart, star, smile, cloud, logo). Otherwise use paintRects with a few large rectangles in one call.
- Act at once. Call tools directly. Do not write plans, coordinates, or reasoning in your reply.
- Write code only when no blueprint fits, or when the user asks to change how a gadget behaves.
- After a tool call, reply to the user in one to three short sentences. Do not paste code into the chat. Do not use emoji.

## Rules for code you write
server.js:
\`\`\`
import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.subscribers = new Set(); }
  getState() { return this.ctx.storage.kv.get("state") ?? { count: 0 }; }
  increment() { const s = this.getState(); s.count++; this.ctx.storage.kv.put("state", s); this.#broadcast(s); return s; }
  async subscribe(cb) { const d = cb.dup(); this.subscribers.add(d); d.onRpcBroken(() => this.subscribers.delete(d)); }
  #broadcast(s) { for (const d of this.subscribers) d.stateChanged(s).catch(() => this.subscribers.delete(d)); }
}
\`\`\`
client.js (a module; top-level await works; do not import anything; build the DOM with document.createElement):
\`\`\`
class Listener extends RpcTarget { stateChanged(s) { render(s); } }
const root = document.createElement("main"); document.body.append(root);
function render(s) { root.textContent = ""; /* build the UI */ }
render(await gadget.getState());
await gadget.subscribe(new Listener());
\`\`\`
- Store state with this.ctx.storage.kv (get and put are synchronous) or this.ctx.storage.sql.exec(query, ...bindings).
- Validate every method argument. Anyone with the link can call a method.
- No fetch, alert, confirm, or external resources in client.js. Use textContent for user data.
- Style with these CSS variables, which the shell injects: --bg --surface --surface-2 --border --text --text-strong --muted --ember --ember-2 --accent-text --font-heading --font-body --font-mono --radius. Classes .btn, .btn-primary, .chip, and .eyebrow also exist. The look is flat: hairline borders, one ember accent, no gradients.
- README.md: one short paragraph and a "## Methods" list with signatures.
- Keep code compact so it fits in one tool call: server.js under 50 lines, client.js under 90 lines, README under 15 lines. No comments. Reuse .btn and .chip.`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function summarizeArgs(name: string, args: Record<string, unknown>): string {
  const copy: Record<string, unknown> = { ...args };
  for (const key of ["server_js", "client_js", "readme", "content"]) {
    if (typeof copy[key] === "string") copy[key] = `<${(copy[key] as string).length} chars>`;
  }
  if (name === "callGadget" && Array.isArray(copy.args)) {
    const s = JSON.stringify(copy.args);
    copy.args = s.length > 160 ? `<${s.length} chars of JSON>` : copy.args;
  }
  return truncate(JSON.stringify(copy), 240);
}

async function execTool(host: AgentHost, name: string, args: Record<string, unknown>): Promise<{ result: unknown; gadget?: string }> {
  const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
  switch (name) {
    case "listBlueprints":
      return { result: host.blueprints() };
    case "listGadgets":
      return {
        result: host.gadgets().map((g) => ({ id: g.id, title: g.title, blueprint: g.blueprint, bindings: g.bindings, methods: methodsSection(host.readme(g.id)) })),
      };
    case "createGadget": {
      const g = await host.createGadget(str(args.blueprintId), args.title ? str(args.title) : undefined);
      return { result: { id: g.id, title: g.title, methods: methodsSection(host.readme(g.id)) }, gadget: g.id };
    }
    case "callGadget": {
      let callArgs = args.args;
      if (typeof callArgs === "string") {
        try {
          callArgs = JSON.parse(callArgs);
        } catch {
          callArgs = [callArgs];
        }
      }
      const gadget = str(args.gadget);
      const result = await host.callGadget(gadget, str(args.method), callArgs ?? []);
      host.focus(gadget);
      return { result: result ?? null, gadget };
    }
    case "readFile":
      return { result: host.readFile(str(args.gadget), str(args.path)), gadget: str(args.gadget) };
    case "writeFile": {
      const g = await host.writeFile(str(args.gadget), str(args.path), str(args.content));
      host.focus(g.id);
      return { result: { id: g.id, version: g.version, loaderId: g.loaderId }, gadget: g.id };
    }
    case "createCustomGadget": {
      const g = await host.createCustomGadget({
        title: str(args.title),
        icon: str(args.icon),
        bindings: Array.isArray(args.bindings) ? args.bindings.map(str) : [],
        files: { "server.js": str(args.server_js), "client.js": str(args.client_js), "README.md": str(args.readme) },
      });
      return { result: { id: g.id, title: g.title, loaderId: g.loaderId }, gadget: g.id };
    }
    case "openGadget":
      host.focus(str(args.gadget));
      return { result: "ok", gadget: str(args.gadget) };
    default:
      throw new Error(`Unknown tool ${name}.`);
  }
}

export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<\/?think>/g, "").trim();
}

function normalizeCalls(out: ChatOutput): { content: string; calls: ToolCall[] } {
  const message = out.choices?.[0]?.message;
  if (message) return { content: stripThinking(message.content ?? ""), calls: message.tool_calls ?? [] };
  const calls = (out.tool_calls ?? []).map((c, i) => {
    const name = c.function?.name ?? c.name ?? "";
    const raw = c.function?.arguments ?? c.arguments ?? {};
    return { id: c.id ?? `call_${i}`, type: "function" as const, function: { name, arguments: typeof raw === "string" ? raw : JSON.stringify(raw) } };
  });
  return { content: stripThinking(out.response ?? ""), calls };
}

export async function runAgent(host: AgentHost): Promise<void> {
  const { env } = host;
  const messages: Record<string, unknown>[] = [{ role: "system", content: systemPrompt(host) }, ...host.history()];

  for (let step = 0; step < MAX_STEPS; step++) {
    await reserveBudget(env, AGENT_STEP_RESERVE_USD);
    host.setStatus(step === 0 ? "Thinking" : "Reading the results");

    let out: ChatOutput;
    try {
      out = (await env.AI.run(env.AI_MODEL as "@cf/zai-org/glm-5.3-flash", {
        messages,
        tools: TOOLS,
        max_tokens: 9000,
        temperature: 0.2,
        // Reasoning tokens made each turn slow and could use the whole budget before a tool call.
        chat_template_kwargs: { enable_thinking: false },
      } as never)) as ChatOutput;
    } catch (err) {
      await meter(env).settle(AGENT_STEP_RESERVE_USD, 0);
      throw err;
    }

    const cost = usageCost(out.usage);
    await meter(env).settle(AGENT_STEP_RESERVE_USD, cost.usd);
    host.addCost(cost);

    const { content, calls } = normalizeCalls(out);
    if (!calls.length) {
      const truncated = out.choices?.[0]?.finish_reason === "length";
      host.say(content.trim() || (truncated ? "The model reached its output limit before it finished. Try a smaller request." : "Done."));
      return;
    }

    const truncated = out.choices?.[0]?.finish_reason === "length";
    const parsed = calls.map((call) => {
      try {
        const raw = call.function.arguments;
        return { call, args: (typeof raw === "string" ? (raw.trim() ? JSON.parse(raw) : {}) : raw) as Record<string, unknown>, valid: true };
      } catch {
        return { call, args: {} as Record<string, unknown>, valid: false };
      }
    });
    // Invalid JSON in the history makes the next model call fail, so send back only valid arguments.
    messages.push({
      role: "assistant",
      content: content || "",
      tool_calls: parsed.map(({ call, args }) => ({ ...call, function: { name: call.function.name, arguments: JSON.stringify(args) } })),
    });
    for (const { call, args, valid } of parsed) {
      const name = call.function.name;
      if (!valid) {
        const error = truncated
          ? "Your tool call was cut off at the output limit. Write much shorter code: server.js under 50 lines and client.js under 90 lines."
          : "The tool arguments were not valid JSON.";
        host.recordTool({ name, args: "(invalid arguments)", ok: false, result: error });
        messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify({ error }) });
        continue;
      }
      host.setStatus(`Running ${name}`);
      let payload: string;
      let ok = true;
      let gadget: string | undefined;
      try {
        const r = await execTool(host, name, args);
        gadget = r.gadget;
        payload = JSON.stringify(r.result ?? null);
      } catch (err) {
        ok = false;
        payload = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
      host.recordTool({ name, args: summarizeArgs(name, args), ok, result: truncate(payload, 300), gadget });
      messages.push({ role: "tool", tool_call_id: call.id, name, content: truncate(payload, 6000) });
    }
  }
  host.say("I stopped after six steps. Tell me what to do next.");
}
