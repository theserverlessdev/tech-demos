import { DurableObject } from "cloudflare:workers";
import { limits, sessions, type BrowserWorker } from "@cloudflare/puppeteer";
import { LIMITS } from "../shared/limits";

export type SessionPlan =
  | { ok: true; action: "connect"; sessionId: string; note: string }
  | { ok: true; action: "launch"; replace: boolean; note: string }
  | { ok: true; action: "stub"; note: string }
  | { ok: false; message: string };

type Stored = {
  sessionId: string;
  startedAt: number;
  uses: number;
  inflight: number;
};

export function browserEndpoint(binding: Env["BROWSER"] | undefined): BrowserWorker | null {
  if (!binding || typeof binding.fetch !== "function") return null;
  return { fetch: binding.fetch.bind(binding) };
}

/**
 * One object for the demo pool. It remembers a Browser Rendering session id and
 * the limits around it. The browser itself stays warm because launch uses keep_alive
 * and callers disconnect instead of closing.
 */
export class BrowserSession extends DurableObject<Env> {
  async acquire(visitorId: string): Promise<SessionPlan> {
    const key = visitorId || "anon";
    const rate = await this.env.SESSION_LIMIT.limit({ key });
    if (!rate.success) return { ok: false, message: "Too many browser steps from this browser. Wait a minute." };

    const environment: string = this.env.ENVIRONMENT;
    const browser = browserEndpoint(this.env.BROWSER);
    if (environment === "local" || !browser) {
      return {
        ok: true,
        action: "stub",
        note: "Local stand-in. Browser Rendering needs a Cloudflare login, so this capture did not launch Chrome.",
      };
    }

    const stored = await this.ctx.storage.get<Stored>("session");
    let active: { sessionId: string }[] = [];
    try {
      active = await sessions(browser);
    } catch (err) {
      console.error(JSON.stringify({ event: "browser_sessions_failed", error: String(err).slice(0, 200) }));
      return { ok: true, action: "launch", replace: true, note: "The session list failed, so this step launches a fresh browser." };
    }

    const now = Date.now();
    const alive = Boolean(stored && active.some((session) => session.sessionId === stored.sessionId));
    const withinLimits = Boolean(stored && stored.uses < LIMITS.maxSessionUses && now - stored.startedAt < LIMITS.maxSessionAgeMs);
    if (alive && stored && withinLimits && stored.inflight < LIMITS.maxContexts) {
      const next: Stored = { ...stored, uses: stored.uses + 1, inflight: stored.inflight + 1 };
      await this.ctx.storage.put("session", next);
      return {
        ok: true,
        action: "connect",
        sessionId: stored.sessionId,
        note: `Reused warm session ${stored.sessionId.slice(0, 8)}. keep_alive is 5 minutes.`,
      };
    }

    if (alive && stored && stored.inflight >= LIMITS.maxContexts) {
      return {
        ok: true,
        action: "launch",
        replace: false,
        note: "The warm session is at its context limit, so this step launches a fresh browser.",
      };
    }

    try {
      const account = await limits(browser);
      if (account.allowedBrowserAcquisitions <= 0 && account.activeSessions.length >= account.maxConcurrentSessions) {
        return { ok: false, message: "Browser Rendering is at its concurrency cap. Try again in a minute." };
      }
    } catch (err) {
      console.error(JSON.stringify({ event: "browser_limits_failed", error: String(err).slice(0, 200) }));
    }

    const reason = alive ? "The warm session is over its age or use limit." : "No warm session is open.";
    return { ok: true, action: "launch", replace: true, note: `${reason} This step launches a fresh browser with keep_alive of 5 minutes.` };
  }

  async remember(sessionId: string): Promise<void> {
    const stored = await this.ctx.storage.get<Stored>("session");
    if (stored && stored.sessionId !== sessionId && stored.inflight > 0) return;
    await this.ctx.storage.put("session", { sessionId, startedAt: Date.now(), uses: 1, inflight: 1 });
  }

  async release(sessionId: string): Promise<void> {
    const stored = await this.ctx.storage.get<Stored>("session");
    if (!stored || stored.sessionId !== sessionId) return;
    await this.ctx.storage.put("session", { ...stored, inflight: Math.max(0, stored.inflight - 1) });
  }

  async forget(sessionId: string): Promise<void> {
    const stored = await this.ctx.storage.get<Stored>("session");
    if (stored?.sessionId === sessionId) await this.ctx.storage.delete("session");
  }
}
