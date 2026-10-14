import type { ChangelogEntry, Post, PostStatus } from "../shared/types";
import { isStatus } from "../shared/types";
import { HttpError } from "./http";
import { GATE_CREATE_USES, GATE_SIMILAR_USES, GATE_TTL_SECONDS, MAX_POSTS, SEED_VOTE_TTL_MS } from "./limits";

type PostRow = {
  id: string;
  title: string;
  body: string;
  status: string;
  votes: number;
  display_name: string;
  visitor_id: string;
  image_key: string | null;
  image_type: string | null;
  image_approved: number;
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

function toPost(row: PostRow, voted: boolean, visitorId: string, revealPending: boolean): Post | null {
  if (!isStatus(row.status)) return null;
  const pending = Boolean(row.image_key) && row.image_approved !== 1;
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    votes: row.votes,
    displayName: row.display_name,
    hasImage: Boolean(row.image_key) && row.image_approved === 1,
    imagePending: pending && (revealPending || row.visitor_id === visitorId),
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

export async function countVisitorLivePosts(env: Env, visitorId: string, now: number): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM posts WHERE visitor_id = ? AND seeded = 0 AND ${VISIBLE}`)
    .bind(visitorId, now)
    .first<{ n: number }>();
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
  revealPending: boolean,
): Promise<Post[]> {
  const order = sort === "new" ? "created_at DESC" : "votes DESC, created_at DESC";
  const voted = await votedSet(env, visitorId);
  const query = status
    ? env.DB.prepare(`SELECT * FROM posts WHERE ${VISIBLE} AND status = ? ORDER BY ${order} LIMIT 80`).bind(now, status)
    : env.DB.prepare(`SELECT * FROM posts WHERE ${VISIBLE} ORDER BY ${order} LIMIT 80`).bind(now);
  const rows = await query.all<PostRow>();
  return rows.results.flatMap((row) => {
    const post = toPost(row, voted.has(row.id), visitorId, revealPending);
    return post ? [post] : [];
  });
}

export async function getPost(env: Env, id: string, visitorId: string, now: number, revealPending: boolean): Promise<Post | null> {
  const row = await env.DB.prepare(`SELECT * FROM posts WHERE id = ? AND ${VISIBLE}`).bind(id, now).first<PostRow>();
  if (!row) return null;
  const vote = await env.DB.prepare("SELECT 1 AS ok FROM votes WHERE post_id = ? AND visitor_id = ?").bind(id, visitorId).first();
  return toPost(row, Boolean(vote), visitorId, revealPending);
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
    const post = toPost(row, voted.has(row.id), visitorId, false);
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
    `INSERT INTO posts (id, title, body, status, votes, display_name, visitor_id, image_key, image_type, image_approved, seeded, created_at, expires_at)
     VALUES (?, ?, ?, 'open', 0, ?, ?, ?, ?, 0, 0, ?, ?)`,
  )
    .bind(post.id, post.title, post.body, post.displayName, post.visitorId, post.imageKey, post.imageType, post.now, post.expiresAt)
    .run();
  await evictOverflow(env, post.now);
}

async function rememberFailedDelete(env: Env, kind: "r2" | "vector", key: string): Promise<void> {
  try {
    await env.DB.prepare("INSERT OR IGNORE INTO pending_deletes (kind, key, created_at) VALUES (?, ?, ?)").bind(kind, key, Date.now()).run();
  } catch (err) {
    console.error(JSON.stringify({ event: "pending_delete_record_failed", kind, key, error: String(err) }));
  }
}

export async function deleteOne(env: Env, id: string, imageKey: string | null): Promise<void> {
  if (imageKey) {
    try {
      await env.IMAGES.delete(imageKey);
    } catch (err) {
      console.error(JSON.stringify({ event: "image_delete_failed", postId: id, error: String(err) }));
      await rememberFailedDelete(env, "r2", imageKey);
    }
  }
  try {
    await env.VECTORS.deleteByIds([id]);
  } catch (err) {
    console.error(JSON.stringify({ event: "vector_delete_failed", postId: id, error: String(err) }));
    await rememberFailedDelete(env, "vector", id);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM votes WHERE post_id = ?").bind(id),
    env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id),
  ]);
}

export async function deletePost(env: Env, id: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT image_key FROM posts WHERE id = ?").bind(id).first<{ image_key: string | null }>();
  if (!row) return false;
  await deleteOne(env, id, row.image_key);
  return true;
}

/** After insert, drop the oldest visitor posts until the board is back at the cap. */
export async function evictOverflow(env: Env, now: number): Promise<void> {
  const n = await countVisiblePosts(env, now);
  if (n <= MAX_POSTS) return;
  const extra = n - MAX_POSTS;
  const rows = await env.DB.prepare(`SELECT id, image_key FROM posts WHERE seeded = 0 AND ${VISIBLE} ORDER BY created_at ASC LIMIT ?`)
    .bind(now, extra)
    .all<{ id: string; image_key: string | null }>();
  if (rows.results.length === 0) throw new HttpError(409, "board_full", "The board is full. Try again after older posts expire.");
  for (const row of rows.results) await deleteOne(env, row.id, row.image_key);
}

export async function retryPendingDeletes(env: Env): Promise<number> {
  const rows = await env.DB.prepare("SELECT kind, key FROM pending_deletes LIMIT 40").all<{ kind: string; key: string }>();
  let cleared = 0;
  for (const row of rows.results) {
    try {
      if (row.kind === "r2") await env.IMAGES.delete(row.key);
      else if (row.kind === "vector") await env.VECTORS.deleteByIds([row.key]);
      else continue;
      await env.DB.prepare("DELETE FROM pending_deletes WHERE kind = ? AND key = ?").bind(row.kind, row.key).run();
      cleared++;
    } catch (err) {
      console.error(JSON.stringify({ event: "pending_delete_retry_failed", kind: row.kind, key: row.key, error: String(err) }));
    }
  }
  return cleared;
}

export async function sweepSeedVotes(env: Env, now: number): Promise<number> {
  const cutoff = now - SEED_VOTE_TTL_MS;
  const deleted = await env.DB.prepare(
    "DELETE FROM votes WHERE created_at < ? AND post_id IN (SELECT id FROM posts WHERE seeded = 1)",
  )
    .bind(cutoff)
    .run();
  await env.DB.prepare("UPDATE posts SET votes = (SELECT COUNT(*) FROM votes WHERE votes.post_id = posts.id) WHERE seeded = 1").run();
  return deleted.meta.changes ?? 0;
}

export async function sweepUsedGates(env: Env, now: number): Promise<number> {
  const deleted = await env.DB.prepare("DELETE FROM used_gates WHERE exp <= ?").bind(now).run();
  return deleted.meta.changes ?? 0;
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
  await sweepSeedVotes(env, now);
  await sweepUsedGates(env, now);
  await retryPendingDeletes(env);
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
      env.DB.prepare(
        "UPDATE posts SET votes = MAX(votes - 1, 0) WHERE id = ? AND EXISTS (SELECT 1 FROM votes WHERE post_id = ? AND visitor_id = ?)",
      ).bind(postId, postId, visitorId),
      env.DB.prepare("DELETE FROM votes WHERE post_id = ? AND visitor_id = ?").bind(postId, visitorId),
    ]);
  } else {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE posts SET votes = votes + 1 WHERE id = ? AND NOT EXISTS (SELECT 1 FROM votes WHERE post_id = ? AND visitor_id = ?)",
      ).bind(postId, postId, visitorId),
      env.DB.prepare("INSERT OR IGNORE INTO votes (post_id, visitor_id, created_at) VALUES (?, ?, ?)").bind(postId, visitorId, now),
    ]);
  }
  const row = await env.DB.prepare("SELECT votes FROM posts WHERE id = ?").bind(postId).first<{ votes: number }>();
  if (!row) return null;
  const still = await env.DB.prepare("SELECT 1 AS ok FROM votes WHERE post_id = ? AND visitor_id = ?").bind(postId, visitorId).first();
  return { votes: row.votes, voted: Boolean(still) };
}

export async function setStatus(env: Env, id: string, status: PostStatus, now: number): Promise<boolean> {
  const updated = await env.DB.prepare(`UPDATE posts SET status = ? WHERE id = ? AND ${VISIBLE}`).bind(status, id, now).run();
  return (updated.meta.changes ?? 0) > 0;
}

export async function setImageApproved(env: Env, id: string, approved: boolean, now: number): Promise<boolean> {
  const updated = await env.DB.prepare(`UPDATE posts SET image_approved = ? WHERE id = ? AND ${VISIBLE} AND image_key IS NOT NULL`)
    .bind(approved ? 1 : 0, id, now)
    .run();
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

export async function getImage(
  env: Env,
  id: string,
  now: number,
  allowPending: boolean,
): Promise<{ key: string; type: string } | null> {
  const row = await env.DB.prepare(`SELECT image_key, image_type, image_approved FROM posts WHERE id = ? AND ${VISIBLE}`)
    .bind(id, now)
    .first<{ image_key: string | null; image_type: string | null; image_approved: number }>();
  if (!row?.image_key || !row.image_type) return null;
  if (row.image_approved !== 1 && !allowPending) return null;
  return { key: row.image_key, type: row.image_type };
}

export async function listSeedPosts(env: Env): Promise<{ id: string; title: string; body: string }[]> {
  const rows = await env.DB.prepare("SELECT id, title, body FROM posts WHERE seeded = 1").all<{ id: string; title: string; body: string }>();
  return rows.results;
}

export async function insertGate(env: Env, nonce: string, visitorId: string, now: number): Promise<void> {
  const exp = now + GATE_TTL_SECONDS * 1000;
  await env.DB.prepare(
    "INSERT INTO used_gates (nonce, visitor_id, remaining_similar, remaining_create, exp) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(nonce, visitorId, GATE_SIMILAR_USES, GATE_CREATE_USES, exp)
    .run();
}

export async function consumeGateUse(env: Env, nonce: string, visitorId: string, kind: "similar" | "create", now: number): Promise<boolean> {
  const column = kind === "similar" ? "remaining_similar" : "remaining_create";
  const result = await env.DB.prepare(
    `UPDATE used_gates SET ${column} = ${column} - 1 WHERE nonce = ? AND visitor_id = ? AND ${column} > 0 AND exp > ?`,
  )
    .bind(nonce, visitorId, now)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
