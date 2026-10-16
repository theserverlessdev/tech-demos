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
      meta.textContent = `${app.clientType} · ${app.authMethod} · ${app.grantTypes.join(", ")} · ${app.redirectUris.join(" · ")}`;
      li.append(title, meta);
      return li;
    }),
  );
}

const form = document.getElementById("create-app") as HTMLFormElement | null;
form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = (document.getElementById("admin-token") as HTMLInputElement).value.trim();
  const name = (document.getElementById("app-name") as HTMLInputElement).value.trim();
  const redirects = (document.getElementById("app-redirects") as HTMLInputElement).value.trim();
  const clientType = (document.getElementById("app-type") as HTMLSelectElement).value;
  const created = document.getElementById("created-secret");
  const result = await fetch(`${apiRoot()}/api/admin/apps`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      name,
      redirect_uris: redirects.split(",").map((item) => item.trim()).filter(Boolean),
      client_type: clientType,
      grant_types: clientType === "confidential" ? ["client_credentials"] : ["authorization_code", "refresh_token"],
    }),
  });
  const payload = (await result.json().catch(() => null)) as { clientId?: string; clientSecret?: string; error?: { message?: string } } | null;
  if (created) {
    if (result.status === 201 && payload?.clientId) {
      created.textContent = payload.clientSecret
        ? `client_id ${payload.clientId} · secret shown once: ${payload.clientSecret}`
        : `client_id ${payload.clientId} (public, no secret)`;
    } else {
      created.textContent = payload?.error?.message ?? "Create failed. ADMIN_TOKEN is required.";
    }
  }
});
