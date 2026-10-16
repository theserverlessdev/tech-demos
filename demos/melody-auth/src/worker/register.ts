import { CLIENT_TTL_MS } from "../shared/types";
import { parseForm, parseObject, readBounded } from "./body";
import { adminTokenOk } from "./clients";
import { randomBytes, randomId, sha256Hex, toBase64Url, timingSafeEqual } from "./encoding";
import { HttpError, OauthError } from "./errors";
import { corsJson } from "./headers";
import { publicBase } from "./origin";
import { hashPassword } from "./password";
import { limit } from "./oidc";
import { deleteApp, getFullApp, insertApp, parseJsonList, updateApp } from "./store";
import { verifyTurnstile } from "./turnstile";

const AUTH_METHODS = new Set(["none", "client_secret_basic", "client_secret_post", "private_key_jwt"]);
const GRANTS = new Set([
  "authorization_code",
  "refresh_token",
  "client_credentials",
  "urn:ietf:params:oauth:grant-type:device_code",
  "urn:ietf:params:oauth:grant-type:token-exchange",
]);

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  const text = await readBounded(request, 16_000);
  if (type.includes("application/x-www-form-urlencoded")) return parseForm(text);
  return parseObject(text);
}

function asStringList(value: unknown, fallback: string[]): string[] {
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return fallback;
}

async function gateRegister(env: Env, request: Request, body: Record<string, unknown>): Promise<void> {
  if (adminTokenOk(env, request)) return;
  const token = typeof body.turnstileToken === "string" ? body.turnstileToken : "";
  if (await verifyTurnstile(env, request, token)) return;
  throw new HttpError(401, "unauthorized", "Turnstile or an admin token is required to register a client.");
}

export async function handleRegister(request: Request, env: Env): Promise<Response> {
  await limit(env.REG_LIMIT, request);
  const now = Date.now();
  const url = new URL(request.url);
  const parts = url.pathname.replace(/\/+$/, "").split("/");
  const maybeId = parts[parts.length - 1] === "register" ? "" : parts[parts.length - 1] ?? "";
  const clientId = maybeId.startsWith("app_") || maybeId.startsWith("cid_") || maybeId.length > 8 ? decodeURIComponent(maybeId) : "";

  if (request.method === "POST" && !clientId) {
    const body = await readBody(request);
    await gateRegister(env, request, body);
    const redirects = asStringList(body.redirect_uris, []);
    const grants = asStringList(body.grant_types, ["authorization_code", "refresh_token"]).filter((g) => GRANTS.has(g));
    const authMethod = typeof body.token_endpoint_auth_method === "string" && AUTH_METHODS.has(body.token_endpoint_auth_method)
      ? body.token_endpoint_auth_method
      : redirects.length
        ? "none"
        : "client_secret_post";
    const clientType = authMethod === "none" ? "public" : "confidential";
    if (clientType === "public" && grants.includes("client_credentials")) {
      throw new OauthError(400, "invalid_client_metadata", "Public clients cannot use client_credentials.");
    }
    if ((grants.includes("authorization_code") || grants.includes("urn:ietf:params:oauth:grant-type:device_code")) === false && !grants.includes("client_credentials") && !grants.includes("urn:ietf:params:oauth:grant-type:token-exchange")) {
      throw new OauthError(400, "invalid_client_metadata", "At least one grant type is required.");
    }
    const name = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : "Registered app";
    const scopes = typeof body.scope === "string" && body.scope.trim() ? body.scope : "openid profile email offline_access api";
    const newId = randomId("cid");
    const registration = toBase64Url(randomBytes(32));
    let secret: string | undefined;
    let secretHash: string | undefined;
    let secretSalt: string | undefined;
    if (clientType === "confidential" && authMethod !== "private_key_jwt") {
      secret = toBase64Url(randomBytes(24));
      const hashed = await hashPassword(secret);
      secretHash = hashed.hash;
      secretSalt = hashed.salt;
    }
    const jwks = body.jwks && typeof body.jwks === "object" ? JSON.stringify(body.jwks) : typeof body.jwks === "string" ? body.jwks : undefined;
    await insertApp(env.DB, {
      clientId: newId,
      name,
      redirectUris: redirects,
      grantTypes: grants.length ? grants : ["authorization_code", "refresh_token"],
      scopes,
      authMethod,
      clientType,
      secretHash,
      secretSalt,
      jwks,
      registrationHash: await sha256Hex(registration),
      now,
      expiresAt: now + CLIENT_TTL_MS,
      requirePkce: clientType === "public",
    });
    const { issuer } = publicBase(request, env);
    return corsJson(
      request,
      {
        client_id: newId,
        client_secret: secret,
        client_id_issued_at: Math.floor(now / 1000),
        client_secret_expires_at: Math.floor((now + CLIENT_TTL_MS) / 1000),
        registration_access_token: registration,
        registration_client_uri: `${issuer}/register/${encodeURIComponent(newId)}`,
        token_endpoint_auth_method: authMethod,
        grant_types: grants.length ? grants : ["authorization_code", "refresh_token"],
        redirect_uris: redirects,
        client_name: name,
        scope: scopes,
      },
      201,
    );
  }

  if (!clientId) throw new HttpError(404, "not_found", "Unknown registration route.");
  const app = await getFullApp(env.DB, clientId);
  if (!app) throw new HttpError(401, "invalid_token", "Invalid registration access token.");
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const presented = match?.[1] ?? "";
  const expected = app.registration_access_hash ?? "";
  if (!presented || !expected || !timingSafeEqual(await sha256Hex(presented), expected)) {
    if (!adminTokenOk(env, request)) throw new HttpError(401, "invalid_token", "Invalid registration access token.");
  }

  if (request.method === "GET") {
    return corsJson(request, {
      client_id: app.client_id,
      client_name: app.name,
      redirect_uris: parseJsonList(app.redirect_uris, []),
      grant_types: parseJsonList(app.grant_types, []),
      token_endpoint_auth_method: app.token_endpoint_auth_method,
      scope: app.scopes,
      client_id_issued_at: Math.floor(app.created_at / 1000),
      client_secret_expires_at: app.expires_at ? Math.floor(app.expires_at / 1000) : 0,
    });
  }
  if (request.method === "PUT") {
    const body = await readBody(request);
    await updateApp(env.DB, clientId, {
      name: typeof body.client_name === "string" ? body.client_name : undefined,
      redirectUris: Array.isArray(body.redirect_uris) ? asStringList(body.redirect_uris, []) : undefined,
      grantTypes: body.grant_types ? asStringList(body.grant_types, []) : undefined,
      scopes: typeof body.scope === "string" ? body.scope : undefined,
    });
    return corsJson(request, { client_id: clientId, client_name: body.client_name ?? app.name });
  }
  if (request.method === "DELETE") {
    await deleteApp(env.DB, clientId);
    return new Response(null, { status: 204 });
  }
  throw new HttpError(405, "method", "GET, PUT, or DELETE.");
}
