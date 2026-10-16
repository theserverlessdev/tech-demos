import type { AdminApp, AdminUser, AdminView } from "../shared/types";
import { listApps, listUsers } from "./db";
import { HttpError } from "./errors";
import { json } from "./headers";
import { clientKey } from "./ip";
import { maskEmail } from "./password";
import { parseRedirectUris } from "./redirect";

export async function handleAdminApi(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== "GET") throw new HttpError(405, "method", "GET only.");
  const { success } = await env.ADMIN_LIMIT.limit({ key: clientKey(request) });
  if (!success) throw new HttpError(429, "rate_limited", "Too many requests from this address. Wait a minute.");
  const now = Date.now();
  if (path === "/api/admin" || path === "/api/admin/overview") return json(await adminView(env, now));
  if (path === "/api/admin/users") return json({ users: (await adminView(env, now)).users });
  if (path === "/api/admin/apps") return json({ apps: (await adminView(env, now)).apps });
  throw new HttpError(404, "not_found", "Unknown admin route.");
}

export async function adminView(env: Env, now: number): Promise<AdminView> {
  const users: AdminUser[] = (await listUsers(env.DB, now)).map((row) => ({
    id: row.id,
    emailMasked: maskEmail(row.email),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }));
  const apps: AdminApp[] = (await listApps(env.DB)).map((row) => ({
    clientId: row.client_id,
    name: row.name,
    redirectUris: parseRedirectUris(row.redirect_uris),
  }));
  return { users, apps };
}
