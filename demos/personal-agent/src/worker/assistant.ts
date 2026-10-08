import { Agent, type Connection } from "agents";
import type { ChatReply, NoteDetail, NoteSummary, RecallHit, ResearchReply, SessionInfo, ThreadMessage } from "../shared/types";
import { complete, embedTexts } from "./ai";
import { cosine, fromBlob, keywordScore, keywords, toBlob } from "./memory";
import { researchQuestion } from "./research";

const MAX_NOTES = 40;
const MAX_MESSAGES = 40;
const RECALL_K = 3;
const MIN_SCORE = 0.34;
const DEFAULT_TTL_HOURS = 24;

export type AssistantState = {
  noteCount: number;
  messageCount: number;
  expiresAt: number;
  purgeScheduleId: string | null;
};

export type Fail = { ok: false; code: string; message: string };
export type Ok<T> = { ok: true; data: T };

type NoteRow = {
  id: string;
  title: string;
  r2_key: string;
  embedding: ArrayBuffer | null;
  dims: number;
  keywords: string;
  body_hash: string;
  created_at: number;
};

type MessageRow = {
  id: number;
  role: string;
  content: string;
  recalled: string;
  created_at: number;
};

function ttlSeconds(env: Env): number {
  const hours = Number(env.VISITOR_TTL_HOURS);
  const safe = Number.isFinite(hours) ? Math.min(168, Math.max(1, Math.floor(hours))) : DEFAULT_TTL_HOURS;
  return safe * 3600;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function parseRecalled(raw: string): RecallHit[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const hits: RecallHit[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      if (typeof row.id !== "string" || typeof row.title !== "string" || typeof row.score !== "number") continue;
      hits.push({ id: row.id, title: row.title, score: row.score });
    }
    return hits;
  } catch {
    return [];
  }
}

async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    await Promise.all(listed.objects.map((object) => bucket.delete(object.key)));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

export class Assistant extends Agent<Env, AssistantState> {
  initialState: AssistantState = {
    noteCount: 0,
    messageCount: 0,
    expiresAt: 0,
    purgeScheduleId: null,
  };

  async onStart(): Promise<void> {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      recalled TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      r2_key TEXT NOT NULL,
      embedding BLOB,
      dims INTEGER NOT NULL,
      keywords TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
  }

  /** No browser socket is opened. State stays server-owned if one ever is. */
  override validateStateChange(_next: AssistantState, source: Connection | "server"): void {
    if (source !== "server") throw new Error("Assistant state is server-owned.");
  }

  private prefix(): string {
    return `v/${this.name}/`;
  }

  private noteRows(): NoteRow[] {
    return this.ctx.storage.sql
      .exec<NoteRow>("SELECT id, title, r2_key, embedding, dims, keywords, body_hash, created_at FROM notes ORDER BY created_at DESC")
      .toArray();
  }

  private countNotes(): number {
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM notes").one().n;
  }

  private countMessages(): number {
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages").one().n;
  }

  /**
   * Agents SDK schedule() owns the Durable Object alarm. A direct setAlarm()
   * would clobber that slot, so expiry is a named callback. A stale callback
   * no-ops when a newer write has already pushed expiresAt forward.
   */
  async purgeExpired(): Promise<void> {
    if (this.state.expiresAt > Date.now() + 30_000) return;
    await deletePrefix(this.env.NOTES, this.prefix());
    this.ctx.storage.sql.exec("DELETE FROM messages");
    this.ctx.storage.sql.exec("DELETE FROM notes");
    this.setState({ noteCount: 0, messageCount: 0, expiresAt: 0, purgeScheduleId: null });
  }

  private async armPurge(): Promise<void> {
    const previous = this.state.purgeScheduleId;
    if (previous) {
      try {
        await this.cancelSchedule(previous);
      } catch (err) {
        console.error(JSON.stringify({ event: "purge_cancel_failed", error: err instanceof Error ? err.name : "error" }));
      }
    }
    const delay = ttlSeconds(this.env);
    const scheduled = await this.schedule(delay, "purgeExpired", { at: Date.now() });
    this.setState({
      ...this.state,
      purgeScheduleId: scheduled.id,
      expiresAt: Date.now() + delay * 1000,
      noteCount: this.countNotes(),
      messageCount: this.countMessages(),
    });
  }

  async session(): Promise<Ok<SessionInfo>> {
    return {
      ok: true,
      data: {
        expiresAt: this.state.expiresAt,
        noteCount: this.countNotes(),
        messageCount: this.countMessages(),
        ttlHours: ttlSeconds(this.env) / 3600,
      },
    };
  }

  async listNotes(): Promise<Ok<{ notes: NoteSummary[] }>> {
    return { ok: true, data: { notes: this.noteRows().map(toSummary) } };
  }

  async readNote(id: string): Promise<Ok<NoteDetail> | Fail> {
    const row = this.noteRows().find((note) => note.id === id);
    if (!row || !row.r2_key.startsWith(this.prefix())) {
      return { ok: false, code: "not_found", message: "That note is not in this visitor's notebook." };
    }
    const object = await this.env.NOTES.get(row.r2_key);
    if (!object) return { ok: false, code: "not_found", message: "That note's file is missing." };
    const markdown = await object.text();
    const body = markdown.replace(/^# [^\n]*\n+/, "").trim();
    return { ok: true, data: { ...toSummary(row), body } };
  }

  async saveNote(input: { title: string; body: string }): Promise<Ok<{ note: NoteSummary; duplicate: boolean }> | Fail> {
    const title = input.title.trim().slice(0, 120);
    const body = input.body.trim();
    if (!title || !body) return { ok: false, code: "invalid", message: "A note needs a title and a body." };
    if (body.length > 8_000) return { ok: false, code: "too_large", message: "Notes are limited to 8000 characters." };
    const hash = await sha256Hex(`${title}\n${body}`);
    const existing = this.noteRows().find((note) => note.body_hash === hash);
    if (existing) return { ok: true, data: { note: toSummary(existing), duplicate: true } };
    if (this.countNotes() >= MAX_NOTES) {
      return { ok: false, code: "too_many_notes", message: "This visitor already has 40 notes. Delete one first." };
    }

    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    const key = `${this.prefix()}notes/${id}.md`;
    const markdown = `# ${title}\n\n${body}\n`;
    const embedded = await embedTexts(this.env, [`${title}\n${body}`]);
    const vector = embedded?.[0] ?? null;
    try {
      await this.env.NOTES.put(key, markdown, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
      this.ctx.storage.sql.exec(
        "INSERT INTO notes (id, title, r2_key, embedding, dims, keywords, body_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        title,
        key,
        vector ? toBlob(vector) : null,
        vector?.length ?? 0,
        keywords(`${title}\n${body}`).join(" "),
        hash,
        Date.now(),
      );
    } catch (err) {
      await this.env.NOTES.delete(key).catch(() => undefined);
      console.error(JSON.stringify({ event: "note_save_failed", error: err instanceof Error ? err.name : "error" }));
      return { ok: false, code: "store_failed", message: "The note could not be saved. Try again." };
    }
    await this.armPurge();
    const saved = this.noteRows().find((note) => note.id === id);
    if (!saved) return { ok: false, code: "store_failed", message: "The note could not be saved. Try again." };
    return { ok: true, data: { note: toSummary(saved), duplicate: false } };
  }

  async deleteNote(id: string): Promise<Ok<{ deleted: true }> | Fail> {
    const row = this.noteRows().find((note) => note.id === id);
    if (!row || !row.r2_key.startsWith(this.prefix())) {
      return { ok: false, code: "not_found", message: "That note is not in this visitor's notebook." };
    }
    await this.env.NOTES.delete(row.r2_key);
    this.ctx.storage.sql.exec("DELETE FROM notes WHERE id = ?", id);
    await this.armPurge();
    return { ok: true, data: { deleted: true } };
  }

  async thread(): Promise<Ok<{ messages: ThreadMessage[] }>> {
    const rows = this.ctx.storage.sql
      .exec<MessageRow>("SELECT id, role, content, recalled, created_at FROM messages ORDER BY id ASC")
      .toArray();
    return {
      ok: true,
      data: {
        messages: rows.map((row) => ({
          id: row.id,
          role: row.role === "assistant" ? "assistant" : "user",
          content: row.content,
          recalled: parseRecalled(row.recalled),
          createdAt: row.created_at,
        })),
      },
    };
  }

  async chat(input: { message: string }): Promise<Ok<ChatReply> | Fail> {
    const message = input.message.trim();
    if (!message || message.length > 2_000) return { ok: false, code: "invalid", message: "Messages must be 1 to 2000 characters." };

    let savedNote: NoteSummary | null = null;
    const remembered = message.match(/^\s*remember(?:\s+that)?[:\s]+([\s\S]{8,})$/i);
    if (remembered?.[1]) {
      const body = remembered[1].trim();
      const saved = await this.saveNote({ title: clip(body.replace(/\s+/g, " "), 80), body });
      if (!saved.ok) return saved;
      savedNote = saved.data.note;
    }

    const recalled = await this.recall(message);
    const memories: { hit: RecallHit; body: string }[] = [];
    for (const hit of recalled) {
      const note = await this.readNote(hit.id);
      if (note.ok) memories.push({ hit, body: clip(note.data.body, 1_500) });
    }
    const history = this.ctx.storage.sql
      .exec<MessageRow>("SELECT id, role, content, recalled, created_at FROM messages ORDER BY id DESC LIMIT 8")
      .toArray()
      .reverse();
    const historyText = history.map((row) => `${row.role}: ${clip(row.content, 500)}`).join("\n");
    const memoryText = memories.map((item) => `Note "${item.hit.title}" (score ${item.hit.score.toFixed(2)}):\n${item.body}`).join("\n\n");
    const generated = await complete(
      this.env,
      "You are a personal assistant for one anonymous visitor. Use only the recalled notes and the conversation. When you use a note, mention its title. Do not invent memories or personal data. If nothing was recalled, say you have no saved note for that. Under 160 words.",
      `Recalled notes:\n${memoryText || "(none)"}\n\nConversation:\n${historyText || "(none)"}\n\nVisitor: ${message}`,
    );
    const reply = generated
      ? generated
      : memories.length
        ? `The model is unavailable. I still found ${memories.map((item) => `"${item.hit.title}"`).join(", ")}. ${clip(memories[0]!.body, 400)}`
        : "The model is unavailable, and I did not find a saved note for that. Save a note, then ask again.";

    const now = Date.now();
    this.ctx.storage.sql.exec("INSERT INTO messages (role, content, recalled, created_at) VALUES (?, ?, ?, ?)", "user", message, "[]", now);
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (role, content, recalled, created_at) VALUES (?, ?, ?, ?)",
      "assistant",
      reply,
      JSON.stringify(recalled),
      now + 1,
    );
    this.trimMessages();
    await this.armPurge();
    return { ok: true, data: { reply, recalled, source: generated ? "workers-ai" : "fallback", savedNote } };
  }

  async research(input: { question: string; urls: string[] }): Promise<Ok<ResearchReply> | Fail> {
    const question = input.question.trim();
    if (question.length < 8 || question.length > 500) {
      return { ok: false, code: "invalid", message: "The research question must be 8 to 500 characters." };
    }
    const result = await researchQuestion(this.env, question, input.urls);
    if (!result.ok) return result;
    const now = Date.now();
    this.ctx.storage.sql.exec("INSERT INTO messages (role, content, recalled, created_at) VALUES (?, ?, ?, ?)", "user", `Research: ${question}`, "[]", now);
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (role, content, recalled, created_at) VALUES (?, ?, ?, ?)",
      "assistant",
      result.summary,
      "[]",
      now + 1,
    );
    this.trimMessages();
    await this.armPurge();
    return { ok: true, data: { summary: result.summary, source: result.source, citations: result.citations } };
  }

  private trimMessages(): void {
    const extra = this.countMessages() - MAX_MESSAGES;
    if (extra > 0) {
      this.ctx.storage.sql.exec("DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY id ASC LIMIT ?)", extra);
    }
  }

  private async recall(query: string): Promise<RecallHit[]> {
    const rows = this.noteRows();
    if (!rows.length) return [];
    const embedded = await embedTexts(this.env, [query]);
    const queryVector = embedded?.[0] ?? null;
    const hits: RecallHit[] = [];
    for (const row of rows) {
      let semantic = 0;
      if (queryVector && row.embedding && row.dims === queryVector.length) {
        semantic = cosine(queryVector, fromBlob(row.embedding));
      }
      const lexical = keywordScore(query, `${row.title} ${row.keywords}`);
      // Short notes often sit under a cosine floor. Keep the stronger signal so recall still works when embeddings are down.
      const score = Math.max(semantic, lexical);
      if (score < MIN_SCORE) continue;
      hits.push({ id: row.id, title: row.title, score: Math.round(score * 100) / 100 });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, RECALL_K);
  }
}

function toSummary(row: NoteRow): NoteSummary {
  return { id: row.id, title: row.title, createdAt: row.created_at };
}
