export const DEFAULT_INSTANCE = "tech-demos-hub-docs";

export type Chunk = { source: string; score: number; snippet: string };

const SNIPPET = 420;

export function sourceName(raw: string): string {
  const parts = raw.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  return parts[0] || "document";
}

export function snippetOf(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= SNIPPET) return clean;
  return `${clean.slice(0, SNIPPET - 1)}…`;
}

export function chunksFromSearchPayload(payload: unknown): Chunk[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as { data?: unknown; chunks?: unknown };
  if (Array.isArray(record.data)) {
    return record.data.map((item) => {
      const row = item as { filename?: string; score?: number; content?: { text?: string }[] };
      const text = (row.content ?? []).map((part) => part.text ?? "").join(" ");
      return {
        source: sourceName(String(row.filename ?? "document")),
        score: Number(row.score ?? 0),
        snippet: snippetOf(text),
      };
    });
  }
  if (Array.isArray(record.chunks)) {
    return record.chunks.map((item) => {
      const row = item as { score?: number; text?: string; item?: { key?: string } };
      return {
        source: sourceName(String(row.item?.key ?? "document")),
        score: Number(row.score ?? 0),
        snippet: snippetOf(String(row.text ?? "")),
      };
    });
  }
  return [];
}

type SearchInstance = {
  info?: () => Promise<unknown>;
  search: (params: {
    query: string;
    ai_search_options?: { retrieval?: { max_num_results?: number } };
  }) => Promise<unknown>;
  chatCompletions: (params: {
    messages: { role: string; content: string }[];
    stream: true;
  }) => Promise<Response | ReadableStream>;
};

export type SearchEnv = {
  AI_SEARCH?: { get: (name: string) => SearchInstance };
  AI_SEARCH_INSTANCE?: string;
};

export function instanceName(env: SearchEnv): string {
  const name = env.AI_SEARCH_INSTANCE?.trim();
  return name || DEFAULT_INSTANCE;
}

export function searchConfigured(env: SearchEnv): boolean {
  return typeof env.AI_SEARCH?.get === "function";
}

export const HEALTH_TTL_MS = 60_000;

export type HealthCache = { at: number; ok: boolean } | null;

/** One isolate remembers the last probe so the gallery does not ask on every page view. */
const healthSlot: { current: HealthCache } = { current: null };

async function instanceAnswers(env: SearchEnv): Promise<boolean> {
  if (!env.AI_SEARCH?.get) return false;
  const instance = env.AI_SEARCH.get(instanceName(env));
  try {
    if (typeof instance.info === "function") {
      await instance.info();
      return true;
    }
    await instance.search({
      query: "health",
      ai_search_options: { retrieval: { max_num_results: 1 } },
    });
    return true;
  } catch {
    return false;
  }
}

/** True when the named instance exists and answers. The result is reused for 60 seconds. */
export async function confirmSearch(env: SearchEnv, now: number, slot: { current: HealthCache }): Promise<boolean> {
  const cached = slot.current;
  if (cached && now - cached.at < HEALTH_TTL_MS) return cached.ok;
  const ok = await instanceAnswers(env);
  slot.current = { at: now, ok };
  return ok;
}

export function cachedSearchHealth(env: SearchEnv, now = Date.now()): Promise<boolean> {
  return confirmSearch(env, now, healthSlot);
}

function asResponse(stream: Response | ReadableStream): Response {
  if (stream instanceof Response) return stream;
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

export function createSearch(env: SearchEnv): {
  search: (query: string) => Promise<Chunk[]>;
  aiSearch: (query: string) => Promise<Response>;
} {
  const name = instanceName(env);
  return {
    async search(query) {
      if (!env.AI_SEARCH?.get) throw new Error("search_unconfigured");
      const payload = await env.AI_SEARCH.get(name).search({
        query,
        ai_search_options: { retrieval: { max_num_results: 6 } },
      });
      return chunksFromSearchPayload(payload);
    },
    async aiSearch(query) {
      if (!env.AI_SEARCH?.get) throw new Error("search_unconfigured");
      const stream = await env.AI_SEARCH.get(name).chatCompletions({
        stream: true,
        messages: [{ role: "user", content: query }],
      });
      return asResponse(stream);
    },
  };
}
