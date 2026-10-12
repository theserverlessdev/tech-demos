import { DurableObject } from "cloudflare:workers";
import type { BrowserWorker } from "@cloudflare/puppeteer";

export function browserEndpoint(binding: Env["BROWSER"] | undefined): BrowserWorker | null {
  if (!binding || typeof binding.fetch !== "function") return null;
  return { fetch: binding.fetch.bind(binding) };
}

export type AcquireResult = { ok: true; stub: boolean } | { ok: false; message: string };

/**
 * Rate-limits session acquires for one visitor. It does not store an inflight
 * count. Reuse is decided from puppeteer.sessions() and Target.getBrowserContexts.
 */
export class BrowserSession extends DurableObject<Env> {
  async acquire(visitorId: string): Promise<AcquireResult> {
    const key = visitorId || "anon";
    const rate = await this.env.SESSION_LIMIT.limit({ key });
    if (!rate.success) return { ok: false, message: "Too many browser steps from this browser. Wait a minute." };

    const environment: string = this.env.ENVIRONMENT;
    if (environment === "local") return { ok: true, stub: true };
    if (!browserEndpoint(this.env.BROWSER)) {
      return { ok: false, message: "Browser Rendering is not bound to this Worker." };
    }
    return { ok: true, stub: false };
  }
}
