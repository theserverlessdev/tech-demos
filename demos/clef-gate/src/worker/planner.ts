import { isToolName, type ToolName } from "./tools";

export type Proposal = {
  text: string;
  call: { name: ToolName; args: Record<string, string> } | null;
  planner: "workers-ai" | "local";
};

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const SYSTEM = [
  "You are the Clef Gate desk. You can call one sandboxed tool, or answer with no tool.",
  "Tools never touch real systems. Call a tool only when the user asked for that action.",
  "Call at most one tool. If you are just explaining the desk, do not call a tool.",
  "Do not invent tool results. Do not invent a record id, a URL, or a SQL statement the user did not write.",
].join(" ");

export const PLANNER_MAX_TOKENS = 1024;
export const CLOSING_MAX_TOKENS = 512;

export const PLANNER_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_docs",
      description: "Read one page of the demo docs: refund, sla, privacy, or overview.",
      parameters: {
        type: "object",
        properties: { topic: { type: "string", description: "refund, sla, privacy, or overview" } },
        required: ["topic"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Describe a public https URL. The sandbox does not perform the request.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_email",
      description: "Simulate sending an email. Nothing is delivered.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_record",
      description: "Simulate deleting one record. No row is removed.",
      parameters: {
        type: "object",
        properties: {
          table: { type: "string" },
          id: { type: "string" },
        },
        required: ["table", "id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_sql",
      description: "Simulate one SQL statement. Nothing is executed.",
      parameters: {
        type: "object",
        properties: { sql: { type: "string" } },
        required: ["sql"],
      },
    },
  },
];

export type ChatBody = {
  messages: ChatMessage[];
  tools?: typeof PLANNER_TOOLS;
  max_tokens: number;
  max_completion_tokens?: number;
  reasoning_effort?: "low" | "high" | "max";
  tool_choice?: "auto" | "none";
};

function clip(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) : clean;
}

const SQL_STATEMENT =
  /\b(select|drop|delete|update|insert|alter|truncate)\b(?:\s+\S+){0,3}\s+\b(from|table|into|set)\b/i;
const SQL_COMPACT = /\b(select|drop|delete|update|insert|alter|truncate)\s*[*`(]/i;

export function hasSqlStatement(text: string): boolean {
  return SQL_STATEMENT.test(text) || SQL_COMPACT.test(text);
}

function clarify(text: string): Proposal {
  return { text, call: null, planner: "local" };
}

/** Deterministic mapper for the five desk prompts, and the fallback when the chat model is down. */
export function proposeLocally(userText: string): Proposal {
  const text = userText.trim();
  const lower = text.toLowerCase();

  if (/email|e-mail/.test(lower)) {
    const mailbox = text.match(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/)?.[0];
    const subject = /closed|resolved/.test(lower) ? "Ticket closed" : "Ticket update";
    return {
      text: "",
      call: { name: "send_email", args: { to: mailbox ?? "customer@example.com", subject, body: clip(text, 140) } },
      planner: "local",
    };
  }

  if (hasSqlStatement(text)) {
    const found = text.match(/\b(?:select|drop|delete|update|insert|alter|truncate)\b[\s\S]{0,160}/i);
    if (!found) return clarify("I need a SQL statement such as SELECT … FROM or DROP TABLE …");
    return { text: "", call: { name: "run_sql", args: { sql: clip(found[0], 180) } }, planner: "local" };
  }

  if (/(delete|remove)/.test(lower) && /(record|row|customer|acct_)/.test(lower)) {
    const id = text.match(/\bacct_[a-z0-9]+\b/i)?.[0];
    if (!id) return clarify("Which record id should I delete? I need an id such as acct_1842. I will not invent one.");
    const table = /customer/.test(lower) ? "customers" : "records";
    return { text: "", call: { name: "delete_record", args: { table, id } }, planner: "local" };
  }

  const foundUrl = text.match(/https?:\/\/[^\s]+/i)?.[0]?.replace(/[),.]+$/, "");
  if (foundUrl && foundUrl.length <= 200) {
    return { text: "", call: { name: "fetch_url", args: { url: foundUrl } }, planner: "local" };
  }

  if (/doc|policy|refund|sla|privacy/.test(lower)) {
    const topic = /privacy/.test(lower) ? "privacy" : /sla|response/.test(lower) ? "sla" : /refund|policy/.test(lower) ? "refund" : "overview";
    return { text: "", call: { name: "read_docs", args: { topic } }, planner: "local" };
  }

  if (/fetch/.test(lower)) {
    return clarify("Which https URL should I describe? I will not invent one.");
  }

  return {
    text: "I can read the demo docs, describe a public URL, or ask before I email, delete a record, or run SQL. Nothing on this desk has a real side effect.",
    call: null,
    planner: "local",
  };
}

export function concludeLocally(tool: string, result: string, outcome: "ran" | "denied" | "human-denied"): string {
  if (outcome === "human-denied") return `You denied ${tool}. It did not run.`;
  if (outcome === "denied") return `The gate denied ${tool}. It did not run.`;
  return result;
}

type ToolCall = { id?: string; name?: string; arguments?: unknown; function?: { name?: string; arguments?: unknown } };
type ChatOutput = {
  choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
  response?: string;
  tool_calls?: ToolCall[];
};

function stripThinking(text: string): string {
  const end = text.lastIndexOf("</think>");
  const answer = end >= 0 ? text.slice(end + "</think>".length) : text;
  return answer.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
}

function firstCall(out: ChatOutput): { name: string; args: Record<string, unknown> } | null {
  const message = out.choices?.[0]?.message;
  const calls = message?.tool_calls?.length ? message.tool_calls : (out.tool_calls ?? []);
  const call = calls[0];
  if (!call) return null;
  const name = call.function?.name ?? call.name ?? "";
  const raw = call.function?.arguments ?? call.arguments ?? {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { name, args: parsed as Record<string, unknown> };
    } catch {
      return { name, args: {} };
    }
    return { name, args: {} };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return { name, args: raw as Record<string, unknown> };
  return { name, args: {} };
}

function assistantText(out: ChatOutput): string {
  const content = out.choices?.[0]?.message?.content;
  return stripThinking(typeof content === "string" ? content : (out.response ?? ""));
}

function asStrings(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export async function propose(options: {
  userText: string;
  forceLocal: boolean;
  runChat: (body: ChatBody) => Promise<unknown>;
}): Promise<Proposal> {
  if (options.forceLocal) return proposeLocally(options.userText);
  try {
    const out = (await options.runChat({
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: options.userText },
      ],
      tools: PLANNER_TOOLS,
      max_tokens: PLANNER_MAX_TOKENS,
      max_completion_tokens: PLANNER_MAX_TOKENS,
      reasoning_effort: "low",
      tool_choice: "auto",
    })) as ChatOutput;
    const call = firstCall(out);
    if (call && isToolName(call.name)) {
      return { text: "", call: { name: call.name, args: asStrings(call.args) }, planner: "workers-ai" };
    }
    const text = assistantText(out);
    if (text) return { text, call: null, planner: "workers-ai" };
    console.warn(JSON.stringify({ event: "planner_empty" }));
    return proposeLocally(options.userText);
  } catch (err) {
    console.warn(JSON.stringify({ event: "planner_fallback", error: err instanceof Error ? err.message : "error" }));
    return proposeLocally(options.userText);
  }
}

export async function conclude(options: {
  userText: string;
  tool: string;
  result: string;
  outcome: "ran" | "denied" | "human-denied";
  forceLocal: boolean;
  runChat: (body: ChatBody) => Promise<unknown>;
}): Promise<{ text: string; planner: "workers-ai" | "local" }> {
  const local = concludeLocally(options.tool, options.result, options.outcome);
  if (options.forceLocal || options.outcome !== "ran") return { text: local, planner: "local" };
  try {
    const out = (await options.runChat({
      messages: [
        {
          role: "system",
          content:
            "Reply in one or two sentences using only the tool result. Do not call tools. Do not say a real email was sent or a real row was deleted.",
        },
        { role: "user", content: `The user asked: ${options.userText}\nTool ${options.tool} returned: ${options.result}` },
      ],
      max_tokens: CLOSING_MAX_TOKENS,
      max_completion_tokens: CLOSING_MAX_TOKENS,
      reasoning_effort: "low",
    })) as ChatOutput;
    const text = assistantText(out);
    if (text) return { text: clip(text, 500), planner: "workers-ai" };
    console.warn(JSON.stringify({ event: "conclude_empty" }));
  } catch (err) {
    console.warn(JSON.stringify({ event: "conclude_fallback", error: err instanceof Error ? err.message : "error" }));
  }
  return { text: local, planner: "local" };
}
