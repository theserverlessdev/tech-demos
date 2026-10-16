import type { AdminApp, AdminUser, AdminView } from "../shared/types";
import { parseForm, parseObject, readBounded } from "./body";
import { adminTokenOk } from "./clients";
import { listUsers } from "./db";
import { randomBytes, toBase64Url } from "./encoding";
import { HttpError } from "./errors";
import { json } from "./headers";
import { clientKey } from "./ip";
import { hashPassword, maskEmail } from "./password";
import { parseRedirectUris } from "./redirect";
import { deleteApp, getFullApp, insertApp, listFullApps, parseJsonList, updateApp } from "./store";

function asAdminApp(row: Awaited<ReturnType<typeof listFullApps>>[number]): AdminApp {
  return {
    clientId: row.client_id,
    name: row.name,
    redirectUris: parseRedirectUris(row.redirect_uris),
    grantTypes: parseJsonList(row.grant_types, []),
    authMethod: row.token_endpoint_auth_method || "none",
    clientType: row.client_type || "public",
    scopes: row.scopes || "",
    expiresAt: row.expires_at,
  };
}

export async function handleAdminApi(request: Request, env: Env, path: string): Promise<Response> {
  const { success } = await env.ADMIN_LIMIT.limit({ key: clientKey(request) });
  if (!success) throw new HttpError(429, "rate_limited", "Too many requests from this address. Wait a minute.");
  const now = Date.now();
  if (request.method === "GET" && (path === "/api/admin" || path === "/api/admin/overview")) return json(await adminView(env, now));
  if (request.method === "GET" && path === "/api/admin/users") return json({ users: (await adminView(env, now)).users });
  if (request.method === "GET" && path === "/api/admin/apps") return json({ apps: (await adminView(env, now)).apps });

  if (!adminTokenOk(env, request)) throw new HttpError(401, "unauthorized", "An admin token is required to change clients.");

  if (request.method === "POST" && path === "/api/admin/rotate-keys") {
    const { rotateSigningKeys } = await import("./jwks");
    return json(await rotateSigningKeys(env, now));
  }

  if (request.method === "POST" && path === "/api/admin/apps") {
    const body = await readAdminBody(request);
    const secret = toBase64Url(randomBytes(24));
    const hashed = await hashPassword(secret);
    const clientId = typeof body.client_id === "string" && body.client_id.trim() ? body.client_id.trim() : `cid_${toBase64Url(randomBytes(8))}`;
    const clientType = body.client_type === "confidential" ? "confidential" : "public";
    await insertApp(env.DB, {
      clientId,
      name: String(body.name ?? "App").slice(0, 80),
      redirectUris: asList(body.redirect_uris),
      grantTypes: asList(body.grant_types).length ? asList(body.grant_types) : ["authorization_code", "refresh_token"],
      scopes: String(body.scopes ?? "openid profile email offline_access"),
      authMethod: String(body.auth_method ?? (clientType === "public" ? "none" : "client_secret_post")),
      clientType,
      secretHash: clientType === "confidential" ? hashed.hash : undefined,
      secretSalt: clientType === "confidential" ? hashed.salt : undefined,
      now,
      requirePkce: clientType === "public",
    });
    return json({ clientId, clientSecret: clientType === "confidential" ? secret : undefined, shownOnce: true }, 201);
  }

  const appMatch = /^\/api\/admin\/apps\/([^/]+)$/.exec(path);
  if (appMatch?.[1] && request.method === "PATCH") {
    const clientId = decodeURIComponent(appMatch[1]);
    if (!(await getFullApp(env.DB, clientId))) throw new HttpError(404, "not_found", "Unknown client.");
    const body = await readAdminBody(request);
    await updateApp(env.DB, clientId, {
      name: typeof body.name === "string" ? body.name : undefined,
      redirectUris: body.redirect_uris !== undefined ? asList(body.redirect_uris) : undefined,
      grantTypes: body.grant_types !== undefined ? asList(body.grant_types) : undefined,
      scopes: typeof body.scopes === "string" ? body.scopes : undefined,
      authMethod: typeof body.auth_method === "string" ? body.auth_method : undefined,
    });
    return json({ ok: true });
  }
  if (appMatch?.[1] && request.method === "DELETE") {
    await deleteApp(env.DB, decodeURIComponent(appMatch[1]));
    return json({ ok: true });
  }
  throw new HttpError(404, "not_found", "Unknown admin route.");
}

async function readAdminBody(request: Request): Promise<Record<string, unknown>> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  const text = await readBounded(request, 16_000);
  if (type.includes("application/x-www-form-urlencoded")) return parseForm(text);
  return parseObject(text);
}

function asList(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
    } catch {
      return value.split(/[\s,]+/).filter(Boolean);
    }
    return value.split(/[\s,]+/).filter(Boolean);
  }
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

export async function adminView(env: Env, now: number): Promise<AdminView> {
  const users: AdminUser[] = (await listUsers(env.DB, now)).map((row) => ({
    emailMasked: maskEmail(row.email),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }));
  const apps: AdminApp[] = (await listFullApps(env.DB)).map(asAdminApp);
  return { users, apps };
}
