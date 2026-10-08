// Smoke: bun run scripts/smoke.ts [baseUrl]
import type { BoardConfig, ChangelogEntry, Health, Post, SimilarResult } from "../src/shared/types";

const base = (process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const PRODUCTION_SITE_KEY = "0x4AAAAAAFRgq04SvYB_gEMr";
const TEST_SITE_KEY = "1x00000000000000000000AA";

function isLoopbackBase(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

const local = isLoopbackBase(base);
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

async function call<T>(path: string, init: { method?: string; body?: unknown; form?: FormData; admin?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (jar.size) headers.cookie = [...jar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  if (init.admin) headers.authorization = `Bearer ${admin}`;
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`${base}${path}`, { method: init.method ?? "GET", headers, body });
  remember(res);
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

console.log(`Target: ${base}`);

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

const dark = list.data?.posts.find((post) => post.id === "post_dark_roadmap");
const before = dark?.votes ?? 0;
const up = await call<{ votes: number; voted: boolean }>("/api/posts/post_dark_roadmap/vote", { method: "POST" });
check("upvote increases the count once", up.status === 200 && up.data?.voted === true && up.data.votes === before + 1, up.data);
const down = await call<{ votes: number; voted: boolean }>("/api/posts/post_dark_roadmap/vote", { method: "POST" });
check("a second vote from the same browser removes it", down.status === 200 && down.data?.voted === false && down.data.votes === before, down.data);

const blocked = await call("/api/posts", { method: "POST", body: { title: "No check", body: "This must be rejected." } });
check("create without Turnstile is rejected", blocked.status === 403, blocked.status);

const similarBlocked = await call("/api/similar", { method: "POST", body: { title: "Dark mode on the public roadmap", body: "please" } });
check("similar without Turnstile is rejected", similarBlocked.status === 403, similarBlocked.status);

const similar = await call<SimilarResult>("/api/similar", {
  method: "POST",
  body: { title: "Dark mode on the public roadmap", body: "The columns are still bright.", turnstileToken: dummy },
});
const hit = similar.data?.similar.some((item) => item.id === "post_dark_roadmap");
check("similar finds the seeded dark-mode post", similar.status === 200 && hit === true, similar.data);

const created = await call<{ post: Post }>("/api/posts", {
  method: "POST",
  body: {
    title: "Smoke post from the script",
    body: "Created by scripts/smoke.ts to prove the write path.",
    displayName: "Smoke",
    turnstileToken: dummy,
  },
});
check("create stores a visitor post", created.status === 201 && created.data?.post.title === "Smoke post from the script", created.data);

const form = new FormData();
form.set("title", "Smoke image post");
form.set("body", "A one pixel PNG should land in R2.");
form.set("turnstileToken", dummy);
form.set("image", new File([PNG], "pixel.png", { type: "image/png" }));
const imaged = await call<{ post: Post }>("/api/posts", { method: "POST", form });
check("png upload is accepted", imaged.status === 201 && imaged.data?.post.hasImage === true, imaged.status);
if (imaged.data?.post.id) {
  const file = await fetch(`${base}/api/posts/${imaged.data.post.id}/image`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  check("image round-trips from R2", file.ok && bytes[0] === 0x89 && bytes[1] === 0x50, file.status);
}

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

const noAdmin = await call("/api/posts/post_csv_export", { method: "PATCH", body: { status: "planned" } });
check("status change without the admin token is rejected", noAdmin.status === 401, noAdmin.status);

const moved = await call<{ post: Post }>("/api/posts/post_csv_export", { method: "PATCH", admin: true, body: { status: "done" } });
check("admin token can set a status", moved.status === 200 && moved.data?.post.status === "done", moved.data?.post.status);

const badStatus = await call("/api/posts/post_csv_export", { method: "PATCH", admin: true, body: { status: "shipped" } });
check("unknown status is rejected", badStatus.status === 400, badStatus.status);

const entry = await call<{ entry: ChangelogEntry }>("/api/changelog", {
  method: "POST",
  admin: true,
  body: { title: "Smoke entry", body: "Published by scripts/smoke.ts." },
});
check("admin can publish a changelog entry", entry.status === 201 && entry.data?.entry.title === "Smoke entry", entry.status);

const emailName = await call("/api/posts", {
  method: "POST",
  body: { title: "Email name", body: "Should fail.", displayName: "a@b.example", turnstileToken: dummy },
});
check("email-shaped display names are rejected", emailName.status === 400, emailName.status);

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

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
