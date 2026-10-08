/** Sandboxed tools. They return text. None of them fetch, send, or write. */

export const TOOL_NAMES = ["read_docs", "fetch_url", "send_email", "delete_record", "run_sql"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export type ParsedCall = {
  tool: ToolName;
  args: Record<string, string>;
  summary: string;
};

const DOCS: Record<string, string> = {
  refund: "Refunds are available within 14 days for unused seats. This is demo copy, not a real policy.",
  sla: "Priority tickets get a first response within 4 business hours. This desk does not page anyone.",
  privacy: "The demo stores an anonymous session id and a short args summary. It does not keep email bodies in the audit log.",
  overview: "Demo docs cover refund, sla, and privacy. Ask for one of those.",
};

export function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

export function parseToolCall(name: string, raw: unknown): ParsedCall | { error: string } {
  if (!isToolName(name)) return { error: `Unknown tool ${name}. Nothing ran.` };
  const args = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  if (name === "read_docs") {
    const topic = (text(args.topic, 40) ?? "overview").toLowerCase();
    return { tool: name, args: { topic }, summary: `topic ${topic}` };
  }

  if (name === "fetch_url") {
    const url = text(args.url, 200);
    if (!url) return { error: "fetch_url needs a url. Nothing ran." };
    return { tool: name, args: { url }, summary: url };
  }

  if (name === "send_email") {
    const to = text(args.to, 80);
    const subject = text(args.subject, 80);
    const body = text(args.body, 140);
    if (!to || !subject || !body) return { error: "send_email needs to, subject, and body. Nothing ran." };
    if (!/^[^\s@]+@[^\s@]+$/.test(to)) return { error: "send_email needs a plain mailbox. Nothing ran." };
    return { tool: name, args: { to, subject, body }, summary: `to ${to} · ${subject}` };
  }

  if (name === "delete_record") {
    const table = text(args.table, 32);
    const id = text(args.id, 40);
    if (!table || !id || !/^[a-z][a-z0-9_]{0,31}$/.test(table) || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) {
      return { error: "delete_record needs a table and an id. Nothing ran." };
    }
    return { tool: name, args: { table, id }, summary: `${table}/${id}` };
  }

  const sql = text(args.sql, 180);
  if (!sql || /[\r\n;]/.test(sql)) return { error: "run_sql needs one statement without a semicolon. Nothing ran." };
  return { tool: name, args: { sql }, summary: sql };
}

/** Run a call that the gate already allowed. Still refuses anything that would leave the isolate. */
export function runTool(call: ParsedCall): string {
  if (call.tool === "read_docs") {
    const topic = call.args.topic ?? "overview";
    return DOCS[topic] ?? `No demo doc named ${topic}. Ask about refund, sla, or privacy.`;
  }

  if (call.tool === "fetch_url") {
    let url: URL;
    try {
      url = new URL(call.args.url ?? "");
    } catch {
      return "The sandbox refused this fetch: the URL did not parse. No request left the Worker.";
    }
    if (url.protocol !== "https:" || url.username || url.password || isPrivateHost(url.hostname)) {
      return "The sandbox refused this fetch: only a public https URL is described, and no request left the Worker.";
    }
    if (url.hostname === "developers.cloudflare.com") {
      return `Simulated fetch of ${url.hostname}${url.pathname}. Clef is Cloudflare's decision model: it returns a probability for each allowed answer instead of free text. No request left the Worker.`;
    }
    return `Simulated fetch of ${url.hostname}. No request left the Worker.`;
  }

  if (call.tool === "send_email") {
    return `Simulated email to ${call.args.to} with subject “${call.args.subject}”. Nothing was sent.`;
  }

  if (call.tool === "delete_record") {
    return `Simulated delete of ${call.args.id} from ${call.args.table}. No database row was removed.`;
  }

  const sql = (call.args.sql ?? "").trim();
  if (!/^select\b/i.test(sql)) {
    return "The sandbox refused this statement. Only a simulated SELECT is answered, and nothing was executed.";
  }
  return "Simulated SELECT. Two demo rows came back (seat_14, seat_15). Nothing was executed.";
}
