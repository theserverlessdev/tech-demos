import { ACCESS_TTL_SEC } from "../shared/types";
import { parseForm, readBounded } from "./body";
import { authenticateClient, requireConfidential } from "./clients";
import { lookupRefresh, revokeFamily } from "./db";
import { HttpError } from "./errors";
import { corsJson } from "./headers";
import { decodeJwt, verifyJwtWithKeys } from "./jwt";
import { verificationKeys } from "./jwks";
import { publicBase } from "./origin";
import { capExpiryMs, isAccessJwt, tokenVisibleToClient } from "./policy";
import { limit } from "./oidc";
import { isJtiRevoked, revokeJti } from "./store";

async function formBody(request: Request): Promise<Record<string, string>> {
  return parseForm(await readBounded(request, 8_000));
}

export async function handleIntrospect(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(405, "method", "POST only.");
  await limit(env.INTROSPECT_LIMIT, request);
  const body = await formBody(request);
  const now = Date.now();
  const app = await authenticateClient(env, request, body, now);
  await requireConfidential(app);
  const token = body.token ?? "";
  const inactive = { active: false };
  if (!token) return corsJson(request, inactive);
  const { issuer } = publicBase(request, env);
  const refresh = await lookupRefresh(env.DB, token);
  if (refresh) {
    const active = refresh.revoked_at == null && refresh.expires_at > now && refresh.client_id === app.client_id;
    if (!active) return corsJson(request, inactive);
    return corsJson(request, {
      active: true,
      token_type: "refresh_token",
      client_id: refresh.client_id,
      sub: refresh.user_id,
      scope: refresh.scope,
      exp: Math.floor(refresh.expires_at / 1000),
      iss: issuer,
    });
  }
  const decoded = decodeJwt(token);
  const claims = await verifyJwtWithKeys(token, await verificationKeys(env));
  if (!decoded || !claims || claims.iss !== issuer || !isAccessJwt(decoded.header.typ, claims.token_use)) return corsJson(request, inactive);
  if (!tokenVisibleToClient(claims.client_id, claims.aud, app.client_id, app.resources)) return corsJson(request, inactive);
  if (claims.jti && (await isJtiRevoked(env.DB, claims.jti, now))) return corsJson(request, inactive);
  return corsJson(request, {
    active: true,
    token_type: "access_token",
    client_id: claims.client_id ?? (Array.isArray(claims.aud) ? claims.aud[0] : claims.aud),
    sub: claims.sub,
    scope: claims.scope,
    exp: claims.exp,
    iat: claims.iat,
    iss: claims.iss,
    aud: claims.aud,
    token_use: claims.token_use,
    jti: claims.jti,
  });
}

export async function handleRevoke(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(405, "method", "POST only.");
  await limit(env.REVOKE_LIMIT, request);
  const body = await formBody(request);
  const now = Date.now();
  const app = await authenticateClient(env, request, body, now);
  const token = body.token ?? "";
  if (!token) return new Response(null, { status: 200 });
  const refresh = await lookupRefresh(env.DB, token);
  if (refresh) {
    if (refresh.client_id === app.client_id) await revokeFamily(env.DB, refresh.family_id, now);
    return new Response(null, { status: 200 });
  }
  const decoded = decodeJwt(token);
  const claims = await verifyJwtWithKeys(token, await verificationKeys(env));
  if (!decoded || !claims || !isAccessJwt(decoded.header.typ, claims.token_use)) return new Response(null, { status: 200 });
  if (claims.client_id !== app.client_id || !claims.jti) return new Response(null, { status: 200 });
  const expMs = capExpiryMs(claims.exp * 1000, now, ACCESS_TTL_SEC * 1000);
  await revokeJti(env.DB, claims.jti, expMs);
  return new Response(null, { status: 200 });
}
