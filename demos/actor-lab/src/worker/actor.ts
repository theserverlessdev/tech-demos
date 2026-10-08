import { DurableObject } from "cloudflare:workers";
import { ACTOR_TTL_MS } from "../shared/types";

/**
 * Small actor base inspired by durable-actors ergonomics, on a SQLite Durable Object.
 * `state` writes through to SQLite on assignment. Handlers that go through `mailbox`
 * run one at a time, including across a non-storage await.
 */
export abstract class Actor<T extends object> extends DurableObject<Env> {
  state!: T;
  /** Resolves when every handler already queued has finished. */
  #tail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The async callback must yield once so subclass field initializers run
    // before afterLoad touches them. blockConcurrencyWhile still holds the
    // input gate shut across that yield, so no request sees a half-loaded actor.
    ctx.blockConcurrencyWhile(async () => {
      await scheduler.wait(0);
      this.#ensureKv();
      this.migrate();
      this.state = this.#proxied(this.#hydrate());
      this.afterLoad();
      await this.ctx.storage.setAlarm(Date.now() + this.ttlMs());
    });
  }

  protected abstract initial(): T;
  /** Extra tables. Runs inside the load gate, before `state` exists. */
  protected migrate(): void {}
  /** Called after each load. Subclasses normalize fields and set ephemeral labels. */
  protected afterLoad(): void {}
  protected beforeExpire(): void {}
  protected clearExtra(): void {}
  protected touchedAt(): number {
    return 0;
  }
  protected ttlMs(): number {
    return ACTOR_TTL_MS;
  }

  /**
   * Next handler starts only after `task` finishes, including across Workers AI.
   * A non-storage await opens the input gate; without this queue those handlers
   * would read the same in-memory fields before the first write.
   */
  protected mailbox<R>(task: () => Promise<R>): Promise<R> {
    const previous = this.#tail;
    let release: () => void = () => {};
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(task).finally(release);
  }

  /** Drop the in-memory proxy and read SQLite again, the way a fresh isolate would. */
  protected reloadState(): void {
    this.state = this.#proxied(this.#hydrate());
    this.afterLoad();
  }

  async alarm(): Promise<void> {
    const touched = this.touchedAt();
    const age = touched === 0 ? this.ttlMs() : Date.now() - touched;
    if (age < this.ttlMs()) {
      await this.ctx.storage.setAlarm(Date.now() + (this.ttlMs() - age));
      return;
    }
    this.beforeExpire();
    this.ctx.storage.sql.exec("DELETE FROM kv");
    this.clearExtra();
    this.state = this.#proxied(this.initial());
    this.afterLoad();
    console.log(JSON.stringify({ event: "actor_expired", actor: this.constructor.name }));
  }

  #ensureKv(): void {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  #hydrate(): T {
    const next = this.initial();
    const saved = new Map<string, unknown>();
    for (const row of this.ctx.storage.sql.exec<{ key: string; value: string }>("SELECT key, value FROM kv").toArray()) {
      try {
        saved.set(row.key, JSON.parse(row.value) as unknown);
      } catch {
        // A corrupt cell keeps the initial value for that key.
      }
    }
    const target = next as Record<string, unknown>;
    for (const key of Object.keys(target)) {
      if (!saved.has(key)) continue;
      const value = saved.get(key);
      if (value !== undefined) target[key] = value;
    }
    return next;
  }

  #proxied(data: T): T {
    const storage = this.ctx.storage;
    return new Proxy(data, {
      set(target, prop, value) {
        if (typeof prop !== "string") return false;
        (target as Record<string, unknown>)[prop] = value;
        // Each assignment flushes immediately. Upstream commits @Persisted at the
        // end of a successful call; this slice keeps the write on the assignment
        // so a lost update is visible in SQLite as soon as the handler returns.
        storage.sql.exec(
          "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          prop,
          JSON.stringify(value),
        );
        return true;
      },
    });
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
