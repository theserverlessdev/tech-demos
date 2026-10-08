import { Agent, type Connection } from "agents";
import { z } from "zod";
import type { ChatMessage, Citation, MemoryItem, MemoryKind, OrgView } from "../shared/types";
import { askModel, retrieve, settleAnswer, type MemoryRow } from "./ground";
import { matchesHash, newId, sha256Hex } from "./secret";

const MAX_FACTS = 80;
const MAX_DECISIONS = 40;
const MAX_MESSAGES = 40;
const MAX_BODY = 8_000;

const SEED: Array<{ kind: MemoryKind; text: string; author: string; source: string }> = [
  { kind: "fact", text: "Northline ships weekly on Thursdays from the Austin warehouse.", author: "Ops", source: "seed" },
  { kind: "fact", text: "Support hours are 09:00–17:00 US Central, Monday through Friday.", author: "Support", source: "seed" },
  { kind: "fact", text: "The public status page is status.northline.example.", author: "Ops", source: "seed" },
  { kind: "decision", text: "Phone support stays closed through Q2; customers use chat and email.", author: "Leadership", source: "Q2 planning" },
  { kind: "decision", text: "Refunds over $200 need a second approver before they are issued.", author: "Finance", source: "refund policy" },
];

const ItemBody = z.object({
  text: z.string().trim().min(1).max(800),
  author: z.string().trim().max(80).optional(),
  source: z.string().trim().max(120).optional(),
});

const IngestBody = ItemBody.extend({ kind: z.enum(["fact", "decision"]) });

const ChatBody = z.object({ message: z.string().trim().min(1).max(500) });

const ProvisionBody = z.object({
  sessionToken: z.string().min(20).max(200),
  ingestToken: z.string().min(20).max(200),
});

type OrgState = { createdAt: number; expiresAt: number; wiped: boolean };
type AuthRow = { session_hash: string; ingest_hash: string };
type ItemRow = { id: string; text: string; author: string; source: string; created_at: number };
type MessageRow = { id: string; role: string; text: string; sources: string; created_at: number };

class OrgError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

/** One line, so a stored row cannot break out of the prompt list or forge a citation id. */
function oneLine(value: string, max: number): string {
  return value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\[(fact|decision):/gi, "[ item ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function ttlMs(env: Env): number {
  const hours = Number(env.ORG_TTL_HOURS);
  const safe = Number.isFinite(hours) && hours >= 1 && hours <= 168 ? hours : 24;
  return safe * 60 * 60 * 1000;
}

function parseSources(raw: string): Citation[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const sources: Citation[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      if ((row.kind !== "fact" && row.kind !== "decision") || typeof row.id !== "string" || typeof row.snippet !== "string") continue;
      sources.push({
        kind: row.kind,
        id: row.id,
        snippet: row.snippet,
        author: typeof row.author === "string" ? row.author : "",
        source: typeof row.source === "string" ? row.source : "",
      });
    }
    return sources;
  } catch {
    return [];
  }
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new OrgError(413, "too_large", "The request body is too large.");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OrgError(400, "invalid_json", "The request body must be JSON.");
  }
}

/**
 * One sandbox org. The Agents SDK alarm (`schedule`) wakes `wipeExpired` and deletes the SQLite rows.
 * Callers reach this object only through the Worker, which checks Turnstile and rate limits first.
 */
export class Org extends Agent<Env, OrgState> {
  initialState: OrgState = { createdAt: 0, expiresAt: 0, wiped: false };

  validateStateChange(_next: OrgState, source: Connection | "server") {
    if (source !== "server") throw new Error("Org state is server-owned.");
  }

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, author TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, author TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, role TEXT NOT NULL, text TEXT NOT NULL, sources TEXT NOT NULL, created_at INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS auth (
      id INTEGER PRIMARY KEY CHECK (id = 1), session_hash TEXT NOT NULL, ingest_hash TEXT NOT NULL)`;
  }

  /** Durable Object alarm callback. Wipes memory and credentials so the sandbox cannot be read later. */
  async wipeExpired(): Promise<void> {
    if (!this.state.wiped) this.setState({ ...this.state, wiped: true });
    this.sql`DELETE FROM facts`;
    this.sql`DELETE FROM decisions`;
    this.sql`DELETE FROM messages`;
    this.sql`DELETE FROM auth`;
    console.log(JSON.stringify({ event: "org_wiped" }));
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const orgId = request.headers.get("x-org-id") ?? "";
    if (!/^org_[0-9a-f]{32}$/.test(orgId)) return errorResponse(400, "invalid_org", "Org id is invalid.");

    try {
      if (url.pathname === "/provision" && request.method === "POST") {
        if (request.headers.get("x-provision") !== "1") return errorResponse(403, "forbidden", "Provision is internal.");
        const parsed = ProvisionBody.safeParse(await readJson(request));
        if (!parsed.success) return errorResponse(400, "invalid_body", "Provision body is invalid.");
        return json(await this.provision(orgId, parsed.data.sessionToken, parsed.data.ingestToken), 201);
      }

      const denied = await this.gate(request, url.pathname === "/ingest");
      if (denied) return denied;

      if ((url.pathname === "/" || url.pathname === "/memory") && request.method === "GET") return json(this.view(orgId));
      if (url.pathname === "/facts" && request.method === "POST") return json({ item: await this.addItem("fact", await readJson(request), "You", "manual") }, 201);
      if (url.pathname === "/decisions" && request.method === "POST") return json({ item: await this.addItem("decision", await readJson(request), "You", "manual") }, 201);
      if (url.pathname === "/ingest" && request.method === "POST") return json({ item: await this.ingest(await readJson(request)) }, 201);
      if (url.pathname === "/chat" && request.method === "POST") return this.chat(await readJson(request));
      return errorResponse(request.method === "GET" || request.method === "POST" ? 404 : 405, "not_found", "Unknown org route.");
    } catch (err) {
      if (err instanceof OrgError) return errorResponse(err.status, err.code, err.message);
      console.error(JSON.stringify({ event: "org_error", name: err instanceof Error ? err.name : "error" }));
      return errorResponse(500, "internal", "The server failed. Try again.");
    }
  }

  private auth(): AuthRow | undefined {
    return this.sql<AuthRow>`SELECT session_hash, ingest_hash FROM auth WHERE id = 1`[0];
  }

  private async gate(request: Request, ingest: boolean): Promise<Response | null> {
    if (this.state.wiped) return errorResponse(410, "expired", "This sandbox org has expired.");
    const row = this.auth();
    if (!row) return errorResponse(404, "not_found", "No org with that id.");
    if (this.state.expiresAt > 0 && Date.now() >= this.state.expiresAt) {
      await this.wipeExpired();
      return errorResponse(410, "expired", "This sandbox org has expired.");
    }
    const presented = ingest ? request.headers.get("x-ingest-token") : request.headers.get("x-session");
    const expected = ingest ? row.ingest_hash : row.session_hash;
    if (!presented) return errorResponse(401, "unauthorized", ingest ? "Ingest token is required." : "Session token is required.");
    if (!(await matchesHash(presented, expected))) return errorResponse(403, "forbidden", "This org belongs to another session.");
    return null;
  }

  private async provision(orgId: string, sessionToken: string, ingestToken: string): Promise<OrgView> {
    if (this.state.wiped || this.auth()) throw new OrgError(409, "exists", "This org is already provisioned.");
    const now = Date.now();
    const expiresAt = now + ttlMs(this.env);
    this.sql`INSERT INTO auth (id, session_hash, ingest_hash) VALUES (1, ${await sha256Hex(sessionToken)}, ${await sha256Hex(ingestToken)})`;
    for (const item of SEED) this.insertItem(item.kind, item.text, item.author, item.source, now);
    this.setState({ createdAt: now, expiresAt, wiped: false });
    try {
      // Agents SDK persists this on the Durable Object alarm and calls wipeExpired when it fires.
      await this.schedule(new Date(expiresAt), "wipeExpired", { reason: "ttl" });
    } catch (err) {
      this.sql`DELETE FROM facts`;
      this.sql`DELETE FROM decisions`;
      this.sql`DELETE FROM auth`;
      this.setState({ createdAt: 0, expiresAt: 0, wiped: false });
      throw err;
    }
    return this.view(orgId);
  }

  private insertItem(kind: MemoryKind, text: string, author: string, source: string, createdAt: number): MemoryItem {
    const id = newId(kind === "fact" ? "f" : "d");
    if (kind === "fact") {
      this.sql`INSERT INTO facts (id, text, author, source, created_at) VALUES (${id}, ${text}, ${author}, ${source}, ${createdAt})`;
    } else {
      this.sql`INSERT INTO decisions (id, text, author, source, created_at) VALUES (${id}, ${text}, ${author}, ${source}, ${createdAt})`;
    }
    return { id, kind, text, author, source, createdAt };
  }

  private async addItem(kind: MemoryKind, body: unknown, defaultAuthor: string, defaultSource: string): Promise<MemoryItem> {
    const parsed = ItemBody.safeParse(body);
    if (!parsed.success) throw new OrgError(400, "invalid_body", "Text is required and must be at most 800 characters.");
    return this.storeItem(kind, parsed.data.text, parsed.data.author || defaultAuthor, parsed.data.source || defaultSource);
  }

  private async ingest(body: unknown): Promise<MemoryItem> {
    const parsed = IngestBody.safeParse(body);
    if (!parsed.success) throw new OrgError(400, "invalid_body", "Ingest needs kind and text, at most 800 characters.");
    return this.storeItem(parsed.data.kind, parsed.data.text, parsed.data.author || "Webhook", parsed.data.source || "webhook");
  }

  private storeItem(kind: MemoryKind, text: string, author: string, source: string): MemoryItem {
    const cleanText = oneLine(text, 800);
    const cleanAuthor = oneLine(author, 80) || "You";
    const cleanSource = oneLine(source, 120) || "manual";
    if (!cleanText) throw new OrgError(400, "invalid_body", "Text is empty.");
    const tableCount = kind === "fact"
      ? this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM facts`[0]?.n ?? 0
      : this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM decisions`[0]?.n ?? 0;
    const cap = kind === "fact" ? MAX_FACTS : MAX_DECISIONS;
    if (tableCount >= cap) throw new OrgError(409, "full", `This org already has ${cap} ${kind === "fact" ? "facts" : "decisions"}.`);
    return this.insertItem(kind, cleanText, cleanAuthor, cleanSource, Date.now());
  }

  private async chat(body: unknown): Promise<Response> {
    const parsed = ChatBody.safeParse(body);
    if (!parsed.success) throw new OrgError(400, "invalid_body", "Message is required and must be at most 500 characters.");
    const question = oneLine(parsed.data.message, 500);
    if (!question) throw new OrgError(400, "invalid_body", "Message is empty.");

    const hits = retrieve(question, this.memoryRows());
    const now = Date.now();
    if (hits.length === 0) {
      const sources: Citation[] = [];
      this.rememberTurn(question, "I don't know.", sources, now);
      return json({ answer: "I don't know.", sources, model: this.env.AI_MODEL, grounded: false });
    }

    let raw: string;
    try {
      raw = await askModel(this.env, question, hits);
    } catch (err) {
      console.error(JSON.stringify({ event: "ai_failed", name: err instanceof Error ? err.name : "error" }));
      return errorResponse(503, "ai_unavailable", "Workers AI is unavailable. I will not guess from outside this org's memory.");
    }

    const settled = settleAnswer(raw, hits);
    this.rememberTurn(question, settled.answer, settled.sources, now);
    return json({ answer: settled.answer, sources: settled.sources, model: this.env.AI_MODEL, grounded: settled.sources.length > 0 });
  }

  private rememberTurn(question: string, answer: string, sources: Citation[], now: number): void {
    this.sql`INSERT INTO messages (id, role, text, sources, created_at) VALUES (${newId("m")}, 'user', ${question}, '[]', ${now})`;
    this.sql`INSERT INTO messages (id, role, text, sources, created_at) VALUES (${newId("m")}, 'assistant', ${answer}, ${JSON.stringify(sources)}, ${now + 1})`;
    this.sql`DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY created_at DESC LIMIT ${MAX_MESSAGES})`;
  }

  private memoryRows(): MemoryRow[] {
    const facts = this.sql<ItemRow>`SELECT id, text, author, source, created_at FROM facts`;
    const decisions = this.sql<ItemRow>`SELECT id, text, author, source, created_at FROM decisions`;
    return [
      ...facts.map((row) => ({ kind: "fact" as const, id: row.id, text: row.text, author: row.author, source: row.source })),
      ...decisions.map((row) => ({ kind: "decision" as const, id: row.id, text: row.text, author: row.author, source: row.source })),
    ];
  }

  private items(kind: MemoryKind): MemoryItem[] {
    const rows = kind === "fact"
      ? this.sql<ItemRow>`SELECT id, text, author, source, created_at FROM facts ORDER BY created_at DESC`
      : this.sql<ItemRow>`SELECT id, text, author, source, created_at FROM decisions ORDER BY created_at DESC`;
    return rows.map((row) => ({ id: row.id, kind, text: row.text, author: row.author, source: row.source, createdAt: row.created_at }));
  }

  private messages(): ChatMessage[] {
    const rows = this.sql<MessageRow>`SELECT id, role, text, sources, created_at FROM messages ORDER BY created_at ASC`;
    return rows.flatMap((row) => {
      if (row.role !== "user" && row.role !== "assistant") return [];
      return [{ id: row.id, role: row.role, text: row.text, sources: parseSources(row.sources), createdAt: row.created_at }];
    });
  }

  private view(orgId: string): OrgView {
    return {
      id: orgId,
      expiresAt: this.state.expiresAt,
      wiped: this.state.wiped,
      facts: this.items("fact"),
      decisions: this.items("decision"),
      messages: this.messages(),
    };
  }
}
