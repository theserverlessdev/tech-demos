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

type SearchEnv = {
  AI?: {
    autorag: (instance: string) => {
      search: (params: { query: string; max_num_results?: number }) => Promise<unknown>;
      aiSearch: (params: { query: string; stream: true; max_num_results?: number }) => Promise<Response>;
    };
  };
  AI_SEARCH?: {
    get: (name: string) => {
      search: (params: { query: string }) => Promise<unknown>;
      chatCompletions: (params: {
        messages: { role: string; content: string }[];
        stream: true;
      }) => Promise<Response | ReadableStream>;
    };
  };
  AI_SEARCH_INSTANCE?: string;
};

export function instanceName(env: SearchEnv): string {
  const name = env.AI_SEARCH_INSTANCE?.trim();
  return name || DEFAULT_INSTANCE;
}

export function createSearch(env: SearchEnv): {
  search: (query: string) => Promise<Chunk[]>;
  aiSearch: (query: string) => Promise<Response>;
} {
  const name = instanceName(env);
  return {
    async search(query) {
      if (env.AI?.autorag) {
        const payload = await env.AI.autorag(name).search({ query, max_num_results: 6 });
        return chunksFromSearchPayload(payload);
      }
      if (env.AI_SEARCH?.get) {
        const payload = await env.AI_SEARCH.get(name).search({ query });
        return chunksFromSearchPayload(payload);
      }
      throw new Error("search_unconfigured");
    },
    async aiSearch(query) {
      if (env.AI?.autorag) {
        return env.AI.autorag(name).aiSearch({ query, stream: true, max_num_results: 6 });
      }
      if (env.AI_SEARCH?.get) {
        const stream = await env.AI_SEARCH.get(name).chatCompletions({
          stream: true,
          messages: [{ role: "user", content: query }],
        });
        if (stream instanceof Response) return stream;
        return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
      }
      throw new Error("search_unconfigured");
    },
  };
}
