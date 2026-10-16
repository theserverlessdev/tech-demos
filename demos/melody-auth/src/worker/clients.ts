import { verifyJwtWithKeys, type PublicJwk } from "./jwt";
import { OauthError } from "./errors";
import { publicBase } from "./origin";
import { verifyPassword } from "./password";
import { timingSafeEqual } from "./encoding";
import { appGrants, getFullApp, type FullApp } from "./store";

function basicPair(header: string | null): { id: string; secret: string } | null {
  const match = /^Basic\s+(\S+)$/i.exec(header ?? "");
  if (!match?.[1]) return null;
  try {
    const decoded = atob(match[1]);
    const idx = decoded.indexOf(":");
    if (idx < 1) return null;
    return { id: decoded.slice(0, idx), secret: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

export async function authenticateClient(
  env: Env,
  request: Request,
  body: Record<string, string>,
  now: number,
): Promise<FullApp> {
  const basic = basicPair(request.headers.get("authorization"));
  const clientId = basic?.id || body.client_id || "";
  if (!clientId) throw new OauthError(401, "invalid_client", "Client authentication failed.");
  const app = await getFullApp(env.DB, clientId);
  if (!app) throw new OauthError(401, "invalid_client", "Client authentication failed.");
  if (app.expires_at != null && app.expires_at <= now) throw new OauthError(401, "invalid_client", "Client authentication failed.");

  const method = app.token_endpoint_auth_method || "none";
  if (method === "none") {
    if (app.client_type === "confidential") throw new OauthError(401, "invalid_client", "Client authentication failed.");
    return app;
  }
  if (method === "client_secret_basic" || method === "client_secret_post") {
    const secret = method === "client_secret_basic" ? basic?.secret ?? "" : body.client_secret ?? basic?.secret ?? "";
    if (!app.client_secret_hash || !app.client_secret_salt) throw new OauthError(401, "invalid_client", "Client authentication failed.");
    const ok = await verifyPassword(secret, app.client_secret_hash, app.client_secret_salt);
    if (!ok) throw new OauthError(401, "invalid_client", "Client authentication failed.");
    return app;
  }
  if (method === "private_key_jwt") {
    if (body.client_assertion_type !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" || !body.client_assertion) {
      throw new OauthError(401, "invalid_client", "Client authentication failed.");
    }
    let keys: PublicJwk[] = [];
    try {
      const parsed = JSON.parse(app.jwks || "{}") as { keys?: PublicJwk[] };
      keys = parsed.keys ?? [];
    } catch {
      keys = [];
    }
    const claims = await verifyJwtWithKeys(body.client_assertion, keys);
    if (!claims || claims.sub !== clientId || claims.iss !== clientId) throw new OauthError(401, "invalid_client", "Client authentication failed.");
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const issuer = publicBase(request, env).issuer;
    if (!aud.includes(issuer) && !aud.includes(`${issuer}/token`)) throw new OauthError(401, "invalid_client", "Client authentication failed.");
    return app;
  }
  throw new OauthError(401, "invalid_client", "Client authentication failed.");
}

export function clientAllowsGrant(app: FullApp, grant: string): boolean {
  return appGrants(app).includes(grant);
}

export function adminTokenOk(env: Env, request: Request): boolean {
  const expected = String((env as unknown as Record<string, string | undefined>).ADMIN_TOKEN ?? "").trim();
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return Boolean(match?.[1] && timingSafeEqual(match[1], expected));
}

export function envSecret(env: Env, name: string): string {
  return String((env as unknown as Record<string, string | undefined>)[name] ?? "").trim();
}
