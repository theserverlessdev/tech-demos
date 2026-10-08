import type { ChangelogEntry, Post, PostStatus } from "../shared/types";
import { isStatus } from "../shared/types";
import { HttpError } from "./http";
import { MAX_POSTS } from "./limits";

type PostRow = {
  id: string;
  title: string;
  body: string;
  status: string;
  votes: number;
  display_name: string;
  image_key: string | null;
  image_type: string | null;
  seeded: number;
  created_at: number;
  expires_at: number | null;
};

type ChangelogRow = {
  id: string;
  title: string;
  body: string;
  published_at: number;
  seeded: number;
};

const VISIBLE = "(expires_at IS NULL OR expires_at > ?)";

function toPost(row: PostRow, voted: boolean): Post | null {
  if (!isStatus(row.status)) return null;
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    votes: row.votes,
    displayName: row.display_name,
    hasImage: Boolean(row.image_key),
    seeded: row.seeded === 1,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    voted,
  };
}

function toEntry(row: ChangelogRow): ChangelogEntry {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    publishedAt: row.published_at,
    seeded: row.seeded === 1,
  };
}

async function votedSet(env: Env, visitorId: string): Promise<Set<string>> {
  const rows = await env.DB.prepare("SELECT post_id FROM votes WHERE visitor_id = ?").bind(visitorId).all<{ post_id: string }>();
  return new Set(rows.results.map((row) => row.post_id));
}

export async function countVisiblePosts(env: Env, now: number): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM posts WHERE ${VISIBLE}`).bind(now).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function countChangelog(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM changelog").first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function listPosts(
  env: Env,
  visitorId: string,
  now: number,
  status: PostStatus | null,
  sort: "top" | "new",
): Promise<Post[]> {
  const order = sort === "new" ? "created_at DESC" : "votes DESC, created_at DESC";
  const voted = await votedSet(env, visitorId);
  const query = status
    ? env.DB.prepare(`SELECT * FROM posts WHERE ${VISIBLE} AND status = ? ORDER BY ${order} LIMIT 80`).bind(now, status)
    : env.DB.prepare(`SELECT * FROM posts WHERE ${VISIBLE} ORDER BY ${order} LIMIT 80`).bind(now);
  const rows = await query.all<PostRow>();
  return rows.results.flatMap((row) => {
    const post = toPost(row, voted.has(row.id));
    return post ? [post] : [];
  });
}

export async function getPost(env: Env, id: string, visitorId: string, now: number): Promise<Post | null> {
  const row = await env.DB.prepare(`SELECT * FROM posts WHERE id = ? AND ${VISIBLE}`).bind(id, now).first<PostRow>();
  if (!row) return null;
  const vote = await env.DB.prepare("SELECT 1 AS ok FROM votes WHERE post_id = ? AND visitor_id = ?").bind(id, visitorId).first();
  return toPost(row, Boolean(vote));
}

export async function getPostsByIds(env: Env, ids: string[], visitorId: string, now: number): Promise<Post[]> {
  const safe = ids.filter((id) => /^post_[a-z0-9_]{4,40}$/.test(id));
  if (safe.length === 0) return [];
  const voted = await votedSet(env, visitorId);
  const marks = safe.map(() => "?").join(", ");
  const rows = await env.DB.prepare(`SELECT * FROM posts WHERE id IN (${marks}) AND ${VISIBLE}`)
    .bind(...safe, now)
    .all<PostRow>();
  return rows.results.flatMap((row) => {
    const post = toPost(row, voted.has(row.id));
    return post ? [post] : [];
  });
}

export async function listForSimilarity(env: Env, now: number): Promise<Pick<Post, "id" | "title" | "body" | "status">[]> {
  const rows = await env.DB.prepare(`SELECT id, title, body, status FROM posts WHERE ${VISIBLE} ORDER BY votes DESC LIMIT 80`)
    .bind(now)
    .all<Pick<PostRow, "id" | "title" | "body" | "status">>();
  return rows.results.flatMap((row) => (isStatus(row.status) ? [{ id: row.id, title: row.title, body: row.body, status: row.status }] : []));
}

export type NewPost = {
  id: string;
  title: string;
  body: string;
  displayName: string;
  visitorId: string;
  now: number;
  expiresAt: number;
  imageKey: string | null;
  imageType: string | null;
};

export async function insertPost(env: Env, post: NewPost): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO posts (id, title, body, status, votes, display_name, visitor_id, image_key, image_type, seeded, created_at, expires_at)
     VALUES (?, ?, ?, 'open', 0, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(post.id, post.title, post.body, post.displayName, post.visitorId, post.imageKey, post.imageType, post.now, post.expiresAt)
    .run();
}

async function deleteOne(env: Env, id: string, imageKey: string | null): Promise<void> {
  if (imageKey) {
    try {
      await env.IMAGES.delete(imageKey);
    } catch (err) {
      console.error(JSON.stringify({ event: "image_delete_failed", postId: id, error: String(err) }));
    }
  }
  try {
    await env.VECTORS.deleteByIds([id]);
  } catch (err) {
    console.error(JSON.stringify({ event: "vector_delete_failed", postId: id, error: String(err) }));
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM votes WHERE post_id = ?").bind(id),
    env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id),
  ]);
}

/** Drop the oldest visitor post when the board is at the cap. Seeded rows stay. */
export async function evictIfFull(env: Env, now: number): Promise<void> {
  let guard = 0;
  while ((await countVisiblePosts(env, now)) >= MAX_POSTS) {
    if (guard++ > 5) throw new HttpError(409, "board_full", "The board is full. Try again after older posts expire.");
    const row = await env.DB.prepare(
      `SELECT id, image_key FROM posts WHERE seeded = 0 AND ${VISIBLE} ORDER BY created_at ASC LIMIT 1`,
    )
      .bind(now)
      .first<{ id: string; image_key: string | null }>();
    if (!row) throw new HttpError(409, "board_full", "The board is full. Try again after older posts expire.");
    await deleteOne(env, row.id, row.image_key);
  }
}

export async function cleanupExpired(env: Env, now: number): Promise<{ deletedPosts: number }> {
  let deletedPosts = 0;
  for (let batch = 0; batch < 5; batch++) {
    const rows = await env.DB.prepare(
      "SELECT id, image_key FROM posts WHERE seeded = 0 AND expires_at IS NOT NULL AND expires_at <= ? LIMIT 40",
    )
      .bind(now)
      .all<{ id: string; image_key: string | null }>();
    if (rows.results.length === 0) break;
    for (const row of rows.results) {
      await deleteOne(env, row.id, row.image_key);
      deletedPosts++;
    }
  }
  return { deletedPosts };
}

export async function toggleVote(env: Env, postId: string, visitorId: string, now: number): Promise<{ votes: number; voted: boolean } | null> {
  const existing = await env.DB.prepare("SELECT 1 AS ok FROM posts WHERE id = ? AND " + VISIBLE)
    .bind(postId, now)
    .first();
  if (!existing) return null;
  const vote = await env.DB.prepare("SELECT 1 AS ok FROM votes WHERE post_id = ? AND visitor_id = ?").bind(postId, visitorId).first();
  if (vote) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM votes WHERE post_id = ? AND visitor_id = ?").bind(postId, visitorId),
      env.DB.prepare("UPDATE posts SET votes = MAX(votes - 1, 0) WHERE id = ?").bind(postId),
    ]);
  } else {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO votes (post_id, visitor_id, created_at) VALUES (?, ?, ?)").bind(postId, visitorId, now),
      env.DB.prepare("UPDATE posts SET votes = votes + 1 WHERE id = ?").bind(postId),
    ]);
  }
  const row = await env.DB.prepare("SELECT votes FROM posts WHERE id = ?").bind(postId).first<{ votes: number }>();
  if (!row) return null;
  return { votes: row.votes, voted: !vote };
}

export async function setStatus(env: Env, id: string, status: PostStatus, now: number): Promise<boolean> {
  const updated = await env.DB.prepare(`UPDATE posts SET status = ? WHERE id = ? AND ${VISIBLE}`).bind(status, id, now).run();
  return (updated.meta.changes ?? 0) > 0;
}

export async function listChangelog(env: Env): Promise<ChangelogEntry[]> {
  const rows = await env.DB.prepare("SELECT * FROM changelog ORDER BY published_at DESC LIMIT 50").all<ChangelogRow>();
  return rows.results.map(toEntry);
}

export async function insertChangelog(env: Env, entry: ChangelogEntry): Promise<void> {
  await env.DB.prepare("INSERT INTO changelog (id, title, body, published_at, seeded) VALUES (?, ?, ?, ?, 0)")
    .bind(entry.id, entry.title, entry.body, entry.publishedAt)
    .run();
}

export async function getImage(env: Env, id: string, now: number): Promise<{ key: string; type: string } | null> {
  const row = await env.DB.prepare(`SELECT image_key, image_type FROM posts WHERE id = ? AND ${VISIBLE}`)
    .bind(id, now)
    .first<{ image_key: string | null; image_type: string | null }>();
  if (!row?.image_key || !row.image_type) return null;
  return { key: row.image_key, type: row.image_type };
}

export async function listSeedPosts(env: Env): Promise<{ id: string; title: string; body: string }[]> {
  const rows = await env.DB.prepare("SELECT id, title, body FROM posts WHERE seeded = 1").all<{ id: string; title: string; body: string }>();
  return rows.results;
}
