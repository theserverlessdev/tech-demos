import type { Post, SimilarHit, SimilarResult } from "../shared/types";
import { isStatus } from "../shared/types";
import { getPostsByIds, listForSimilarity, listSeedPosts } from "./db";
import { EMBED_CHARS, EMBED_MODEL_ID, SIMILAR_MIN_CHARS, VECTOR_DIMS } from "./limits";

const STOP = new Set("the a an and or of to in on at for is are was be it this that with from your you our we they their not but".split(" "));

let seedAttemptAt = 0;

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) {
    if (!STOP.has(raw)) out.add(raw);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const token of a) if (b.has(token)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function embedModel(env: Env): typeof EMBED_MODEL_ID {
  if (env.EMBED_MODEL !== EMBED_MODEL_ID) {
    throw new Error("EMBED_MODEL must stay on bge-small-en-v1.5. The Vectorize index is 384 dimensions.");
  }
  return EMBED_MODEL_ID;
}

function vectorFrom(out: unknown): number[] | null {
  if (!out || typeof out !== "object") return null;
  const data = (out as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const row = Array.isArray(data[0]) ? data[0] : data;
  if (row.length !== VECTOR_DIMS || !row.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return row as number[];
}

export async function embed(env: Env, text: string): Promise<number[] | null> {
  const input = text.replace(/\s+/g, " ").trim().slice(0, EMBED_CHARS);
  if (input.length < SIMILAR_MIN_CHARS) return null;
  try {
    const out: unknown = await env.AI.run(embedModel(env), { text: [input] });
    const values = vectorFrom(out);
    if (!values) console.warn(JSON.stringify({ event: "embed_unparsed" }));
    return values;
  } catch (err) {
    console.warn(JSON.stringify({ event: "embed_failed", error: String(err) }));
    return null;
  }
}

export async function indexPost(env: Env, post: { id: string; title: string; body: string }): Promise<void> {
  const values = await embed(env, `${post.title}\n${post.body}`);
  if (!values) return;
  await env.VECTORS.upsert([{ id: post.id, values }]);
}

export function indexPostLater(ctx: ExecutionContext, env: Env, post: { id: string; title: string; body: string }): void {
  ctx.waitUntil(
    indexPost(env, post).catch((err: unknown) => {
      console.error(JSON.stringify({ event: "vector_index_failed", postId: post.id, error: String(err) }));
    }),
  );
}

/** Retry seed indexing until Vectorize accepts it. Local dev has no Vectorize simulation, so this stays quiet. */
export function indexSeedsLater(ctx: ExecutionContext, env: Env): void {
  ctx.waitUntil(indexSeedPostsQuiet(env));
}

export async function indexSeedPostsQuiet(env: Env): Promise<void> {
  const now = Date.now();
  if (now - seedAttemptAt < 60_000) return;
  seedAttemptAt = now;
  const flag = await env.DB.prepare("SELECT value FROM meta WHERE key = 'vectors_seeded'").first<{ value: string }>();
  if (flag?.value === "1") return;
  try {
    const posts = await listSeedPosts(env);
    if (posts.length === 0) return;
    for (const post of posts) await indexPost(env, post);
    await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('vectors_seeded', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
  } catch (err) {
    console.warn(JSON.stringify({ event: "seed_index_failed", error: String(err) }));
  }
}

function lexical(posts: { id: string; title: string; body: string; status: Post["status"] }[], query: string): SimilarHit[] {
  const queryTokens = tokens(query);
  const hits: SimilarHit[] = [];
  for (const post of posts) {
    const titleScore = jaccard(queryTokens, tokens(post.title));
    const allScore = jaccard(queryTokens, tokens(`${post.title} ${post.body}`));
    const score = Math.max(titleScore, allScore);
    if (score < 0.22) continue;
    hits.push({
      id: post.id,
      title: post.title,
      status: post.status,
      score: Number(score.toFixed(3)),
      kind: score >= 0.5 ? "duplicate" : "related",
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, 4);
}

export async function findSimilar(env: Env, visitorId: string, query: string, now: number): Promise<SimilarResult> {
  const trimmed = query.replace(/\s+/g, " ").trim();
  if (trimmed.length < SIMILAR_MIN_CHARS) return { similar: [], source: "skipped" };

  const values = await embed(env, trimmed);
  if (values) {
    try {
      const matches = await env.VECTORS.query(values, { topK: 8, returnMetadata: "none" });
      const ranked = matches.matches.filter((match) => match.score >= 0.55);
      const posts = await getPostsByIds(
        env,
        ranked.map((match) => match.id),
        visitorId,
        now,
      );
      const byId = new Map(posts.map((post) => [post.id, post]));
      const similar: SimilarHit[] = [];
      for (const match of ranked) {
        const post = byId.get(match.id);
        if (!post || !isStatus(post.status)) continue;
        similar.push({
          id: post.id,
          title: post.title,
          status: post.status,
          score: Number(match.score.toFixed(3)),
          kind: match.score >= 0.78 ? "duplicate" : "related",
        });
      }
      if (similar.length > 0) return { similar: similar.slice(0, 4), source: "vectorize" };
      return { similar: [], source: "vectorize" };
    } catch (err) {
      console.warn(JSON.stringify({ event: "vector_query_failed", error: String(err) }));
    }
  }

  // Vectorize has no local simulation, and Workers AI needs an account. Word overlap keeps the board usable.
  const posts = await listForSimilarity(env, now);
  return { similar: lexical(posts, trimmed), source: "lexical" };
}
