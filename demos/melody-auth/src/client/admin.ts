import type { AdminView, ApiError } from "../shared/types";

function apiRoot(): string {
  const path = location.pathname;
  const marker = "/demos/melody-auth";
  if (path === marker || path.startsWith(`${marker}/`)) return marker;
  return "";
}

function when(ms: number): string {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(ms);
}

function isError(data: unknown): data is ApiError {
  if (!data || typeof data !== "object" || !("error" in data)) return false;
  const error = (data as ApiError).error;
  return Boolean(error && typeof error.message === "string");
}

const users = document.getElementById("users");
const apps = document.getElementById("apps");
const err = document.getElementById("admin-error");

const res = await fetch(`${apiRoot()}/api/admin/overview`);
const data = (await res.json().catch(() => null)) as AdminView | ApiError | null;
if (res.status !== 200 || !data || !("users" in data) || !users || !apps) {
  if (err) err.textContent = isError(data) ? data.error.message : "Could not load the admin list.";
} else {
  users.replaceChildren(
    ...data.users.map((user) => {
      const li = document.createElement("li");
      li.className = "row";
      const title = document.createElement("p");
      title.textContent = user.emailMasked;
      const meta = document.createElement("p");
      meta.className = "row__meta";
      meta.textContent = `Created ${when(user.createdAt)} · expires ${when(user.expiresAt)}`;
      li.append(title, meta);
      return li;
    }),
  );
  if (data.users.length === 0) {
    const empty = document.createElement("li");
    empty.className = "row";
    empty.textContent = "No live demo users yet.";
    users.append(empty);
  }
  apps.replaceChildren(
    ...data.apps.map((app) => {
      const li = document.createElement("li");
      li.className = "row";
      const title = document.createElement("p");
      title.textContent = `${app.name} · ${app.clientId}`;
      const meta = document.createElement("p");
      meta.className = "row__meta";
      meta.textContent = app.redirectUris.join(" · ");
      li.append(title, meta);
      return li;
    }),
  );
}
