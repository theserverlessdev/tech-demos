import { Agent, type Connection, callable, getAgentByName } from "agents";
import type { ChatMessage, ChatResult, MemoryWrite, RecallHit } from "../shared/types";
import { completeChat } from "./ai";
import type { DemoEnv } from "./env";
import { extractFacts, mergeWrites } from "./extract";
import type { CommitWriteResult } from "./memory-agent";

export type ChatState = { turns: number };

type MemoryStub = {
  recall(query: string): Promise<RecallHit[]>;
  memoryIndex(): Promise<string>;
  commitWrites(input: { writes: MemoryWrite[]; summary: string }): Promise<CommitWriteResult>;
  noteSummary(summary: string): Promise<void>;
  touchActivity(): Promise<void>;
};

type MessageRow = {
  role: string;
  text: string;
  recalled: string;
  commit_hash: string | null;
  commit_message: string | null;
};

function parseRecalled(raw: string): RecallHit[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const hits: RecallHit[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      if (typeof row.path !== "string" || typeof row.snippet !== "string" || typeof row.score !== "number") continue;
      hits.push({ path: row.path, snippet: row.snippet, score: row.score });
    }
    return hits;
  } catch {
    return [];
  }
}

/** One Agents SDK Durable Object per chat thread. The name is `chat-<visitor id>`. */
export class ChatAgent extends Agent<DemoEnv, ChatState> {
  initialState: ChatState = { turns: 0 };

  override async onStart(): Promise<void> {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      recalled TEXT NOT NULL,
      commit_hash TEXT,
      commit_message TEXT,
      created_at INTEGER NOT NULL
    )`);
  }

  override validateStateChange(_next: ChatState, source: Connection | "server"): void {
    if (source !== "server") throw new Error("Chat state is server-owned.");
  }

  private async memory(visitorId: string): Promise<MemoryStub> {
    return (await getAgentByName(this.env.MemoryAgent, visitorId)) as unknown as MemoryStub;
  }

  @callable()
  async transcript(): Promise<ChatMessage[]> {
    const rows = this.ctx.storage.sql
      .exec<MessageRow>("SELECT role, text, recalled, commit_hash, commit_message FROM messages ORDER BY id ASC LIMIT 40")
      .toArray();
    return rows
      .filter((row) => row.role === "user" || row.role === "assistant")
      .map((row) => ({
        role: row.role as ChatMessage["role"],
        text: row.text,
        recalled: parseRecalled(row.recalled),
        commitHash: row.commit_hash,
        commitMessage: row.commit_message,
      }));
  }

  @callable()
  async purge(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM messages");
    this.setState({ turns: 0 });
  }

  @callable()
  async turn(input: { visitorId: string; message: string }): Promise<ChatResult> {
    if (this.name !== `chat-${input.visitorId}`) throw new Error("This chat belongs to another visitor.");
    const text = input.message.trim();
    if (!text || text.length > 800) throw new Error("Messages are limited to 800 characters.");

    const memory = await this.memory(input.visitorId);
    const recalled = await memory.recall(text);
    const memoryIndex = await memory.memoryIndex();
    const extracted = extractFacts(text);
    let model: Awaited<ReturnType<typeof completeChat>> | null = null;
    let fallback = false;
    try {
      model = await completeChat(this.env, { message: text, memoryIndex, recalled });
    } catch (err) {
      fallback = true;
      console.warn(JSON.stringify({ event: "chat_model_failed", error: err instanceof Error ? err.name : "error" }));
    }

    const writes = mergeWrites(model?.remember ?? [], extracted);
    let committed = false;
    let commitHash: string | null = null;
    let commitMessage: string | null = null;
    let paths: string[] = [];
    if (writes.length > 0) {
      const summary = model?.summary || writes.flatMap((write) => write.add).join("; ");
      const result = await memory.commitWrites({ writes, summary });
      if (!result.ok) throw new Error(result.message);
      committed = result.committed;
      commitHash = result.commitHash;
      commitMessage = result.committed ? result.commitMessage : null;
      paths = result.paths;
      if (!result.committed && result.reason && !model) commitMessage = result.reason;
    } else if (model?.summary) {
      await memory.noteSummary(model.summary);
    }

    if (!model && writes.length === 0) throw new Error("Workers AI did not answer. Nothing was saved.");

    const reply =
      model?.reply ??
      (committed
        ? "I saved that in the memory files. Workers AI did not answer, so this reply is the local fallback."
        : "That was already in the memory files. Workers AI did not answer, so this reply is the local fallback.");

    this.insert("user", text, [], null, null);
    this.insert("assistant", reply, recalled, commitHash, commitMessage);
    this.setState({ turns: this.state.turns + 1 });
    await memory.touchActivity();
    return { reply, recalled, committed, commitHash, commitMessage, paths, fallback };
  }

  private insert(role: string, text: string, recalled: RecallHit[], commitHash: string | null, commitMessage: string | null): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (role, text, recalled, commit_hash, commit_message, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      role,
      text.slice(0, 2000),
      JSON.stringify(recalled),
      commitHash,
      commitMessage,
      Date.now(),
    );
    this.ctx.storage.sql.exec("DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 40)");
  }
}
