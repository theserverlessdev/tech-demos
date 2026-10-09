import { Agent, type Connection, callable } from "agents";
import type { CommitDetail, DreamStep, DreamView, MemoryFile, MemoryWrite, RecallHit } from "../shared/types";
import { deleteVisitor, touchVisitor, upsertVisitor } from "./db";
import { parseDream } from "./dream";
import { artifactsBinding, type DemoEnv } from "./env";
import type { FtsDb } from "./fts";
import { ensureFts, recall as searchMemory, replaceIndexedFiles } from "./fts";
import { completeDream } from "./ai";
import { makeCommit, treeFromFiles } from "./git";
import { applyMemoryWrites, isMemoryPath, MEMORY_AUTHOR, MEMORY_PATHS, seedFiles } from "./memory-files";
import { changedFiles } from "./diff";
import { asCommits, commitFiles, headCommit, readFilesAt, revokeQuiet, toSummary, tokenPlaintext, withRepo } from "./repo";

export type MemoryState = {
  provisioned: boolean;
  repoName: string;
  remote: string;
  backend: "artifacts" | "local";
  expiresAt: number;
  head: string | null;
  dreamScheduleId: string | null;
  purgeScheduleId: string | null;
  lastDreamAt: number;
};

export type ProvisionResult =
  | { ok: true; repoName: string; remote: string; head: string | null; expiresAt: number; threadId: string }
  | { ok: false; code: string; message: string };

export type CommitWriteResult =
  | { ok: true; committed: true; commitHash: string; commitMessage: string; paths: string[] }
  | { ok: true; committed: false; commitHash: null; commitMessage: null; paths: string[]; reason: string }
  | { ok: false; code: string; message: string };

export type Snapshot = {
  expiresAt: number;
  remote: string;
  repoName: string;
  local: boolean;
  files: MemoryFile[];
  commits: ReturnType<typeof toSummary>[];
  dream: DreamView | null;
};

const EMPTY: MemoryState = {
  provisioned: false,
  repoName: "",
  remote: "",
  backend: "artifacts",
  expiresAt: 0,
  head: null,
  dreamScheduleId: null,
  purgeScheduleId: null,
  lastDreamAt: 0,
};

function ttlMs(env: DemoEnv): number {
  const hours = Number(env.VISITOR_TTL_HOURS);
  const safe = Number.isFinite(hours) && hours >= 1 && hours <= 168 ? hours : 24;
  return safe * 60 * 60 * 1000;
}

function dreamIntervalSeconds(env: DemoEnv): number {
  const seconds = Number(env.DREAM_INTERVAL_SECONDS);
  return Number.isFinite(seconds) && seconds >= 60 ? Math.floor(seconds) : 4 * 60 * 60;
}

function dreamsPerHour(env: DemoEnv): number {
  const count = Number(env.DREAMS_PER_HOUR);
  return Number.isFinite(count) && count >= 1 && count <= 30 ? Math.floor(count) : 6;
}

function parseSteps(raw: string): DreamStep[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const steps: DreamStep[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      if (typeof row.label !== "string" || typeof row.detail !== "string") continue;
      steps.push({ label: row.label.slice(0, 80), detail: row.detail.slice(0, 300) });
    }
    return steps;
  } catch {
    return [];
  }
}

/**
 * One SQLite Durable Object per anonymous visitor. It owns that visitor's Artifacts repo,
 * the FTS5 index over the markdown, and the dream alarm. Agents SDK schedule() owns the
 * alarm slot, so expiry and dreaming are named callbacks rather than setAlarm().
 */
export class MemoryAgent extends Agent<DemoEnv, MemoryState> {
  initialState: MemoryState = { ...EMPTY };

  override async onStart(): Promise<void> {
    ensureFts(this.fts());
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS local_commits (
      hash TEXT PRIMARY KEY,
      parent TEXT,
      message TEXT NOT NULL,
      files TEXT NOT NULL,
      authored_at INTEGER NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS dream_log (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      commit_hash TEXT,
      message TEXT,
      steps TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
  }

  override validateStateChange(_next: MemoryState, source: Connection | "server"): void {
    if (source !== "server") throw new Error("Memory state is server-owned.");
  }

  private fts(): FtsDb {
    const sql = this.ctx.storage.sql;
    return {
      exec(statement, ...params) {
        sql.exec(statement, ...params);
      },
      all(statement, ...params) {
        return sql.exec(statement, ...params).toArray();
      },
    };
  }

  private fileMap(): Record<string, string> {
    const rows = this.ctx.storage.sql.exec<{ path: string; body: string }>("SELECT path, body FROM files").toArray();
    const files: Record<string, string> = { ...seedFiles() };
    for (const row of rows) {
      if (isMemoryPath(row.path)) files[row.path] = row.body;
    }
    return files;
  }

  private threadId(): string {
    return `chat-${this.name}`;
  }

  private isLocalDev(): boolean {
    const environment: string = this.env.ENVIRONMENT;
    return environment === "local";
  }

  /** Dev sessions without an Artifacts login keep real git objects in SQLite. Production does not. */
  private async useLocalMirror(repoName: string): Promise<ProvisionResult | null> {
    if (!this.isLocalDev()) return null;
    const files = seedFiles();
    const head = await this.writeLocalCommit(files, "Seed MEMORY.md and topic files", null);
    replaceIndexedFiles(this.fts(), files, Date.now());
    const now = Date.now();
    const expiresAt = now + ttlMs(this.env);
    const remote = `local://${repoName}`;
    await upsertVisitor(this.env, {
      id: this.name,
      threadId: this.threadId(),
      repoName,
      remote,
      createdAt: now,
      lastActivityAt: now,
      expiresAt,
    });
    this.setState({
      provisioned: true,
      repoName,
      remote,
      backend: "local",
      expiresAt,
      head,
      dreamScheduleId: null,
      purgeScheduleId: null,
      lastDreamAt: 0,
    });
    try {
      await this.armPurge(expiresAt);
      await this.armDream();
    } catch (err) {
      console.error(JSON.stringify({ event: "schedule_failed", error: String(err).slice(0, 180) }));
      await this.wipe();
      return { ok: false, code: "schedule", message: "The expiry alarm could not be set, so the repo was not kept." };
    }
    console.log(JSON.stringify({ event: "local_mirror", reason: "artifacts_unavailable" }));
    return { ok: true, repoName, remote, head, expiresAt: this.state.expiresAt, threadId: this.threadId() };
  }

  private async writeLocalCommit(files: Record<string, string>, message: string, parent: string | null): Promise<string> {
    const { tree } = await treeFromFiles(files);
    const timestamp = Math.floor(Date.now() / 1000);
    const commit = await makeCommit({
      tree: tree.sha,
      parents: parent ? [parent] : [],
      author: { ...MEMORY_AUTHOR, timestamp },
      message,
    });
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO local_commits (hash, parent, message, files, authored_at) VALUES (?, ?, ?, ?, ?)",
      commit.sha,
      parent,
      message,
      JSON.stringify(files),
      timestamp,
    );
    return commit.sha;
  }

  private localLog(): Snapshot["commits"] {
    const rows = this.ctx.storage.sql
      .exec<{ hash: string; parent: string | null; message: string; authored_at: number }>(
        "SELECT hash, parent, message, authored_at FROM local_commits ORDER BY rowid DESC LIMIT 30",
      )
      .toArray();
    return rows.map((row) => ({
      hash: row.hash,
      message: row.message.replace(/\n[\s\S]*$/, "").trim(),
      authorName: MEMORY_AUTHOR.name,
      authoredAt: row.authored_at,
      parents: row.parent ? [row.parent] : [],
    }));
  }

  private localDiff(hash: string): CommitDetail {
    const row = this.ctx.storage.sql
      .exec<{ parent: string | null; message: string; files: string }>("SELECT parent, message, files FROM local_commits WHERE hash = ?", hash)
      .toArray()[0];
    if (!row) throw new Error("That commit is not in this repo.");
    const after = new Map(Object.entries(JSON.parse(row.files) as Record<string, string>));
    let before = new Map<string, string>();
    if (row.parent) {
      const parent = this.ctx.storage.sql
        .exec<{ files: string }>("SELECT files FROM local_commits WHERE hash = ?", row.parent)
        .toArray()[0];
      if (parent) before = new Map(Object.entries(JSON.parse(parent.files) as Record<string, string>));
    }
    return {
      hash,
      message: row.message.replace(/\n[\s\S]*$/, "").trim(),
      parent: row.parent,
      files: changedFiles(before, after),
    };
  }

  @callable()
  async provision(): Promise<ProvisionResult> {
    if (this.state.provisioned && this.state.repoName && this.state.remote) {
      return {
        ok: true,
        repoName: this.state.repoName,
        remote: this.state.remote,
        head: this.state.head,
        expiresAt: this.state.expiresAt,
        threadId: this.threadId(),
      };
    }
    if (!/^[a-f0-9]{32}$/.test(this.name)) return { ok: false, code: "visitor", message: "Visitor id is invalid." };

    const repoName = `mem-${this.name}`;
    const artifacts = artifactsBinding(this.env);
    if (!artifacts) {
      const local = await this.useLocalMirror(repoName);
      if (local) return local;
      return { ok: false, code: "artifacts", message: "Artifacts could not create the memory repo." };
    }
    let remote = "";
    let seedToken = "";
    try {
      const created = await artifacts.create(repoName, {
        description: "tech-demos memory-repo",
        setDefaultBranch: "main",
      });
      remote = created.remote ?? "";
      if (created.token) seedToken = tokenPlaintext(created.token);
    } catch (err) {
      console.warn(JSON.stringify({ event: "repo_create_retry", error: String(err).slice(0, 160) }));
    }
    if (!remote && artifacts) {
      try {
        const info = await withRepo(artifacts, repoName, (repo) => repo.info());
        remote = info?.remote ?? "";
      } catch (err) {
        console.error(JSON.stringify({ event: "repo_create_failed", error: String(err).slice(0, 180) }));
      }
    }
    if (!remote) {
      const local = await this.useLocalMirror(repoName);
      if (local) return local;
      return { ok: false, code: "artifacts", message: "Artifacts could not create the memory repo." };
    }

    const files = seedFiles();
    let head: string | null = null;
    try {
      head = await withRepo(artifacts, repoName, async (repo) => (await headCommit(repo))?.hash ?? null);
      if (!head) {
        if (!seedToken) {
          const minted = await withRepo(artifacts, repoName, (repo) => repo.createToken("write", 120));
          seedToken = tokenPlaintext(minted);
        }
        try {
          head = await commitFiles({
            artifacts,
            repoName,
            remote,
            token: seedToken,
            parent: null,
            files,
            message: "Seed MEMORY.md and topic files",
          });
        } finally {
          if (seedToken) await revokeQuiet(artifacts, repoName, seedToken);
        }
      } else if (seedToken) {
        await revokeQuiet(artifacts, repoName, seedToken);
      }
    } catch (err) {
      console.error(JSON.stringify({ event: "seed_commit_failed", error: String(err).slice(0, 180) }));
      if (artifacts) {
        try {
          await artifacts.delete(repoName);
        } catch {
          /* the create error is the one the visitor sees */
        }
      }
      const local = await this.useLocalMirror(repoName);
      if (local) return local;
      return { ok: false, code: "artifacts", message: "The seed commit failed, so no memory repo was kept." };
    }

    replaceIndexedFiles(this.fts(), files, Date.now());
    const now = Date.now();
    const expiresAt = now + ttlMs(this.env);
    await upsertVisitor(this.env, {
      id: this.name,
      threadId: this.threadId(),
      repoName,
      remote,
      createdAt: now,
      lastActivityAt: now,
      expiresAt,
    });
    this.setState({
      provisioned: true,
      repoName,
      remote,
      backend: "artifacts",
      expiresAt,
      head,
      dreamScheduleId: null,
      purgeScheduleId: null,
      lastDreamAt: 0,
    });
    try {
      await this.armPurge(expiresAt);
      await this.armDream();
    } catch (err) {
      console.error(JSON.stringify({ event: "schedule_failed", error: String(err).slice(0, 180) }));
      await this.wipe();
      return { ok: false, code: "schedule", message: "The expiry alarm could not be set, so the repo was not kept." };
    }
    return { ok: true, repoName, remote, head, expiresAt: this.state.expiresAt, threadId: this.threadId() };
  }

  @callable()
  async recall(query: string): Promise<RecallHit[]> {
    if (!this.state.provisioned) return [];
    return searchMemory(this.fts(), query, 5).filter(
      (hit) => !hit.snippet.includes("Nothing here yet") && !hit.snippet.includes("Nothing remembered yet"),
    );
  }

  @callable()
  async memoryIndex(): Promise<string> {
    return this.fileMap()["MEMORY.md"] ?? "";
  }

  @callable()
  async noteSummary(summary: string): Promise<void> {
    if (!this.state.provisioned) return;
    this.addSummary(summary);
  }

  @callable()
  async touchActivity(): Promise<void> {
    if (!this.state.provisioned) return;
    await this.touch();
  }

  @callable()
  async commitWrites(input: { writes: MemoryWrite[]; summary: string }): Promise<CommitWriteResult> {
    if (!this.state.provisioned) return { ok: false, code: "not_ready", message: "Open a memory repo first." };
    const writes = Array.isArray(input.writes) ? input.writes.slice(0, 6) : [];
    const date = new Date().toISOString().slice(0, 10);
    const next = applyMemoryWrites(this.fileMap(), writes, date);
    if (!next.changed) {
      if (input.summary) this.addSummary(input.summary);
      return {
        ok: true,
        committed: false,
        commitHash: null,
        commitMessage: null,
        paths: [],
        reason: "Those facts are already in the files.",
      };
    }
    try {
      const hash = await this.push(next.files, next.message);
      replaceIndexedFiles(this.fts(), next.files, Date.now());
      this.setState({ ...this.state, head: hash });
      this.addSummary(input.summary || next.message);
      await this.touch();
      return {
        ok: true,
        committed: true,
        commitHash: hash,
        commitMessage: next.message,
        paths: next.added.map((write) => write.path),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "The memory commit failed.";
      return { ok: false, code: "commit", message };
    }
  }

  @callable()
  async runDream(trigger: "alarm" | "now"): Promise<DreamView> {
    return this.executeDream(trigger);
  }

  /** Alarm callback. Skips the model when no new summaries have arrived since the last dream. */
  async dreamAlarm(): Promise<void> {
    try {
      if (this.state.provisioned && this.pendingSummaries() > 0) await this.executeDream("alarm");
    } catch (err) {
      console.error(JSON.stringify({ event: "dream_alarm_failed", error: String(err).slice(0, 180) }));
    } finally {
      if (this.state.provisioned) {
        try {
          await this.armDream();
        } catch (err) {
          console.error(JSON.stringify({ event: "dream_rearm_failed", error: String(err).slice(0, 180) }));
        }
      }
    }
  }

  /** Alarm callback. A newer write pushes expiresAt forward, and this stale callback no-ops. */
  async purgeExpired(): Promise<void> {
    if (!this.state.provisioned) return;
    if (this.state.expiresAt > Date.now() + 30_000) return;
    await this.wipe();
  }

  @callable()
  async forcePurge(): Promise<void> {
    if (!this.state.provisioned) {
      await deleteVisitor(this.env, this.name);
      return;
    }
    await this.wipe();
  }

  @callable()
  async snapshot(): Promise<Snapshot> {
    if (!this.state.provisioned) throw new Error("Open a memory repo first.");
    const files = this.fileMap();
    const commits = this.state.backend === "local" ? this.localLog() : await this.artifactLog();
    return {
      expiresAt: this.state.expiresAt,
      remote: this.state.remote,
      repoName: this.state.repoName,
      local: this.state.backend === "local",
      files: MEMORY_PATHS.map((path) => ({ path, body: files[path] ?? "" })),
      commits,
      dream: this.latestDream(),
    };
  }

  private async artifactLog(): Promise<Snapshot["commits"]> {
    const artifacts = artifactsBinding(this.env);
    if (!artifacts) throw new Error("Artifacts is not available.");
    return withRepo(artifacts, this.state.repoName, async (repo) => asCommits(await repo.log({ ref: "main", limit: 30 })).map(toSummary));
  }

  @callable()
  async diff(hash: string): Promise<CommitDetail> {
    if (!/^[a-f0-9]{40}$/.test(hash)) throw new Error("That commit hash is invalid.");
    if (!this.state.provisioned) throw new Error("Open a memory repo first.");
    if (this.state.backend === "local") return this.localDiff(hash);
    const artifacts = artifactsBinding(this.env);
    if (!artifacts) throw new Error("Artifacts is not available.");
    return withRepo(artifacts, this.state.repoName, async (repo) => {
      const commit = asCommits([await repo.readCommit(hash)])[0];
      if (!commit) throw new Error("That commit is not in this repo.");
      const parent = commit.parents[0] ?? null;
      const after = await readFilesAt(repo, hash);
      const before = parent ? await readFilesAt(repo, parent) : new Map<string, string>();
      return {
        hash,
        message: commit.message.replace(/\n[\s\S]*$/, "").trim(),
        parent,
        files: changedFiles(before, after),
      };
    });
  }

  private async executeDream(trigger: "alarm" | "now"): Promise<DreamView> {
    if (!this.state.provisioned) {
      return this.recordDream({
        status: "skipped",
        reason: "Open a memory repo first.",
        commitHash: null,
        message: null,
        steps: [],
      });
    }
    const cap = dreamsPerHour(this.env);
    const steps: DreamStep[] = [];
    if (this.dreamsThisHour() >= cap) {
      steps.push({ label: "Cap", detail: `${cap} dreams already ran in the last hour.` });
      return this.recordDream({
        status: "skipped",
        reason: `Dream cap is ${cap} per hour, so nothing was committed.`,
        commitHash: null,
        message: null,
        steps,
      });
    }
    const files = this.fileMap();
    steps.push({ label: "Read memory files", detail: MEMORY_PATHS.join(", ") });
    const summaries = this.recentSummaries();
    steps.push({
      label: "Read conversation summaries",
      detail: summaries.length ? summaries.slice(-3).join(" · ").slice(0, 220) : "None yet",
    });
    let parsed: Awaited<ReturnType<typeof completeDream>>;
    try {
      parsed = await completeDream(this.env, { files, summaries }, files);
      steps.push({ label: "Ask Workers AI to consolidate", detail: parsed.ok ? parsed.why : parsed.reason });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Workers AI failed";
      steps.push({ label: "Ask Workers AI to consolidate", detail });
      const dream = this.recordDream({
        status: "skipped",
        reason: `${detail} Nothing was committed.`,
        commitHash: null,
        message: null,
        steps,
      });
      return dream;
    }
    if (!parsed.ok) {
      if (trigger === "alarm" && parsed.reason.includes("match the current")) {
        this.setState({ ...this.state, lastDreamAt: Date.now() });
      }
      steps.push({ label: "Skip", detail: "Nothing was committed." });
      return this.recordDream({ status: "skipped", reason: parsed.reason, commitHash: null, message: null, steps });
    }
    const checked = parseDream(JSON.stringify({ message: parsed.message, why: parsed.why, files: parsed.files }), files);
    if (!checked.ok) {
      steps.push({ label: "Skip", detail: checked.reason });
      return this.recordDream({ status: "skipped", reason: checked.reason, commitHash: null, message: null, steps });
    }
    try {
      const hash = await this.push(checked.files, checked.message);
      replaceIndexedFiles(this.fts(), checked.files, Date.now());
      this.setState({ ...this.state, head: hash, lastDreamAt: Date.now() });
      steps.push({ label: "Commit", detail: `${hash.slice(0, 7)} ${checked.message}` });
      await this.touch();
      return this.recordDream({
        status: "committed",
        reason: checked.why,
        commitHash: hash,
        message: checked.message,
        steps,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "The commit failed";
      steps.push({ label: "Commit failed", detail });
      return this.recordDream({
        status: "skipped",
        reason: `${detail} Nothing was committed.`,
        commitHash: null,
        message: null,
        steps,
      });
    }
  }

  private async push(files: Record<string, string>, message: string): Promise<string> {
    if (this.state.backend === "local") return this.writeLocalCommit(files, message, this.state.head);
    const artifacts = artifactsBinding(this.env);
    if (!artifacts) throw new Error("Artifacts is not available.");
    const parent = await withRepo(artifacts, this.state.repoName, async (repo) => (await headCommit(repo))?.hash ?? null);
    const minted = await withRepo(artifacts, this.state.repoName, (repo) => repo.createToken("write", 120));
    const token = tokenPlaintext(minted);
    try {
      return await commitFiles({
        artifacts,
        repoName: this.state.repoName,
        remote: this.state.remote,
        token,
        parent,
        files,
        message,
      });
    } finally {
      await revokeQuiet(artifacts, this.state.repoName, token);
    }
  }

  private addSummary(summary: string): void {
    const text = summary.replace(/\s+/g, " ").trim().slice(0, 240);
    if (!text) return;
    this.ctx.storage.sql.exec("INSERT INTO summaries (text, created_at) VALUES (?, ?)", text, Date.now());
    this.ctx.storage.sql.exec("DELETE FROM summaries WHERE id NOT IN (SELECT id FROM summaries ORDER BY id DESC LIMIT 20)");
  }

  private recentSummaries(): string[] {
    return this.ctx.storage.sql
      .exec<{ text: string }>("SELECT text FROM summaries ORDER BY id DESC LIMIT 12")
      .toArray()
      .map((row) => row.text)
      .reverse();
  }

  private pendingSummaries(): number {
    const row = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM summaries WHERE created_at > ?", this.state.lastDreamAt)
      .one();
    return row?.n ?? 0;
  }

  private dreamsThisHour(): number {
    const since = Date.now() - 60 * 60 * 1000;
    const row = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM dream_log WHERE created_at > ?", since).one();
    return row?.n ?? 0;
  }

  private recordDream(entry: {
    status: DreamView["status"];
    reason: string;
    commitHash: string | null;
    message: string | null;
    steps: DreamStep[];
  }): DreamView {
    const view: DreamView = {
      id: crypto.randomUUID(),
      status: entry.status,
      reason: entry.reason.slice(0, 400),
      commitHash: entry.commitHash,
      message: entry.message,
      steps: entry.steps,
      createdAt: Date.now(),
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO dream_log (id, status, reason, commit_hash, message, steps, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      view.id,
      view.status,
      view.reason,
      view.commitHash,
      view.message,
      JSON.stringify(view.steps),
      view.createdAt,
    );
    return view;
  }

  private latestDream(): DreamView | null {
    const row = this.ctx.storage.sql
      .exec<{ id: string; status: string; reason: string; commit_hash: string | null; message: string | null; steps: string; created_at: number }>(
        "SELECT id, status, reason, commit_hash, message, steps, created_at FROM dream_log ORDER BY created_at DESC LIMIT 1",
      )
      .toArray()[0];
    if (!row || (row.status !== "committed" && row.status !== "skipped")) return null;
    return {
      id: row.id,
      status: row.status,
      reason: row.reason,
      commitHash: row.commit_hash,
      message: row.message,
      steps: parseSteps(row.steps),
      createdAt: row.created_at,
    };
  }

  private async armPurge(expiresAt: number): Promise<void> {
    const previous = this.state.purgeScheduleId;
    if (previous) {
      try {
        await this.cancelSchedule(previous);
      } catch {
        /* the previous alarm already fired */
      }
    }
    const delay = Math.max(60, Math.ceil((expiresAt - Date.now()) / 1000));
    const scheduled = await this.schedule(delay, "purgeExpired", { at: expiresAt });
    this.setState({ ...this.state, purgeScheduleId: scheduled.id, expiresAt });
  }

  private async armDream(): Promise<void> {
    const previous = this.state.dreamScheduleId;
    if (previous) {
      try {
        await this.cancelSchedule(previous);
      } catch {
        /* the previous alarm already fired */
      }
    }
    const scheduled = await this.schedule(dreamIntervalSeconds(this.env), "dreamAlarm", {});
    this.setState({ ...this.state, dreamScheduleId: scheduled.id });
  }

  private async touch(): Promise<void> {
    const now = Date.now();
    const expiresAt = now + ttlMs(this.env);
    await touchVisitor(this.env, this.name, now, expiresAt);
    await this.armPurge(expiresAt);
  }

  private async wipe(): Promise<void> {
    const repoName = this.state.repoName;
    if (repoName && this.state.backend !== "local") {
      const artifacts = artifactsBinding(this.env);
      if (artifacts) {
        try {
          await artifacts.delete(repoName);
        } catch (err) {
          const message = String(err);
          if (!/not found|404/i.test(message)) throw err;
        }
      }
    }
    await deleteVisitor(this.env, this.name);
    this.ctx.storage.sql.exec("DELETE FROM files");
    this.ctx.storage.sql.exec("DELETE FROM memory_fts");
    this.ctx.storage.sql.exec("DELETE FROM summaries");
    this.ctx.storage.sql.exec("DELETE FROM dream_log");
    this.ctx.storage.sql.exec("DELETE FROM local_commits");
    this.setState({ ...EMPTY });
  }
}
