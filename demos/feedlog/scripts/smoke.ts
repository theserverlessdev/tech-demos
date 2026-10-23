// Smoke: bun run scripts/smoke.ts [baseUrl] [--allow-writes]
import type { BoardConfig, ChangelogEntry, Health, Post, SimilarResult } from "../src/shared/types";

const args = process.argv.slice(2);
const base = (args.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const PRODUCTION_SITE_KEY = "0x4AAAAAAFRUoj5qDpf7XyIW";
const TEST_SITE_KEY = "1x00000000000000000000AA";

function isLoopbackBase(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

const local = isLoopbackBase(base);
const allowWrites = local || args.includes("--allow-writes");
const dummy = "XXXX.DUMMY.TOKEN.XXXX";
const admin = process.env.ADMIN_TOKEN || "dev-feedlog-admin";
const jar = new Map<string, string>();

let failures = 0;
function check(label: string, ok: unknown, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

function remember(res: Response) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const combined = list.length > 0 ? list : (res.headers.get("set-cookie") ?? "").split(/,(?=[^;]+?=)/);
  for (const cookie of combined) {
    const pair = cookie.split(";")[0]?.trim() ?? "";
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown; form?: FormData; admin?: boolean; cookie?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (init.cookie !== false && jar.size) headers.cookie = [...jar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  if (init.admin) headers.authorization = `Bearer ${admin}`;
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`${base}${path}`, { method: init.method ?? "GET", headers, body });
  if (init.cookie !== false) remember(res);
  const text = await res.text();
  let data: T | null = null;
  try {
    data = text ? (JSON.parse(text) as T) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data, text };
}

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (char) => char.charCodeAt(0));

console.log(`Target: ${base}${allowWrites ? "" : " (read-only)"}`);

const prefixed = await call<Health>("/demos/feedlog/api/health");
check("health works under the /demos/feedlog prefix", prefixed.status === 200 && prefixed.data?.ok === true, prefixed.data);

const health = await call<Health>("/api/health");
check("health lists seeded posts and changelog", health.status === 200 && (health.data?.posts ?? 0) >= 5 && (health.data?.changelog ?? 0) >= 2, health.data);

const config = await call<BoardConfig>("/api/config");
if (local) {
  check("loopback config opens writes with the test site key", config.data?.writesOpen === true && config.data.turnstileSiteKey === TEST_SITE_KEY, config.data);
} else {
  check(
    "remote config opens writes with the production site key",
    config.data?.writesOpen === true && config.data.turnstileSiteKey === PRODUCTION_SITE_KEY,
    config.data,
  );
}

const list = await call<{ posts: Post[] }>("/api/posts");
const titles = list.data?.posts.map((post) => post.title) ?? [];
check("board includes the seeded dark-mode post", titles.some((title) => title.includes("Dark mode on the public roadmap")), titles.length);
check("expired fixture is hidden", !titles.some((title) => title.includes("Expired fixture")), titles);

const roadmap = await call<{ posts: Post[] }>("/api/posts?status=planned");
check("planned filter returns the roadmap seed", roadmap.data?.posts.some((post) => post.id === "post_dark_roadmap") === true, roadmap.status);

const changelog = await call<{ entries: ChangelogEntry[] }>("/api/changelog");
check("changelog has the two seed entries", (changelog.data?.entries.length ?? 0) >= 2, changelog.data?.entries.length);

const blocked = await call("/api/posts", { method: "POST", body: { title: "No check", body: "This must be rejected." } });
check("create without Turnstile is rejected", blocked.status === 403, blocked.status);

const similarBlocked = await call("/api/similar", { method: "POST", body: { title: "Dark mode on the public roadmap", body: "please" } });
check("similar without Turnstile is rejected", similarBlocked.status === 403, similarBlocked.status);

const noAdmin = await call("/api/posts/post_csv_export", { method: "PATCH", body: { status: "planned" } });
check("status change without the admin token is rejected", noAdmin.status === 401, noAdmin.status);

if (!allowWrites) {
  check("remote smoke stays read-only (pass --allow-writes to mutate)", true);
  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nRead-only checks passed.");
  process.exit(0);
}

const badId = await call("/api/posts/%E0%A4%A");
check("malformed percent-encoding is 404", badId.status === 404, badId.status);

const cross = await fetch(`${base}/api/posts/post_dark_roadmap/vote`, {
  method: "POST",
  headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", cookie: [...jar.entries()].map(([key, value]) => `${key}=${value}`).join("; ") },
});
check("cross-site vote is rejected", cross.status === 403, cross.status);

const freshVote = await fetch(`${base}/api/posts/post_dark_roadmap/vote`, { method: "POST" });
check("cookieless vote is rejected", freshVote.status === 409, freshVote.status);

const dark = list.data?.posts.find((post) => post.id === "post_dark_roadmap");
const before = dark?.votes ?? 0;
const up = await call<{ votes: number; voted: boolean }>("/api/posts/post_dark_roadmap/vote", { method: "POST" });
check("upvote increases the count once", up.status === 200 && up.data?.voted === true && up.data.votes === before + 1, up.data);
const down = await call<{ votes: number; voted: boolean }>("/api/posts/post_dark_roadmap/vote", { method: "POST" });
check("a second vote from the same browser removes it", down.status === 200 && down.data?.voted === false && down.data.votes === before, down.data);

const concurrentUp = await Promise.all(
  Array.from({ length: 6 }, () => call<{ votes: number; voted: boolean }>("/api/posts/post_dark_roadmap/vote", { method: "POST" })),
);
check(
  "concurrent first votes stay 200 and do not over-count",
  concurrentUp.every((res) => res.status === 200) && concurrentUp.every((res) => (res.data?.votes ?? 0) <= before + 1),
  concurrentUp.map((res) => res.status),
);
const afterUp = await call<{ post: Post }>("/api/posts/post_dark_roadmap");
check("seed count after concurrent votes is at most +1", (afterUp.data?.post.votes ?? 99) <= before + 1, afterUp.data?.post.votes);
if (afterUp.data?.post.voted) {
  await Promise.all(Array.from({ length: 6 }, () => call("/api/posts/post_dark_roadmap/vote", { method: "POST" })));
}
const afterDown = await call<{ post: Post }>("/api/posts/post_dark_roadmap");
check("concurrent unvotes do not drain the seed", (afterDown.data?.post.votes ?? -1) >= before, afterDown.data?.post.votes);
if (afterDown.data?.post.voted) {
  await call("/api/posts/post_dark_roadmap/vote", { method: "POST" });
}

const similar = await call<SimilarResult>("/api/similar", {
  method: "POST",
  body: { title: "Dark mode on the public roadmap", body: "The columns are still bright.", turnstileToken: dummy },
});
const hit = similar.data?.similar.some((item) => item.id === "post_dark_roadmap");
check("similar finds the seeded dark-mode post", similar.status === 200 && hit === true, similar.data);

const gate = await call<{ ok: boolean }>("/api/gate", { method: "POST", body: { turnstileToken: dummy } });
check("gate accepts a loopback Turnstile token", gate.status === 200, gate.status);

const tooShort = await call("/api/posts", {
  method: "POST",
  body: { title: "ab", body: "This must not spend the create credit." },
});
check("short title is rejected without spending the gate", tooShort.status === 400, tooShort.status);

const created = await call<{ post: Post }>("/api/posts", {
  method: "POST",
  body: {
    title: "Smoke post from the script",
    body: "Created by scripts/smoke.ts to prove the write path.",
    displayName: "Smoke",
  },
});
check("create still works after a rejected short title on the same gate", created.status === 201 && created.data?.post.title === "Smoke post from the script", created.data);

const replay = await call("/api/posts", {
  method: "POST",
  body: { title: "Replay should fail", body: "Same gate must not create again." },
});
check("replayed gate cannot create a second post", replay.status === 403, replay.status);

const second = await call<{ post: Post }>("/api/posts", {
  method: "POST",
  body: {
    title: "Smoke post with a fresh token",
    body: "Created with a Turnstile token after the gate credit was spent.",
    displayName: "Smoke",
    turnstileToken: dummy,
  },
});
check("create still accepts a fresh Turnstile token", second.status === 201 && Boolean(second.data?.post.id), second.status);

const textForm = new FormData();
textForm.set("title", "Smoke text file");
textForm.set("body", "A text file must be rejected.");
textForm.set("turnstileToken", dummy);
textForm.set("image", new File([new TextEncoder().encode("hello")], "note.txt", { type: "text/plain" }));
const text = await call("/api/posts", { method: "POST", form: textForm });
check("non-image upload is rejected", text.status === 415, text.status);

const fake = new FormData();
fake.set("title", "Smoke fake png");
fake.set("body", "Declared PNG, text bytes.");
fake.set("turnstileToken", dummy);
fake.set("image", new File([new TextEncoder().encode("not a png")], "fake.png", { type: "image/png" }));
const fakeRes = await call("/api/posts", { method: "POST", form: fake });
check("mismatched image bytes are rejected", fakeRes.status === 415, fakeRes.status);

const form = new FormData();
form.set("title", "Smoke image post");
form.set("body", "A one pixel PNG should land in R2 and stay hidden.");
form.set("turnstileToken", dummy);
form.set("image", new File([PNG], "pixel.png", { type: "image/png" }));
const imaged = await call<{ post: Post }>("/api/posts", { method: "POST", form });
check("png upload is accepted as pending", imaged.status === 201 && imaged.data?.post.imagePending === true && imaged.data.post.hasImage === false, imaged.data?.post);

const createdIds = [created.data?.post.id, second.data?.post.id, imaged.data?.post.id].filter((id): id is string => Boolean(id));

if (imaged.data?.post.id) {
  const hidden = await fetch(`${base}/api/posts/${imaged.data.post.id}/image`);
  check("unapproved image is not public", hidden.status === 404, hidden.status);
  const preview = await fetch(`${base}/api/posts/${imaged.data.post.id}/image`, { headers: { authorization: `Bearer ${admin}` } });
  check("admin can read a pending image before approving", preview.status === 200, preview.status);
  const approved = await call<{ post: Post }>(`/api/posts/${imaged.data.post.id}`, { method: "PATCH", admin: true, body: { imageApproved: true } });
  check("admin can approve an image", approved.status === 200 && approved.data?.post.hasImage === true, approved.status);
  const file = await fetch(`${base}/api/posts/${imaged.data.post.id}/image`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  check("approved image round-trips from R2", file.ok && bytes[0] === 0x89 && bytes[1] === 0x50, file.status);
}

const fourth = await call("/api/posts", {
  method: "POST",
  body: { title: "Fourth live post", body: "This browser already has three.", turnstileToken: dummy },
});
check("a fourth live post from the same visitor is rejected", fourth.status === 409, fourth.status);

const moved = await call<{ post: Post }>("/api/posts/post_csv_export", { method: "PATCH", admin: true, body: { status: "planned" } });
check("admin token can set a status", moved.status === 200 && moved.data?.post.status === "planned", moved.data?.post.status);
const restored = await call<{ post: Post }>("/api/posts/post_csv_export", { method: "PATCH", admin: true, body: { status: "done" } });
check("admin token can restore the seed status", restored.status === 200 && restored.data?.post.status === "done", restored.data?.post.status);

const badStatus = await call("/api/posts/post_csv_export", { method: "PATCH", admin: true, body: { status: "shipped" } });
check("unknown status is rejected", badStatus.status === 400, badStatus.status);

const emailName = await call("/api/posts", {
  method: "POST",
  body: { title: "Email name", body: "Should fail.", displayName: "a@b.example", turnstileToken: dummy },
});
check("email-shaped display names are rejected", emailName.status === 400, emailName.status);

for (const id of createdIds) {
  const gone = await call<{ ok: boolean }>(`/api/posts/${id}`, { method: "DELETE", admin: true });
  check(`admin delete removes ${id}`, gone.status === 200, gone.status);
}

if (local) {
  const expired = await call<{ post: Post }>("/api/posts", {
    method: "POST",
    body: { title: "Already expired smoke post", body: "Cleanup should delete this.", turnstileToken: dummy, expiresInSeconds: 0 },
  });
  check("loopback can create an already-expired post", expired.status === 201 && Boolean(expired.data?.post.id), expired.status);
  const cleanup = await call<{ deletedPosts: number }>("/api/admin/cleanup", { method: "POST", admin: true });
  check("admin cleanup deletes expired posts", cleanup.status === 200 && (cleanup.data?.deletedPosts ?? 0) >= 1, cleanup.data);
  if (expired.data?.post.id) {
    const gone = await call(`/api/posts/${expired.data.post.id}`);
    check("expired post is no longer public", gone.status === 404, gone.status);
  }
  const seeds = await call<{ posts: Post[] }>("/api/posts");
  const darkAfter = seeds.data?.posts.find((post) => post.id === "post_dark_roadmap");
  check("cleanup does not zero seed vote counts", (darkAfter?.votes ?? 0) >= 24, darkAfter?.votes);
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
