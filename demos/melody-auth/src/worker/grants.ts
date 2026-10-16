import { parseForm, parseObject, readBounded } from "./body";
import { authenticateClient, clientAllowsGrant } from "./clients";
import {
  attachCodeFamily,
  claimCode,
  getUserById,
  issueRefresh,
  lookupRefresh,
  revokeFamily,
  rotateRefreshAtomic,
} from "./db";
import { HttpError, OauthError } from "./errors";
import { corsJson, corsOauth } from "./headers";
import { decodeJwt, signJwt, verifyJwtWithKeys, type JwtClaims } from "./jwt";
import { signingContext, verificationKeys } from "./jwks";
import { publicBase } from "./origin";
import { verifyS256 } from "./pkce";
import {
  actClaim,
  audienceAllowed,
  deviceCodeForeign,
  exchangeExp,
  scopeSubset,
  subjectBoundToClient,
  tokenExchangeDenied,
} from "./policy";
import {
  appScopes,
  bumpDeviceInterval,
  consumeDevice,
  devicePollStatus,
  isJtiRevoked,
  lookupDeviceByCode,
  touchDevicePoll,
} from "./store";
import { mintForUser, mintTokens, wantsRefresh } from "./tokens";
import { ACCESS_TTL_SEC } from "../shared/types";
import { randomId } from "./encoding";
import { limit } from "./oidc";

async function readTokenBody(request: Request): Promise<Record<string, string>> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  const text = await readBounded(request, 8_000);
  if (type.includes("application/json")) {
    const obj = parseObject(text);
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj)) if (typeof value === "string") out[key] = value;
    return out;
  }
  return parseForm(text);
}

export async function handleToken(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(405, "method", "POST only.");
  await limit(env.TOKEN_LIMIT, request);
  const body = await readTokenBody(request);
  const grant = body.grant_type;
  const now = Date.now();

  if (grant === "password" || grant === "implicit") {
    return corsOauth(request,
      "unsupported_grant_type",
      "OAuth 2.1 removed the resource-owner password and implicit grants. Use authorization_code with PKCE.",
    );
  }

  if (grant === "authorization_code") {
    const app = await authenticateClient(env, request, body, now);
    if (!clientAllowsGrant(app, "authorization_code")) return corsOauth(request, "unauthorized_client", "This client cannot use that grant.");
    const code = body.code ?? "";
    const redirectUri = body.redirect_uri ?? "";
    const verifier = body.code_verifier ?? "";
    const row = await claimCode(env.DB, code, now);
    if (!row) return corsOauth(request, "invalid_grant", "The authorization request failed.");
    if (row.client_id !== app.client_id || row.redirect_uri !== redirectUri) {
      return corsOauth(request,"invalid_grant", "The authorization request failed.");
    }
    const challenge = row.code_challenge ?? "";
    if (challenge) {
      if (!(await verifyS256(verifier, challenge))) return corsOauth(request, "invalid_grant", "The authorization request failed.");
    } else if (verifier) {
      return corsOauth(request, "invalid_grant", "The authorization request failed.");
    }
    const user = await getUserById(env.DB, row.user_id, now);
    if (!user) return corsOauth(request, "invalid_grant", "The authorization request failed.");
    let refreshToken: string | undefined;
    let familyId: string | undefined;
    if (wantsRefresh(row.scope)) {
      const issued = await issueRefresh(env.DB, {
        userId: user.id,
        clientId: row.client_id,
        scope: row.scope,
        now,
        resource: row.resource,
        authTime: row.auth_time,
      });
      refreshToken = issued.token;
      familyId = issued.familyId;
      await attachCodeFamily(env.DB, row.id, issued.familyId);
    }
    const tokens = await mintTokens(env, request, {
      userId: user.id,
      email: user.email,
      emailVerified: user.email_verified === 1,
      clientId: row.client_id,
      scope: row.scope,
      nonce: row.nonce,
      familyId,
      refreshToken,
      now,
      resource: row.resource,
      authTime: row.auth_time ?? Math.floor(now / 1000),
    });
    return corsJson(request, tokens);
  }

  if (grant === "refresh_token") {
    const app = await authenticateClient(env, request, body, now);
    if (!clientAllowsGrant(app, "refresh_token")) return corsOauth(request, "unauthorized_client", "This client cannot use that grant.");
    const presented = body.refresh_token ?? "";
    const row = await lookupRefresh(env.DB, presented);
    if (!row) return corsOauth(request, "invalid_grant", "The authorization request failed.");
    if (row.client_id !== app.client_id) {
      await revokeFamily(env.DB, row.family_id, now);
      return corsOauth(request,"invalid_grant", "The authorization request failed.");
    }
    const user = await getUserById(env.DB, row.user_id, now);
    if (!user) {
      await revokeFamily(env.DB, row.family_id, now);
      return corsOauth(request,"invalid_grant", "The authorization request failed.");
    }
    const next = await rotateRefreshAtomic(env.DB, row, now);
    if (!next) return corsOauth(request, "invalid_grant", "The authorization request failed.");
    const tokens = await mintTokens(env, request, {
      userId: user.id,
      email: user.email,
      emailVerified: user.email_verified === 1,
      clientId: row.client_id,
      scope: row.scope,
      familyId: row.family_id,
      refreshToken: next.token,
      now,
      resource: row.resource,
      authTime: row.auth_time ?? Math.floor(now / 1000),
    });
    return corsJson(request, tokens);
  }

  if (grant === "client_credentials") {
    const app = await authenticateClient(env, request, body, now);
    if (app.client_type !== "confidential") return corsOauth(request, "unauthorized_client", "This client cannot use that grant.");
    if (!clientAllowsGrant(app, "client_credentials")) return corsOauth(request, "unauthorized_client", "This client cannot use that grant.");
    const { issuer } = publicBase(request, env);
    const ctx = await signingContext(env);
    const nowSec = Math.floor(now / 1000);
    const scope = scopeSubset(body.scope, app.scopes || "api");
    if (!scope) return corsOauth(request, "invalid_scope", "The requested scope is not allowed.");
    const audience = body.resource || body.audience || app.client_id;
    if (!audienceAllowed(audience, app.resources, app.client_id)) {
      return corsOauth(request, "invalid_target", "The requested audience is not allowed.");
    }
    const claims: JwtClaims = {
      iss: issuer,
      sub: app.client_id,
      aud: audience,
      iat: nowSec,
      exp: nowSec + ACCESS_TTL_SEC,
      token_use: "access",
      scope,
      client_id: app.client_id,
      jti: randomId("jti"),
    };
    const access = await signJwt({ alg: "ES256", typ: "at+jwt", kid: ctx.kid }, claims, ctx.key);
    return corsJson(request, {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SEC,
      scope,
    });
  }

  if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
    const app = await authenticateClient(env, request, body, now);
    if (!clientAllowsGrant(app, "urn:ietf:params:oauth:grant-type:device_code")) {
      return corsOauth(request,"unauthorized_client", "This client cannot use that grant.");
    }
    const deviceCode = body.device_code ?? "";
    const row = await lookupDeviceByCode(env.DB, deviceCode);
    if (deviceCodeForeign(row?.client_id, app.client_id)) return corsOauth(request, "invalid_grant", "The device code is unknown.");
    const status = devicePollStatus(row, now);
    if (status === "missing") return corsOauth(request, "invalid_grant", "The device code is unknown.");
    if (status === "expired") return corsOauth(request, "expired_token", "The device code expired.");
    if (status === "denied") return corsOauth(request, "access_denied", "The user denied the request.");
    if (status === "slow_down") {
      if (row) await bumpDeviceInterval(env.DB, row.id);
      return corsOauth(request,"slow_down", "Poll slower.", 400);
    }
    if (status === "pending") {
      if (row) await touchDevicePoll(env.DB, row.id, now);
      return corsOauth(request,"authorization_pending", "The user has not approved the request yet.", 400);
    }
    if (!row?.user_id) return corsOauth(request, "authorization_pending", "The user has not approved the request yet.", 400);
    const consumed = await consumeDevice(env.DB, row.id, now);
    if (!consumed?.user_id) return corsOauth(request, "invalid_grant", "The device code is unknown.");
    const scope = scopeSubset(consumed.scope, appScopes(app).join(" "));
    if (!scope) return corsOauth(request, "invalid_scope", "The requested scope is not allowed.");
    if (consumed.audience && !audienceAllowed(consumed.audience, app.resources, app.client_id)) {
      return corsOauth(request, "invalid_target", "The requested audience is not allowed.");
    }
    const tokens = await mintForUser(env, request, {
      userId: consumed.user_id,
      clientId: app.client_id,
      scope,
      now,
      resource: consumed.audience,
    });
    return corsJson(request, tokens);
  }

  if (grant === "urn:ietf:params:oauth:grant-type:token-exchange") {
    const app = await authenticateClient(env, request, body, now);
    if (tokenExchangeDenied(clientAllowsGrant(app, "urn:ietf:params:oauth:grant-type:token-exchange"), app.client_type)) {
      return corsOauth(request, "unauthorized_client", "This client cannot use that grant.");
    }
    const subject = body.subject_token ?? "";
    const type = body.subject_token_type ?? "";
    if (type && type !== "urn:ietf:params:oauth:token-type:access_token") {
      return corsOauth(request, "invalid_request", "Unsupported subject_token_type.");
    }
    const decoded = decodeJwt(subject);
    if (!decoded || decoded.header.typ !== "at+jwt") return corsOauth(request, "invalid_grant", "The subject token is invalid.");
    const { issuer } = publicBase(request, env);
    const claims = await verifyJwtWithKeys(subject, await verificationKeys(env));
    if (!claims || claims.iss !== issuer || claims.token_use !== "access") {
      return corsOauth(request, "invalid_grant", "The subject token is invalid.");
    }
    if (claims.jti && (await isJtiRevoked(env.DB, claims.jti, now))) {
      return corsOauth(request, "invalid_grant", "The subject token is invalid.");
    }
    if (!subjectBoundToClient(claims, app.client_id)) {
      return corsOauth(request, "invalid_grant", "The subject token is invalid.");
    }
    const user = await getUserById(env.DB, claims.sub, now);
    if (!user) return corsOauth(request, "invalid_grant", "The subject token is invalid.");
    const scope = scopeSubset(body.scope, claims.scope);
    if (!scope) return corsOauth(request, "invalid_scope", "The requested scope is not allowed.");
    const audience = body.audience || body.resource || app.client_id;
    if (!audienceAllowed(audience, app.resources, app.client_id)) {
      return corsOauth(request, "invalid_target", "The requested audience is not allowed.");
    }
    const ctx = await signingContext(env);
    const nowSec = Math.floor(now / 1000);
    const exp = exchangeExp(nowSec, claims.exp, ACCESS_TTL_SEC);
    if (exp == null) return corsOauth(request, "invalid_grant", "The subject token is invalid.");
    const next: JwtClaims = {
      iss: issuer,
      sub: claims.sub,
      aud: audience,
      iat: nowSec,
      exp,
      token_use: "access",
      scope,
      client_id: app.client_id,
      jti: randomId("jti"),
      azp: app.client_id,
      act: actClaim(app.client_id, claims.act),
    };
    const access = await signJwt({ alg: "ES256", typ: "at+jwt", kid: ctx.kid }, next, ctx.key);
    return corsJson(request, {
      access_token: access,
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      token_type: "Bearer",
      expires_in: exp - nowSec,
      scope,
    });
  }

  throw new OauthError(
    400,
    "unsupported_grant_type",
    "Use authorization_code, refresh_token, client_credentials, device_code, or token-exchange.",
  );
}
