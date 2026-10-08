import {
  ROADMAP_STATUSES,
  STATUS_LABEL,
  type BoardConfig,
  type ChangelogEntry,
  type Post,
  type PostStatus,
  type SimilarResult,
} from "../shared/types";

type VoteResult = { votes: number; voted: boolean };
type ErrorBody = { error?: { message?: string } };
type Tab = "board" | "roadmap" | "changelog" | "post";

const FILTERS: Array<"all" | PostStatus> = ["all", "open", "planned", "in_progress", "done", "closed"];

const state = {
  config: null as BoardConfig | null,
  posts: [] as Post[],
  entries: [] as ChangelogEntry[],
  filter: "all" as "all" | PostStatus,
  sort: "top" as "top" | "new",
  admin: readAdmin(),
  gated: false,
  turnstileId: null as string | null,
  similarTimer: 0,
  detailId: "",
};

function readAdmin(): string {
  try {
    return sessionStorage.getItem("feedlog-admin") ?? "";
  } catch {
    return "";
  }
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function api(path: string): string {
  const prefix = location.pathname.startsWith("/demos/feedlog") ? "/demos/feedlog" : "";
  return `${prefix}/api${path}`;
}

function imageUrl(id: string): string {
  return api(`/posts/${id}/image`);
}

async function call<T>(path: string, init: { method?: string; body?: unknown; form?: FormData; admin?: boolean } = {}): Promise<{ status: number; data: T | null; error: string | null }> {
  const headers = new Headers();
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.body);
  }
  if (init.admin && state.admin) headers.set("authorization", `Bearer ${state.admin}`);
  const res = await fetch(api(path), { method: init.method ?? "GET", headers, body, credentials: "same-origin" });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
  }
  const message = parsed && typeof parsed === "object" && "error" in parsed ? (parsed as ErrorBody).error?.message ?? null : null;
  return { status: res.status, data: res.ok ? (parsed as T) : null, error: res.ok ? null : message ?? `Request failed (${res.status}).` };
}

function hint(id: string, message: string, tone?: "error" | "ok"): void {
  const el = $(id);
  el.textContent = message;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

function chip(status: PostStatus): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "chip";
  el.dataset.status = status;
  el.textContent = STATUS_LABEL[status];
  return el;
}

function voteButton(post: Post): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = post.voted ? "vote is-on" : "vote";
  button.dataset.vote = post.id;
  button.setAttribute("aria-pressed", post.voted ? "true" : "false");
  button.setAttribute("aria-label", `${post.voted ? "Remove vote from" : "Upvote"} ${post.title}`);
  const count = document.createElement("b");
  count.textContent = String(post.votes);
  const label = document.createElement("small");
  label.textContent = post.votes === 1 ? "vote" : "votes";
  button.append(count, label);
  return button;
}

function statusSelect(post: Post): HTMLSelectElement | null {
  if (!state.admin) return null;
  const select = document.createElement("select");
  select.className = "status-select";
  select.dataset.statusFor = post.id;
  select.setAttribute("aria-label", `Status for ${post.title}`);
  for (const status of FILTERS) {
    if (status === "all") continue;
    const option = document.createElement("option");
    option.value = status;
    option.textContent = STATUS_LABEL[status];
    option.selected = status === post.status;
    select.append(option);
  }
  return select;
}

function postCard(post: Post, clamp: boolean): HTMLElement {
  const article = document.createElement("article");
  article.className = "post";
  article.dataset.post = post.id;
  article.append(voteButton(post));
  const body = document.createElement("div");
  const title = document.createElement("a");
  title.className = "post__title";
  title.href = `#/p/${post.id}`;
  title.textContent = post.title;
  const copy = document.createElement("p");
  copy.className = "post__body";
  copy.textContent = post.body;
  if (!clamp) copy.style.webkitLineClamp = "unset";
  const meta = document.createElement("div");
  meta.className = "post__meta";
  meta.append(chip(post.status));
  const who = document.createElement("span");
  who.textContent = post.displayName;
  meta.append(who);
  const select = statusSelect(post);
  if (select) meta.append(select);
  body.append(title, copy, meta);
  if (post.hasImage) {
    const img = document.createElement("img");
    img.className = "post__image";
    img.src = imageUrl(post.id);
    img.alt = "";
    body.append(img);
  }
  article.append(body);
  return article;
}

function visiblePosts(): Post[] {
  return state.posts.filter((post) => state.filter === "all" || post.status === state.filter);
}

function renderBoard(): void {
  const posts = visiblePosts();
  $("count").textContent = String(posts.length);
  const list = $("posts");
  list.replaceChildren();
  if (posts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Nothing in this filter.";
    list.append(empty);
    return;
  }
  for (const post of posts) list.append(postCard(post, true));
  document.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((button) => {
    button.classList.toggle("is-on", button.dataset.filter === state.filter);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-sort]").forEach((button) => {
    button.classList.toggle("is-on", button.dataset.sort === state.sort);
  });
}

function renderRoadmap(): void {
  const root = $("roadmap");
  root.replaceChildren();
  for (const status of ROADMAP_STATUSES) {
    const column = document.createElement("section");
    column.className = "column";
    const heading = document.createElement("h3");
    heading.textContent = STATUS_LABEL[status];
    const items = state.posts.filter((post) => post.status === status);
    const list = document.createElement("ol");
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "Nothing here yet.";
      column.append(heading, empty);
    } else {
      for (const post of items) {
        const card = document.createElement("li");
        card.className = "card";
        const title = document.createElement("a");
        const strong = document.createElement("b");
        strong.textContent = post.title;
        title.href = `#/p/${post.id}`;
        title.append(strong);
        const meta = document.createElement("span");
        meta.textContent = `${post.votes} ${post.votes === 1 ? "vote" : "votes"}`;
        card.append(title, meta);
        list.append(card);
      }
      column.append(heading, list);
    }
    root.append(column);
  }
}

function renderChangelog(): void {
  const form = $("changelog-form");
  form.hidden = !state.admin;
  const list = $("changelog-list");
  list.replaceChildren();
  const fmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  for (const entry of state.entries) {
    const item = document.createElement("li");
    item.className = "entry";
    const time = document.createElement("time");
    time.dateTime = new Date(entry.publishedAt).toISOString();
    time.textContent = fmt.format(entry.publishedAt);
    const title = document.createElement("h3");
    title.textContent = entry.title;
    const body = document.createElement("p");
    body.textContent = entry.body;
    item.append(time, title, body);
    list.append(item);
  }
  if (state.entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No changelog entries yet.";
    list.append(empty);
  }
}

function renderDetail(post: Post | null): void {
  const root = $("post-detail");
  root.replaceChildren();
  if (!post) {
    const missing = document.createElement("p");
    missing.className = "empty";
    missing.textContent = "That post is gone.";
    root.append(missing);
    return;
  }
  root.className = "detail";
  root.append(postCard(post, false));
}

function show(tab: Tab): void {
  for (const name of ["board", "roadmap", "changelog", "post"] as const) {
    const view = document.getElementById(`view-${name}`);
    if (view) view.hidden = name !== tab;
    const link = document.querySelector<HTMLAnchorElement>(`[data-tab="${name}"]`);
    if (link) {
      if (name === tab) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }
  if (tab === "post") document.querySelector("[data-tab='board']")?.setAttribute("aria-current", "page");
}

async function loadPosts(): Promise<void> {
  const res = await call<{ posts: Post[] }>(`/posts?sort=${state.sort}`);
  if (!res.data) {
    $("posts").textContent = res.error ?? "The board could not be loaded.";
    return;
  }
  state.posts = res.data.posts;
  renderBoard();
  renderRoadmap();
}

async function loadChangelog(): Promise<void> {
  const res = await call<{ entries: ChangelogEntry[] }>("/changelog");
  if (!res.data) return;
  state.entries = res.data.entries;
  renderChangelog();
}

async function openDetail(id: string): Promise<void> {
  state.detailId = id;
  show("post");
  const known = state.posts.find((post) => post.id === id) ?? null;
  renderDetail(known);
  const res = await call<{ post: Post }>(`/posts/${id}`);
  if (state.detailId !== id) return;
  renderDetail(res.data?.post ?? null);
}

function route(): void {
  const hash = location.hash.replace(/^#/, "") || "/board";
  const post = /^\/p\/(post_[a-z0-9_]+)$/.exec(hash);
  if (post?.[1]) {
    void openDetail(post[1]);
    return;
  }
  if (hash.startsWith("/roadmap")) {
    show("roadmap");
    renderRoadmap();
    return;
  }
  if (hash.startsWith("/changelog")) {
    show("changelog");
    renderChangelog();
    return;
  }
  show("board");
  renderBoard();
}

function scheduleSimilar(): void {
  window.clearTimeout(state.similarTimer);
  state.similarTimer = window.setTimeout(() => void runSimilar(), 450);
}

async function runSimilar(): Promise<void> {
  const title = ($("title") as HTMLInputElement).value.trim();
  const body = ($("body") as HTMLTextAreaElement).value.trim();
  const list = $("similar-list");
  if (`${title} ${body}`.trim().length < 12) {
    hint("similar-hint", "Type a title. If someone already asked, it shows up here.");
    list.replaceChildren();
    return;
  }
  if (!state.gated) {
    hint("similar-hint", "Finish the check to look for duplicates.");
    return;
  }
  const res = await call<SimilarResult>("/similar", { method: "POST", body: { title, body } });
  if (!res.data) {
    hint("similar-hint", res.error ?? "Could not look for duplicates.", "error");
    return;
  }
  if (res.data.source === "skipped" || res.data.similar.length === 0) {
    hint("similar-hint", res.data.source === "vectorize" ? "No close match in the index." : "No close match yet.");
    list.replaceChildren();
    return;
  }
  const source =
    res.data.source === "vectorize"
      ? "Matched with Workers AI and Vectorize."
      : "Matched on words. Workers AI and Vectorize run when those bindings answer.";
  hint("similar-hint", source);
  list.replaceChildren();
  for (const hit of res.data.similar) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = `#/p/${hit.id}`;
    const strong = document.createElement("strong");
    strong.textContent = hit.title;
    const meta = document.createElement("span");
    meta.textContent = hit.kind === "duplicate" ? "Possible duplicate" : "Related";
    link.append(strong, meta);
    item.append(link);
    list.append(item);
  }
}

async function mintGate(token: string): Promise<void> {
  const res = await call<{ ok: boolean }>("/gate", { method: "POST", body: { turnstileToken: token } });
  state.gated = res.status === 200;
  ($("submit") as HTMLButtonElement).disabled = !state.gated;
  if (!state.gated) hint("form-hint", res.error ?? "The check did not pass.", "error");
  else hint("form-hint", "You can post. Similar ideas update as you type.", "ok");
  if (state.gated) void runSimilar();
}

type TurnstileApi = {
  render: (el: HTMLElement, opts: { sitekey: string; callback: (token: string) => void; "error-callback": () => void }) => string;
  getResponse: (id?: string) => string | undefined;
  reset: (id?: string) => void;
};

function turnstileApi(): TurnstileApi | undefined {
  const apiObj = (window as Window & { turnstile?: Partial<TurnstileApi> }).turnstile;
  if (!apiObj?.render || !apiObj.reset) return undefined;
  return apiObj as TurnstileApi;
}

async function mountTurnstile(siteKey: string): Promise<void> {
  const ready = (window as Window & { __turnstileReady?: Promise<void> }).__turnstileReady;
  if (ready) await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 8000))]);
  const widget = turnstileApi();
  const host = $("turnstile");
  if (!widget) {
    hint("form-hint", "The check could not load. Refresh and try again.", "error");
    return;
  }
  if (state.turnstileId) widget.reset(state.turnstileId);
  state.turnstileId = widget.render(host, {
    sitekey: siteKey,
    callback: (token) => void mintGate(token),
    "error-callback": () => {
      state.gated = false;
      ($("submit") as HTMLButtonElement).disabled = true;
      hint("form-hint", "The check failed. Refresh and try again.", "error");
    },
  });
}

async function onSubmit(event: Event): Promise<void> {
  event.preventDefault();
  const button = $("submit") as HTMLButtonElement;
  button.disabled = true;
  const form = new FormData();
  form.set("title", ($("title") as HTMLInputElement).value);
  form.set("body", ($("body") as HTMLTextAreaElement).value);
  form.set("displayName", ($("display-name") as HTMLInputElement).value);
  const file = ($("image") as HTMLInputElement).files?.[0];
  if (file) form.set("image", file);
  const res = await call<{ post: Post }>("/posts", { method: "POST", form });
  button.disabled = !state.gated;
  if (!res.data) {
    hint("form-hint", res.error ?? "The post was not saved.", "error");
    return;
  }
  ($("title") as HTMLInputElement).value = "";
  ($("body") as HTMLTextAreaElement).value = "";
  ($("image") as HTMLInputElement).value = "";
  hint("form-hint", "Posted.", "ok");
  hint("similar-hint", "Type a title. If someone already asked, it shows up here.");
  $("similar-list").replaceChildren();
  state.posts = [res.data.post, ...state.posts.filter((post) => post.id !== res.data?.post.id)];
  if (state.sort === "top") state.posts.sort((a, b) => b.votes - a.votes || b.createdAt - a.createdAt);
  renderBoard();
  renderRoadmap();
  const widget = turnstileApi();
  if (state.turnstileId && widget) widget.reset(state.turnstileId);
  state.gated = false;
  button.disabled = true;
}

async function onVote(id: string): Promise<void> {
  const res = await call<VoteResult>(`/posts/${id}/vote`, { method: "POST" });
  if (!res.data) {
    hint("form-hint", res.error ?? "The vote was not saved.", "error");
    return;
  }
  const post = state.posts.find((item) => item.id === id);
  if (post) {
    post.votes = res.data.votes;
    post.voted = res.data.voted;
  }
  renderBoard();
  renderRoadmap();
  if (state.detailId === id && post) renderDetail(post);
}

async function onStatus(id: string, status: PostStatus): Promise<void> {
  const res = await call<{ post: Post }>(`/posts/${id}`, { method: "PATCH", admin: true, body: { status } });
  if (!res.data) {
    hint("admin-hint", res.error ?? "Status was not changed.", "error");
    await loadPosts();
    return;
  }
  state.posts = state.posts.map((post) => (post.id === id ? { ...res.data!.post, voted: post.voted } : post));
  hint("admin-hint", "Status saved.", "ok");
  renderBoard();
  renderRoadmap();
  if (state.detailId === id) renderDetail(state.posts.find((post) => post.id === id) ?? null);
}

function syncAdmin(): void {
  const input = $("admin-token") as HTMLInputElement;
  input.value = state.admin;
  hint("admin-hint", state.admin ? "Token stored for this tab." : "No token in this tab.", state.admin ? "ok" : undefined);
  renderBoard();
  renderChangelog();
  if (state.detailId) {
    const post = state.posts.find((item) => item.id === state.detailId) ?? null;
    if (post) renderDetail(post);
  }
}

function bind(): void {
  $("theme").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* private mode */
    }
  });
  window.addEventListener("hashchange", route);
  $("compose").addEventListener("submit", (event) => void onSubmit(event));
  $("title").addEventListener("input", scheduleSimilar);
  $("body").addEventListener("input", scheduleSimilar);
  $("posts").addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-vote]");
    if (!button?.dataset.vote) return;
    void onVote(button.dataset.vote);
  });
  $("post-detail").addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-vote]");
    if (!button?.dataset.vote) return;
    void onVote(button.dataset.vote);
  });
  $("posts").addEventListener("change", (event) => {
    const select = event.target as HTMLSelectElement;
    if (!select.dataset.statusFor) return;
    void onStatus(select.dataset.statusFor, select.value as PostStatus);
  });
  document.querySelector(".filters")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-filter]");
    const filter = button?.dataset.filter;
    if (!filter || !FILTERS.includes(filter as "all" | PostStatus)) return;
    state.filter = filter as "all" | PostStatus;
    renderBoard();
  });
  document.querySelector(".sorts")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-sort]");
    const sort = button?.dataset.sort;
    if (sort !== "top" && sort !== "new") return;
    state.sort = sort;
    void loadPosts();
  });
  $("admin-save").addEventListener("click", () => {
    state.admin = ($("admin-token") as HTMLInputElement).value.trim();
    try {
      if (state.admin) sessionStorage.setItem("feedlog-admin", state.admin);
      else sessionStorage.removeItem("feedlog-admin");
    } catch {
      /* ignore */
    }
    syncAdmin();
  });
  $("admin-clear").addEventListener("click", () => {
    state.admin = "";
    try {
      sessionStorage.removeItem("feedlog-admin");
    } catch {
      /* ignore */
    }
    syncAdmin();
  });
  $("changelog-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const title = ($("changelog-title") as HTMLInputElement).value;
      const body = ($("changelog-body") as HTMLTextAreaElement).value;
      const res = await call<{ entry: ChangelogEntry }>("/changelog", { method: "POST", admin: true, body: { title, body } });
      if (!res.data) {
        hint("changelog-hint", res.error ?? "The entry was not published.", "error");
        return;
      }
      ($("changelog-title") as HTMLInputElement).value = "";
      ($("changelog-body") as HTMLTextAreaElement).value = "";
      hint("changelog-hint", "Published.", "ok");
      state.entries = [res.data.entry, ...state.entries];
      renderChangelog();
    })();
  });
}

async function main(): Promise<void> {
  bind();
  syncAdmin();
  const config = await call<BoardConfig>("/config");
  state.config = config.data;
  if (!config.data?.writesOpen || !config.data.turnstileSiteKey) {
    hint("form-hint", "Posting is off until Turnstile is configured.", "error");
  } else {
    void mountTurnstile(config.data.turnstileSiteKey);
  }
  await Promise.all([loadPosts(), loadChangelog()]);
  if (!location.hash) location.hash = "#/board";
  route();
}

void main();
