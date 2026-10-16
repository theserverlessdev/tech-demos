import { ACCESS_TTL_SEC, type TokenResponse } from "../shared/types";
import { attachCodeFamily, getUserById, issueRefresh } from "./db";
import { randomId } from "./encoding";
import { signJwt, type JwtClaims } from "./jwt";
import { signingContext } from "./jwks";
import { publicBase } from "./origin";

export function wantsRefresh(scope: string): boolean {
  return scope.split(/\s+/).includes("offline_access");
}

export async function mintTokens(
  env: Env,
  request: Request,
  input: {
    userId: string;
    email: string;
    emailVerified: boolean;
    clientId: string;
    scope: string;
    nonce?: string;
    familyId?: string;
    now: number;
    refreshToken?: string;
    resource?: string | null;
    authTime?: number;
    skipRefresh?: boolean;
  },
): Promise<TokenResponse> {
  const { issuer } = publicBase(request, env);
  const ctx = await signingContext(env);
  const nowSec = Math.floor(input.now / 1000);
  const jti = randomId("jti");
  const audience = input.resource || input.clientId;
  const accessHeader = { alg: "ES256" as const, typ: "at+jwt" as const, kid: ctx.kid };
  const idHeader = { alg: "ES256" as const, typ: "JWT" as const, kid: ctx.kid };
  const accessClaims: JwtClaims = {
    iss: issuer,
    sub: input.userId,
    aud: audience,
    iat: nowSec,
    exp: nowSec + ACCESS_TTL_SEC,
    token_use: "access",
    scope: input.scope,
    email: input.email,
    email_verified: input.emailVerified,
    client_id: input.clientId,
    jti,
    azp: input.clientId,
    auth_time: input.authTime ?? nowSec,
  };
  const access = await signJwt(accessHeader, accessClaims, ctx.key);
  const out: TokenResponse = {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SEC,
    scope: input.scope,
  };
  if (input.nonce !== undefined || input.scope.split(/\s+/).includes("openid")) {
    const idClaims: JwtClaims = {
      iss: issuer,
      sub: input.userId,
      aud: input.clientId,
      iat: nowSec,
      exp: nowSec + ACCESS_TTL_SEC,
      token_use: "id",
      nonce: input.nonce,
      email: input.email,
      email_verified: input.emailVerified,
      azp: input.clientId,
      auth_time: input.authTime ?? nowSec,
    };
    out.id_token = await signJwt(idHeader, idClaims, ctx.key);
  }
  if (!input.skipRefresh && wantsRefresh(input.scope)) {
    out.refresh_token =
      input.refreshToken ??
      (
        await issueRefresh(env.DB, {
          userId: input.userId,
          clientId: input.clientId,
          scope: input.scope,
          familyId: input.familyId,
          now: input.now,
        })
      ).token;
  }
  return out;
}

export async function mintForUser(
  env: Env,
  request: Request,
  input: {
    userId: string;
    clientId: string;
    scope: string;
    nonce?: string;
    now: number;
    resource?: string | null;
    authTime?: number;
    attachCodeId?: string;
  },
): Promise<TokenResponse> {
  const user = await getUserById(env.DB, input.userId, input.now);
  if (!user) throw new Error("user");
  let refreshToken: string | undefined;
  let familyId: string | undefined;
  if (wantsRefresh(input.scope)) {
    const issued = await issueRefresh(env.DB, {
      userId: user.id,
      clientId: input.clientId,
      scope: input.scope,
      now: input.now,
    });
    refreshToken = issued.token;
    familyId = issued.familyId;
    if (input.attachCodeId) await attachCodeFamily(env.DB, input.attachCodeId, issued.familyId);
  }
  return mintTokens(env, request, {
    userId: user.id,
    email: user.email,
    emailVerified: user.email_verified === 1,
    clientId: input.clientId,
    scope: input.scope,
    nonce: input.nonce,
    familyId,
    refreshToken,
    now: input.now,
    resource: input.resource,
    authTime: input.authTime,
  });
}
