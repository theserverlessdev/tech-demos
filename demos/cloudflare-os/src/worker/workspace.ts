import { DurableObject, RpcTarget, RpcStub as NativeRpcStub } from "cloudflare:workers";
import type {
  ActionRecord,
  ActionStatus,
  BindingName,
  BlueprintInfo,
  ChatMessage,
  GadgetFiles,
  GadgetInfo,
  RpcEvent,
  StorageReport,
  ToolCallRecord,
  UiBundle,
  Viewer,
  WorkspaceEvent,
  WorkspaceSnapshot,
} from "../shared/types";
import { runAgent, type AgentHost } from "./agent";
import { BLUEPRINT_INFOS, getBlueprint } from "./blueprints";
import { assertBudget, meter } from "./meter";

const MAX_GADGETS = 8;
const MAX_FILE_BYTES = 96_000;
const APPROVAL_TIMEOUT_MS = 90_000;
const GADGET_CALL_TIMEOUT_MS = 20_000;
const COMPATIBILITY_DATE = "2026-09-04";
const FILE_PATHS = ["server.js", "client.js", "README.md"] as const;
const BINDINGS: BindingName[] = ["WEB", "AI"];
const ICONS = ["presentation", "grid", "palette", "newspaper", "sparkle", "code"];

/**
 * The platform module is the main module of every gadget Dynamic Worker. It extends the gadget's own
 * class with one read-only inspector method, so the shell can show the facet's private SQLite database.
 */
const HARNESS_VERSION = "h1";
const PLATFORM_HARNESS = `import { Gadget as UserGadget } from "./server.js";

export class Gadget extends UserGadget {
  __platformInspect() {
    const report = { tables: [], kv: { count: 0, keys: [] }, databaseSize: null };
    const sql = this.ctx.storage.sql;
    try {
      const tables = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").toArray();
      for (const { name } of tables) {
        const q = '"' + String(name).replaceAll('"', '""') + '"';
        const rows = sql.exec("SELECT COUNT(*) AS n FROM " + q).one().n;
        const cursor = sql.exec("SELECT * FROM " + q + " LIMIT 6");
        const sample = cursor.toArray().map((row) => {
          const out = {};
          for (const [k, v] of Object.entries(row)) out[k] = typeof v === "string" && v.length > 80 ? v.slice(0, 80) + "…" : v instanceof ArrayBuffer ? "<blob>" : v;
          return out;
        });
        report.tables.push({ name, rows, columns: cursor.columnNames, sample });
      }
      report.databaseSize = sql.databaseSize;
    } catch (err) {
      report.error = String(err);
    }
    try {
      for (const [key, value] of this.ctx.storage.kv.list()) {
        report.kv.count++;
        if (report.kv.keys.length < 8) {
          let preview;
          try { preview = JSON.stringify(value); } catch { preview = String(value); }
          report.kv.keys.push({ key, preview: String(preview).slice(0, 160) });
        }
      }
    } catch {}
    return report;
  }
}
`;

type GadgetRow = {
  id: string;
  seq: number;
  title: string;
  blueprint: string;
  icon: string;
  version: number;
  bindings: string;
  code_hash: string;
  created_at: number;
  updated_at: number;
};

type Listener = {
  event(e: WorkspaceEvent): Promise<void>;
  dup(): Listener;
  onRpcBroken(cb: (err: unknown) => void): void;
  [Symbol.dispose](): void;
};

type GadgetStub = Record<string, (...args: unknown[]) => Promise<unknown>>;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One Durable Object per workspace. Upstream calls this the Overseer. It owns the gadget records and
 * files, the chat, and the gatekeeper action journal. It hosts each gadget as a facet.
 */
export class Workspace extends DurableObject<Env> {
  #listeners = new Map<string, { listener: Listener; viewer: Viewer }>();
  #approvals = new Map<number, (status: ActionStatus) => void>();
  #agentBusy = false;
  #agentStatus: string | null = null;
  #snapshotQueued = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS gadgets (
      id TEXT PRIMARY KEY, seq INTEGER NOT NULL, title TEXT NOT NULL, blueprint TEXT NOT NULL,
      icon TEXT NOT NULL, version INTEGER NOT NULL, bindings TEXT NOT NULL, code_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS files (
      gadget TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY (gadget, path))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS chat (
      id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL,
      author TEXT, color TEXT, tool TEXT, at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, gadget TEXT NOT NULL, gatekeeper TEXT NOT NULL,
      title TEXT NOT NULL, detail TEXT NOT NULL, status TEXT NOT NULL, decided_by TEXT, at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS auto_approve (key TEXT PRIMARY KEY)`);
    // A restart drops the in-memory waiters, so no pending action can still complete.
    sql.exec(`UPDATE actions SET status = 'expired' WHERE status = 'pending'`);
  }

  // ---------------------------------------------------------------- meta

  #meta(key: string): string | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key).toArray()[0];
    return row ? row.value : null;
  }

  #setMeta(key: string, value: string | number) {
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      String(value),
    );
  }

  #workspaceId(): string {
    return this.#meta("id") ?? "unknown";
  }

  // ------------------------------------------------------------ sessions

  /** Called by the Worker for each browser connection (named openSession because DurableObject reserves connect). Returns a capability for this workspace. */
  openSession(id: string, viewer: Viewer, ip: string): WorkspaceClient {
    if (!this.#meta("id")) {
      this.#setMeta("id", id);
      this.#setMeta("title", "Untitled workspace");
      this.#setMeta("created_at", Date.now());
      this.#addChat({
        role: "assistant",
        content:
          "This workspace is a Durable Object. Ask me for a deck, a game, a pixel board, or a news reader. You can also start a blueprint from the right pane. Each gadget runs in its own Dynamic Worker.",
      });
    }
    return new WorkspaceClient(this, viewer, ip);
  }

  addListener(key: string, listener: Listener, viewer: Viewer) {
    this.#listeners.set(key, { listener, viewer });
    this.#queueSnapshot();
  }

  removeListener(key: string) {
    const entry = this.#listeners.get(key);
    if (!entry) return;
    this.#listeners.delete(key);
    try {
      entry.listener[Symbol.dispose]();
    } catch {}
    this.#queueSnapshot();
  }

  #broadcast(event: WorkspaceEvent) {
    for (const [key, { listener }] of this.#listeners) {
      listener.event(event).catch(() => this.removeListener(key));
    }
  }

  #queueSnapshot() {
    if (this.#snapshotQueued) return;
    this.#snapshotQueued = true;
    setTimeout(() => {
      this.#snapshotQueued = false;
      this.#broadcast({ type: "snapshot", snapshot: this.snapshot() });
    }, 25);
  }

  sendSnapshotTo(listener: Listener) {
    listener.event({ type: "snapshot", snapshot: this.snapshot() }).catch(() => {});
  }

  snapshot(): WorkspaceSnapshot {
    const sql = this.ctx.storage.sql;
    const presence = new Map<string, Viewer>();
    for (const { viewer } of this.#listeners.values()) presence.set(viewer.id, viewer);

    const chat = sql
      .exec<{ id: number; role: string; content: string; author: string | null; color: string | null; tool: string | null; at: number }>(
        `SELECT * FROM (SELECT * FROM chat ORDER BY id DESC LIMIT 80) ORDER BY id ASC`,
      )
      .toArray()
      .map(
        (r): ChatMessage => ({
          id: r.id,
          role: r.role as ChatMessage["role"],
          content: r.content,
          author: r.author ?? undefined,
          color: r.color ?? undefined,
          tool: r.tool ? (JSON.parse(r.tool) as ToolCallRecord) : undefined,
          at: r.at,
        }),
      );

    const actions = sql
      .exec<{ id: number; gadget: string; gatekeeper: string; title: string; detail: string; status: string; decided_by: string | null; at: number }>(
        `SELECT * FROM actions ORDER BY id DESC LIMIT 40`,
      )
      .toArray()
      .map(
        (r): ActionRecord => ({
          id: r.id,
          gadget: r.gadget,
          gatekeeper: r.gatekeeper as BindingName,
          title: r.title,
          detail: r.detail,
          status: r.status as ActionStatus,
          decidedBy: r.decided_by ?? undefined,
          at: r.at,
        }),
      );

    return {
      id: this.#workspaceId(),
      title: this.#meta("title") ?? "Untitled workspace",
      gadgets: this.#gadgetRows().map((g) => this.#info(g)),
      chat,
      actions,
      presence: [...presence.values()],
      autoApprove: sql.exec<{ key: string }>(`SELECT key FROM auto_approve`).toArray().map((r) => r.key),
      cost: {
        usd: Number(this.#meta("cost_usd") ?? 0),
        tokensIn: Number(this.#meta("tokens_in") ?? 0),
        tokensOut: Number(this.#meta("tokens_out") ?? 0),
      },
      agent: { busy: this.#agentBusy, status: this.#agentStatus, model: this.env.AI_MODEL },
      limits: { maxGadgets: MAX_GADGETS },
    };
  }

  setTitle(title: string) {
    const clean = String(title ?? "").trim().slice(0, 80);
    if (!clean) return;
    this.#setMeta("title", clean);
    this.#queueSnapshot();
  }

  // ---------------------------------------------------------------- chat

  #addChat(msg: { role: ChatMessage["role"]; content: string; author?: string; color?: string; tool?: ToolCallRecord }) {
    this.ctx.storage.sql.exec(
      `INSERT INTO chat (role, content, author, color, tool, at) VALUES (?, ?, ?, ?, ?, ?)`,
      msg.role,
      msg.content,
      msg.author ?? null,
      msg.color ?? null,
      msg.tool ? JSON.stringify(msg.tool) : null,
      Date.now(),
    );
    this.ctx.storage.sql.exec(`DELETE FROM chat WHERE id NOT IN (SELECT id FROM chat ORDER BY id DESC LIMIT 200)`);
    this.#queueSnapshot();
  }

  async chat(text: string, viewer: Viewer, ip: string) {
    const content = String(text ?? "").trim().slice(0, 2000);
    if (!content) return;
    if (this.#agentBusy) throw new Error("The agent is still working on the last request.");
    // Set the flag before the first await. Awaits open the input gate, so a second call could pass the check.
    this.#agentBusy = true;
    this.#addChat({ role: "user", content, author: viewer.name, color: viewer.color });
    try {
      const { success } = await this.env.AGENT_LIMIT.limit({ key: ip });
      if (!success) {
        this.#addChat({ role: "assistant", content: "Too many requests from your network. Wait a minute, then try again." });
        return;
      }
      try {
        await assertBudget(this.env);
      } catch (err) {
        this.#addChat({ role: "assistant", content: errorMessage(err) });
        return;
      }
      this.#setAgentStatus("Thinking");
      await runAgent(this.#agentHost(viewer));
    } catch (err) {
      console.error("agent failed", err);
      this.#addChat({ role: "assistant", content: `The agent stopped with an error: ${errorMessage(err)}` });
    } finally {
      this.#agentBusy = false;
      this.#setAgentStatus(null);
    }
  }

  #setAgentStatus(status: string | null) {
    this.#agentStatus = status;
    this.#queueSnapshot();
  }

  #agentHost(viewer: Viewer): AgentHost {
    return {
      env: this.env,
      viewer,
      gadgets: () => this.#gadgetRows().map((g) => this.#info(g)),
      readme: (id) => this.#file(this.#gadget(id).id, "README.md"),
      readFile: (id, path) => this.#file(this.#gadget(id).id, path),
      blueprints: () => BLUEPRINT_INFOS,
      createGadget: (blueprintId, title) => this.createGadget(blueprintId, title, viewer, "the agent"),
      createCustomGadget: (spec) => this.#createCustomGadget(spec, viewer),
      writeFile: (id, path, content) => this.writeFile(id, path, content, viewer, "the agent"),
      callGadget: (id, method, args) => this.#callGadget(id, method, args, "agent", "agent"),
      focus: (id) => this.#broadcast({ type: "focus", gadget: this.#gadget(id).id }),
      history: () =>
        this.ctx.storage.sql
          .exec<{ role: string; content: string; author: string | null; tool: string | null }>(
            `SELECT * FROM (SELECT * FROM chat ORDER BY id DESC LIMIT 24) ORDER BY id ASC`,
          )
          .toArray()
          .map((r) => {
            if (r.role === "tool" && r.tool) {
              const t = JSON.parse(r.tool) as ToolCallRecord;
              return { role: "assistant" as const, content: `[tool ${t.name}(${t.args}) ${t.ok ? "ok" : "failed"}: ${t.result}]` };
            }
            if (r.role === "user") return { role: "user" as const, content: `${r.author ?? "User"}: ${r.content}` };
            return { role: "assistant" as const, content: r.content };
          }),
      say: (content) => this.#addChat({ role: "assistant", content }),
      recordTool: (tool) => this.#addChat({ role: "tool", content: tool.name, tool }),
      setStatus: (s) => this.#setAgentStatus(s),
      addCost: (c) => this.addCost(c),
    };
  }

  addCost(c: { usd: number; tokensIn: number; tokensOut: number }) {
    this.#setMeta("cost_usd", Number(this.#meta("cost_usd") ?? 0) + c.usd);
    this.#setMeta("tokens_in", Number(this.#meta("tokens_in") ?? 0) + c.tokensIn);
    this.#setMeta("tokens_out", Number(this.#meta("tokens_out") ?? 0) + c.tokensOut);
    this.#queueSnapshot();
  }

  // ------------------------------------------------------------- gadgets

  #gadgetRows(): GadgetRow[] {
    return this.ctx.storage.sql.exec<GadgetRow>(`SELECT * FROM gadgets ORDER BY seq ASC`).toArray();
  }

  #gadget(id: string): GadgetRow {
    const row = this.ctx.storage.sql.exec<GadgetRow>(`SELECT * FROM gadgets WHERE id = ?`, String(id)).toArray()[0];
    if (!row) throw new Error(`No gadget named "${id}" in this workspace.`);
    return row;
  }

  #file(gadgetId: string, path: string): string {
    const row = this.ctx.storage.sql
      .exec<{ content: string }>(`SELECT content FROM files WHERE gadget = ? AND path = ?`, gadgetId, path)
      .toArray()[0];
    return row?.content ?? "";
  }

  #bindings(g: GadgetRow): BindingName[] {
    return (JSON.parse(g.bindings) as string[]).filter((b): b is BindingName => BINDINGS.includes(b as BindingName));
  }

  /**
   * A gadget with no bindings has an empty env, so any workspace can share its Dynamic Worker: the ID
   * is a content hash. A gadget with bindings carries its identity in the binding props, so its ID is
   * specific to this workspace, this gadget, and this version.
   */
  #loaderId(g: GadgetRow): string {
    return this.#bindings(g).length > 0 ? `ws.${this.#workspaceId()}.${g.id}.v${g.version}` : `code.${g.code_hash.slice(0, 32)}`;
  }

  #info(g: GadgetRow): GadgetInfo {
    return {
      id: g.id,
      title: g.title,
      blueprint: g.blueprint,
      icon: g.icon,
      version: g.version,
      bindings: this.#bindings(g),
      loaderId: this.#loaderId(g),
      createdAt: g.created_at,
      updatedAt: g.updated_at,
    };
  }

  async #claimLoader(loaderId: string) {
    const r = await meter(this.env).claimLoader(loaderId);
    if (!r.ok) {
      throw new Error(`The demo reached its daily limit of ${r.cap} new Dynamic Workers. Gadgets that already run still work. Try again tomorrow.`);
    }
  }

  async #codeHash(server: string, bindings: BindingName[]) {
    return sha256(`${HARNESS_VERSION}\n${COMPATIBILITY_DATE}\n${bindings.join(",")}\n${server}`);
  }

  async #insertGadget(spec: { title: string; blueprint: string; icon: string; bindings: BindingName[]; files: GadgetFiles }) {
    if (this.#gadgetRows().length >= MAX_GADGETS) {
      throw new Error(`This workspace already has ${MAX_GADGETS} gadgets. Close one first.`);
    }
    const seq = Number(this.#meta("next_seq") ?? 1);
    const id = `gadget${seq}`;
    const now = Date.now();
    const hash = await this.#codeHash(spec.files["server.js"], spec.bindings);
    await this.#claimLoader(spec.bindings.length > 0 ? `ws.${this.#workspaceId()}.${id}.v1` : `code.${hash.slice(0, 32)}`);
    this.#setMeta("next_seq", seq + 1);
    const sql = this.ctx.storage.sql;
    sql.exec(
      `INSERT INTO gadgets (id, seq, title, blueprint, icon, version, bindings, code_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      id,
      seq,
      spec.title,
      spec.blueprint,
      spec.icon,
      JSON.stringify(spec.bindings),
      hash,
      now,
      now,
    );
    for (const path of FILE_PATHS) {
      sql.exec(`INSERT INTO files (gadget, path, content) VALUES (?, ?, ?)`, id, path, spec.files[path] ?? "");
    }
    // Model calls from a gadget cost money, but the budget guard covers them, so AI starts auto-approved.
    if (spec.bindings.includes("AI")) sql.exec(`INSERT OR IGNORE INTO auto_approve (key) VALUES (?)`, `${id}:AI`);
    return this.#gadget(id);
  }

  async createGadget(blueprintId: string, title: string | undefined, viewer: Viewer, via = "") {
    const bp = getBlueprint(String(blueprintId));
    if (!bp) throw new Error(`Unknown blueprint "${blueprintId}". Use one of: ${BLUEPRINT_INFOS.map((b) => b.id).join(", ")}.`);
    const row = await this.#insertGadget({
      title: String(title ?? "").trim().slice(0, 60) || bp.title,
      blueprint: bp.id,
      icon: bp.icon,
      bindings: bp.bindings,
      files: bp.files,
    });
    this.#addChat({ role: "system", content: `${viewer.name}${via ? ` (through ${via})` : ""} created ${row.title} as ${row.id}.` });
    this.#broadcast({ type: "focus", gadget: row.id });
    return this.#info(row);
  }

  async #createCustomGadget(
    spec: { title: string; icon: string; bindings: string[]; files: GadgetFiles },
    viewer: Viewer,
  ) {
    for (const path of FILE_PATHS) {
      if ((spec.files[path] ?? "").length > MAX_FILE_BYTES) throw new Error(`${path} is larger than ${MAX_FILE_BYTES} bytes.`);
    }
    if (!/export\s+class\s+Gadget\b/.test(spec.files["server.js"] ?? "")) {
      throw new Error("server.js must contain `export class Gadget extends DurableObject`.");
    }
    const row = await this.#insertGadget({
      title: String(spec.title ?? "").trim().slice(0, 60) || "Custom gadget",
      blueprint: "custom",
      icon: ICONS.includes(spec.icon) ? spec.icon : "sparkle",
      bindings: (spec.bindings ?? []).filter((b): b is BindingName => BINDINGS.includes(b as BindingName)),
      files: spec.files,
    });
    this.#addChat({ role: "system", content: `${viewer.name} (through the agent) wrote ${row.title} as ${row.id}.` });
    this.#broadcast({ type: "focus", gadget: row.id });
    return this.#info(row);
  }

  removeGadget(id: string, viewer: Viewer) {
    const g = this.#gadget(id);
    const sql = this.ctx.storage.sql;
    sql.exec(`DELETE FROM gadgets WHERE id = ?`, g.id);
    sql.exec(`DELETE FROM files WHERE gadget = ?`, g.id);
    sql.exec(`DELETE FROM auto_approve WHERE key LIKE ?`, `${g.id}:%`);
    // Deletes the facet's SQLite database too.
    this.ctx.facets.delete(g.id);
    this.#addChat({ role: "system", content: `${viewer.name} removed ${g.title} (${g.id}) and its facet storage.` });
    this.#broadcast({ type: "gadget-removed", gadget: g.id });
    this.#queueSnapshot();
  }

  getFiles(id: string): GadgetFiles {
    const g = this.#gadget(id);
    return {
      "server.js": this.#file(g.id, "server.js"),
      "client.js": this.#file(g.id, "client.js"),
      "README.md": this.#file(g.id, "README.md"),
    };
  }

  getUiBundle(id: string): UiBundle {
    const g = this.#gadget(id);
    return { jsCode: this.#file(g.id, "client.js"), version: g.version };
  }

  async writeFile(id: string, path: string, content: string, viewer: Viewer, via = "") {
    const g = this.#gadget(id);
    if (!FILE_PATHS.includes(path as (typeof FILE_PATHS)[number])) throw new Error(`Unknown file "${path}".`);
    const text = String(content ?? "");
    if (text.length > MAX_FILE_BYTES) throw new Error(`${path} is larger than ${MAX_FILE_BYTES} bytes.`);
    if (path === "server.js" && !/export\s+class\s+Gadget\b/.test(text)) {
      throw new Error("server.js must contain `export class Gadget extends DurableObject`.");
    }
    const previous = this.#file(g.id, path);
    const put = (content: string) =>
      this.ctx.storage.sql.exec(
        `INSERT INTO files (gadget, path, content) VALUES (?, ?, ?) ON CONFLICT(gadget, path) DO UPDATE SET content = excluded.content`,
        g.id,
        path,
        content,
      );
    put(text);
    let row: GadgetRow;
    try {
      row = await this.#bumpVersion(g);
    } catch (err) {
      put(previous);
      throw err;
    }
    this.#addChat({
      role: "system",
      content: `${viewer.name}${via ? ` (through ${via})` : ""} saved ${path} for ${g.title}. Version ${row.version} runs in a new Dynamic Worker. The facet storage stays.`,
    });
    return this.#info(row);
  }

  async setBinding(id: string, binding: BindingName, enabled: boolean, viewer: Viewer) {
    const g = this.#gadget(id);
    if (!BINDINGS.includes(binding)) throw new Error(`Unknown binding "${binding}".`);
    const set = new Set(this.#bindings(g));
    if (enabled) set.add(binding);
    else set.delete(binding);
    const bindings = BINDINGS.filter((b) => set.has(b));
    this.ctx.storage.sql.exec(`UPDATE gadgets SET bindings = ? WHERE id = ?`, JSON.stringify(bindings), g.id);
    let row: GadgetRow;
    try {
      row = await this.#bumpVersion(this.#gadget(g.id));
    } catch (err) {
      this.ctx.storage.sql.exec(`UPDATE gadgets SET bindings = ? WHERE id = ?`, g.bindings, g.id);
      throw err;
    }
    this.#addChat({
      role: "system",
      content: `${viewer.name} ${enabled ? "connected" : "disconnected"} the ${binding} gatekeeper ${enabled ? "to" : "from"} ${g.title}.`,
    });
    return this.#info(row);
  }

  /** New code or new bindings: new Dynamic Worker ID, restart the facet, keep its storage. */
  async #bumpVersion(g: GadgetRow): Promise<GadgetRow> {
    const bindings = this.#bindings(g);
    const hash = await this.#codeHash(this.#file(g.id, "server.js"), bindings);
    await this.#claimLoader(this.#loaderId({ ...g, version: g.version + 1, code_hash: hash }));
    this.ctx.storage.sql.exec(
      `UPDATE gadgets SET version = version + 1, code_hash = ?, updated_at = ? WHERE id = ?`,
      hash,
      Date.now(),
      g.id,
    );
    this.ctx.facets.abort(g.id, new Error("The gadget code changed."));
    const row = this.#gadget(g.id);
    this.#broadcast({ type: "gadget-reloaded", gadget: row.id, version: row.version });
    this.#queueSnapshot();
    return row;
  }

  #loadWorker(g: GadgetRow): WorkerStub {
    const loaderId = this.#loaderId(g);
    const bindings = this.#bindings(g);
    return this.env.LOADER.get(loaderId, () => {
      const exportsAny = this.ctx.exports as unknown as Record<string, (o: { props: unknown }) => Fetcher>;
      const props = { workspace: this.#workspaceId(), gadget: g.id };
      const env: Record<string, Fetcher> = {};
      if (bindings.includes("WEB")) env.WEB = exportsAny.WebGatekeeper!({ props });
      if (bindings.includes("AI")) env.AI = exportsAny.AiGatekeeper!({ props });
      return {
        compatibilityDate: COMPATIBILITY_DATE,
        mainModule: "platform.js",
        modules: {
          "platform.js": PLATFORM_HARNESS,
          "server.js": this.#file(g.id, "server.js"),
        },
        env,
        // No network. Bindings are the only way out.
        globalOutbound: null,
        limits: { cpuMs: 500, subRequests: 50 },
      };
    });
  }

  #facet(g: GadgetRow): GadgetStub {
    const facet = this.ctx.facets.get(g.id, () => ({
      class: this.#loadWorker(g).getDurableObjectClass("Gadget"),
      id: g.id,
    }));
    return facet as unknown as GadgetStub;
  }

  #rpcEvent(event: Omit<RpcEvent, "at">) {
    this.#broadcast({ type: "rpc", event: { ...event, at: Date.now() } });
  }

  async #callGadget(id: string, method: string, args: unknown, via: RpcEvent["via"], who: string) {
    const g = this.#gadget(id);
    if (!/^[A-Za-z_$][\w$]*$/.test(method) || method.startsWith("__") || ["constructor", "fetch", "alarm", "subscribe"].includes(method)) {
      throw new Error(`"${method}" is not a callable gadget method.`);
    }
    const list = Array.isArray(args) ? args : args === undefined ? [] : [args];
    const started = Date.now();
    try {
      const result = await withTimeout(this.#facet(g)[method]!(...list), GADGET_CALL_TIMEOUT_MS, `${g.id}.${method}()`);
      this.#rpcEvent({ gadget: g.id, method, ms: Date.now() - started, ok: true, via, who });
      return result;
    } catch (err) {
      this.#rpcEvent({ gadget: g.id, method, ms: Date.now() - started, ok: false, via, who });
      throw new Error(errorMessage(err));
    }
  }

  /**
   * Returns the facet stub for the browser. Facet stubs cannot yet travel over RPC, so this wraps the
   * stub in a Proxy that looks like an RpcTarget, which is the same workaround upstream uses. The Proxy
   * also records each call for the shell's RPC trace.
   */
  connectToGadget(id: string, viewer: Viewer) {
    const g = this.#gadget(id);
    const facet = this.#facet(g);
    const self = this;
    const proxy = new Proxy(facet, {
      get(target, prop) {
        if (typeof prop === "symbol") return Reflect.get(target, prop, target);
        const method = Reflect.get(target, prop, target);
        if (typeof method !== "function") return method;
        if (prop.startsWith("__")) return undefined;
        return (...args: unknown[]) => {
          const started = Date.now();
          return (Reflect.apply(method, target, args) as Promise<unknown>).then(
            (value) => {
              self.#rpcEvent({ gadget: g.id, method: prop, ms: Date.now() - started, ok: true, via: "ui", who: viewer.name });
              return value;
            },
            (err) => {
              self.#rpcEvent({ gadget: g.id, method: prop, ms: Date.now() - started, ok: false, via: "ui", who: viewer.name });
              self.#broadcast({ type: "log", gadget: g.id, level: "error", message: `${errorMessage(err)} (in ${prop}())` });
              throw err;
            },
          );
        };
      },
      getPrototypeOf() {
        return RpcTarget.prototype;
      },
    });
    return new NativeRpcStub(proxy as unknown as RpcTarget);
  }

  async inspectStorage(id: string): Promise<StorageReport> {
    const g = this.#gadget(id);
    const started = Date.now();
    const report = (await withTimeout(this.#facet(g).__platformInspect!(), GADGET_CALL_TIMEOUT_MS, "inspect")) as StorageReport;
    this.#rpcEvent({ gadget: g.id, method: "__platformInspect", ms: Date.now() - started, ok: true, via: "platform" });
    return report;
  }

  reportLog(id: string, level: "info" | "error", message: string) {
    this.#broadcast({ type: "log", gadget: String(id).slice(0, 40), level: level === "error" ? "error" : "info", message: String(message).slice(0, 500) });
  }

  // --------------------------------------------------------- gatekeepers

  /** Called by a gatekeeper before it touches the outside world. Resolves on approval, throws on denial. */
  async authorize(gadgetId: string, gatekeeper: BindingName, title: string, detail: string): Promise<void> {
    const g = this.#gadget(gadgetId);
    const sql = this.ctx.storage.sql;
    const auto = sql.exec(`SELECT key FROM auto_approve WHERE key = ?`, `${g.id}:${gatekeeper}`).toArray().length > 0;
    const status: ActionStatus = auto ? "auto" : "pending";
    const id = sql
      .exec<{ id: number }>(
        `INSERT INTO actions (gadget, gatekeeper, title, detail, status, at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
        g.id,
        gatekeeper,
        String(title).slice(0, 120),
        String(detail).slice(0, 300),
        status,
        Date.now(),
      )
      .one().id;
    sql.exec(`DELETE FROM actions WHERE id NOT IN (SELECT id FROM actions ORDER BY id DESC LIMIT 200)`);
    this.#queueSnapshot();
    if (auto) return;

    const decision = await new Promise<ActionStatus>((resolve) => {
      this.#approvals.set(id, resolve);
      setTimeout(() => {
        if (!this.#approvals.has(id)) return;
        this.#approvals.delete(id);
        sql.exec(`UPDATE actions SET status = 'expired' WHERE id = ? AND status = 'pending'`, id);
        this.#queueSnapshot();
        resolve("expired");
      }, APPROVAL_TIMEOUT_MS);
    });
    if (decision !== "approved") {
      throw new Error(`Denied: "${title}" was ${decision === "expired" ? "not approved within 90 seconds" : "denied"}.`);
    }
  }

  decideAction(actionId: number, approve: boolean, always: boolean, viewer: Viewer) {
    const sql = this.ctx.storage.sql;
    const row = sql.exec<{ id: number; gadget: string; gatekeeper: string; status: string }>(`SELECT * FROM actions WHERE id = ?`, Number(actionId)).toArray()[0];
    if (!row || row.status !== "pending") return;
    const status: ActionStatus = approve ? "approved" : "denied";
    sql.exec(`UPDATE actions SET status = ?, decided_by = ? WHERE id = ?`, status, viewer.name, row.id);
    if (approve && always) sql.exec(`INSERT OR IGNORE INTO auto_approve (key) VALUES (?)`, `${row.gadget}:${row.gatekeeper}`);
    const resolve = this.#approvals.get(row.id);
    this.#approvals.delete(row.id);
    resolve?.(status);
    this.#queueSnapshot();
  }

  /** Code changes create Dynamic Workers, so each IP gets a small share of the daily cap. */
  async assertCodeLimit(ip: string) {
    const { success } = await this.env.CODE_LIMIT.limit({ key: ip });
    if (!success) throw new Error("Too many gadget changes from your network. Wait a minute, then try again.");
  }

  setAutoApprove(gadgetId: string, binding: BindingName, enabled: boolean) {
    const g = this.#gadget(gadgetId);
    const key = `${g.id}:${binding}`;
    if (enabled) this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO auto_approve (key) VALUES (?)`, key);
    else this.ctx.storage.sql.exec(`DELETE FROM auto_approve WHERE key = ?`, key);
    this.#queueSnapshot();
  }

  recordGatekeeperCall(gadgetId: string, label: string, ms: number, ok: boolean) {
    this.#rpcEvent({ gadget: gadgetId, method: label, ms, ok, via: "gatekeeper" });
  }
}

/**
 * One capability per browser session. The Worker returns it to the browser over Cap'n Web. Every method
 * acts as the viewer who opened the session.
 */
export class WorkspaceClient extends RpcTarget {
  #ws: Workspace;
  #viewer: Viewer;
  #ip: string;
  #key = crypto.randomUUID();

  constructor(ws: Workspace, viewer: Viewer, ip: string) {
    super();
    this.#ws = ws;
    this.#viewer = viewer;
    this.#ip = ip;
  }

  subscribe(listener: Listener) {
    const dup = listener.dup();
    this.#ws.addListener(this.#key, dup, this.#viewer);
    dup.onRpcBroken(() => this.#ws.removeListener(this.#key));
    this.#ws.sendSnapshotTo(dup);
  }

  ping() {
    return Date.now();
  }

  setTitle(title: string) {
    this.#ws.setTitle(title);
  }

  listBlueprints(): BlueprintInfo[] {
    return BLUEPRINT_INFOS;
  }

  async createGadget(blueprintId: string, title?: string) {
    await this.#ws.assertCodeLimit(this.#ip);
    return this.#ws.createGadget(blueprintId, title, this.#viewer);
  }

  removeGadget(id: string) {
    this.#ws.removeGadget(id, this.#viewer);
  }

  getUiBundle(id: string) {
    return this.#ws.getUiBundle(id);
  }

  connectToGadget(id: string) {
    return this.#ws.connectToGadget(id, this.#viewer);
  }

  getFiles(id: string) {
    return this.#ws.getFiles(id);
  }

  async writeFile(id: string, path: keyof GadgetFiles, content: string) {
    await this.#ws.assertCodeLimit(this.#ip);
    return this.#ws.writeFile(id, path, content, this.#viewer);
  }

  async setBinding(id: string, binding: BindingName, enabled: boolean) {
    await this.#ws.assertCodeLimit(this.#ip);
    return this.#ws.setBinding(id, binding, enabled, this.#viewer);
  }

  inspectStorage(id: string) {
    return this.#ws.inspectStorage(id);
  }

  decideAction(actionId: number, approve: boolean, always: boolean) {
    this.#ws.decideAction(actionId, approve, always, this.#viewer);
  }

  setAutoApprove(id: string, binding: BindingName, enabled: boolean) {
    this.#ws.setAutoApprove(id, binding, enabled);
  }

  chat(text: string) {
    return this.#ws.chat(text, this.#viewer, this.#ip);
  }

  reportLog(id: string, level: "info" | "error", message: string) {
    this.#ws.reportLog(id, level, message);
  }

  [Symbol.dispose]() {
    this.#ws.removeListener(this.#key);
  }
}
