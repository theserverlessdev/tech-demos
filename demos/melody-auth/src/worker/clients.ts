import { verifyJwtWithKeys, type PublicJwk } from "./jwt";
import { OauthError } from "./errors";
import { publicBase } from "./origin";
import { timingSafeEqual } from "./encoding";
import { assertionLifetimeOk } from "./policy";
import { clientSecretMatches } from "./secret";
import { appGrants, getFullApp, rememberClientAssertion, type FullApp } from "./store";

function formDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function basicPair(header: string | null): { id: string; secret: string } | null {
  const match = /^Basic\s+(\S+)$/i.exec(header ?? "");
  if (!match?.[1]) return null;
  try {
    const decoded = atob(match[1]);
    const idx = decoded.indexOf(":");
    if (idx < 1) return null;
    return { id: formDecode(decoded.slice(0, idx)), secret: formDecode(decoded.slice(idx + 1)) };
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
    if (!app.client_secret_hash) throw new OauthError(401, "invalid_client", "Client authentication failed.");
    const ok = await clientSecretMatches(secret, app.client_secret_hash);
    if (!ok) throw new OauthError(401, "invalid_client", "Client authentication failed.");
    return app;
  }
  if (method === "private_key_jwt") {
    try {
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
      const nowSec = Math.floor(now / 1000);
      const claims = await verifyJwtWithKeys(body.client_assertion, keys, nowSec);
      if (!claims || claims.sub !== clientId || claims.iss !== clientId || !assertionLifetimeOk(claims, nowSec)) {
        throw new OauthError(401, "invalid_client", "Client authentication failed.");
      }
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      const issuer = publicBase(request, env).issuer;
      if (!aud.includes(issuer) && !aud.includes(`${issuer}/token`)) throw new OauthError(401, "invalid_client", "Client authentication failed.");
      const fresh = await rememberClientAssertion(env.DB, clientId, claims.jti ?? "", (claims.exp ?? nowSec) * 1000);
      if (!fresh) throw new OauthError(401, "invalid_client", "Client authentication failed.");
      return app;
    } catch (err) {
      if (err instanceof OauthError) throw err;
      throw new OauthError(401, "invalid_client", "Client authentication failed.");
    }
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

export async function requireConfidential(app: FullApp): Promise<void> {
  if (app.client_type !== "confidential" || app.token_endpoint_auth_method === "none") {
    throw new OauthError(401, "invalid_client", "Client authentication failed.");
  }
}
