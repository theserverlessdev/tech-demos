import { ACCESS_TTL_SEC, SAMPLE_CLIENT_ID, type AppConfig, type TokenResponse, type UserInfo } from "../shared/types";
import { parseForm, parseObject, readBounded, readCookie } from "./body";
import {
  appRedirects,
  claimCode,
  claimRefresh,
  createSession,
  createUser,
  deleteSession,
  getUserByEmail,
  getUserById,
  issueAuthCode,
  issueRefresh,
  revokeFamily,
  sessionUser,
  setReplacedBy,
} from "./db";
import { HttpError, OauthError } from "./errors";
import { html, json, oauthError } from "./headers";
import { clientKey } from "./ip";
import { importVerifyKey, signJwt, verifyJwt, type JwtClaims } from "./jwt";
import { jwksDocument, signingContext } from "./jwks";
import { originAllowed, publicBase } from "./origin";
import { authorizePage, errorPage, type AuthorizeFields } from "./pages";
import { emailShape, hashPassword, normalizeEmail, passwordShape, verifyPassword } from "./password";
import { challengeShape, verifyS256 } from "./pkce";
import { redirectUriAllowed } from "./redirect";
import { turnstileConfigured, verifyTurnstile } from "./turnstile";

const SESSION_COOKIE = "ma_session";
const HOST_SESSION_COOKIE = "__Host-ma_session";
const GENERIC_SIGNIN = "Email or password is incorrect.";
const GENERIC_SIGNUP = "Could not complete sign-up.";
const ALLOWED_SCOPES = new Set(["openid", "profile", "email"]);

export function stripBase(pathname: string): { path: string; onHub: boolean; rawPath: string } {
  const onHub = pathname === "/demos/melody-auth" || pathname.startsWith("/demos/melody-auth/");
  const path = onHub ? pathname.slice("/demos/melody-auth".length) || "/" : pathname;
  return { path, onHub, rawPath: pathname };
}

export function filterScopes(scope: string): string {
  return scope
    .split(/\s+/)
    .filter((part) => ALLOWED_SCOPES.has(part))
    .join(" ");
}

export async function limit(binding: RateLimit, request: Request): Promise<void> {
  const { success } = await binding.limit({ key: clientKey(request) });
  if (!success) throw new HttpError(429, "rate_limited", "Too many requests from this address. Wait a minute.");
}

function sessionCookieName(request: Request): string {
  const url = new URL(request.url);
  if (url.protocol === "https:" && url.hostname === "melody-auth.tech-demos.theserverless.dev") return HOST_SESSION_COOKIE;
  return SESSION_COOKIE;
}

function sessionFrom(request: Request): string | null {
  const header = request.headers.get("cookie");
  const url = new URL(request.url);
  if (url.hostname === "melody-auth.tech-demos.theserverless.dev") return readCookie(header, HOST_SESSION_COOKIE);
  return readCookie(header, HOST_SESSION_COOKIE) ?? readCookie(header, SESSION_COOKIE);
}

function sessionCookie(token: string, request: Request, onHub: boolean, maxAge: number): string {
  const name = sessionCookieName(request);
  const hostCookie = name === HOST_SESSION_COOKIE;
  const path = hostCookie ? "/" : onHub ? "/demos/melody-auth" : "/";
  const secure = hostCookie || new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${maxAge}${secure}`;
}

function clearSessionCookie(request: Request, onHub: boolean): string {
  return sessionCookie("deleted", request, onHub, 0);
}

function fieldsFrom(params: URLSearchParams | Record<string, string>): AuthorizeFields {
  const get = (key: string) => (params instanceof URLSearchParams ? params.get(key) ?? "" : params[key] ?? "");
  return {
    clientId: get("client_id"),
    redirectUri: get("redirect_uri"),
    state: get("state"),
    nonce: get("nonce"),
    scope: filterScopes(get("scope") || "openid email profile"),
    challenge: get("code_challenge"),
    method: get("code_challenge_method"),
    responseType: get("response_type"),
  };
}

function formActionOrigin(redirectUri: string): string | undefined {
  try {
    const parsed = new URL(redirectUri);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
  } catch {
    return undefined;
  }
  return undefined;
}

function formHtml(body: string, fields: AuthorizeFields, status = 200): Response {
  return html(body, status, undefined, formActionOrigin(fields.redirectUri));
}

async function validateAuthorize(
  env: Env,
  fields: AuthorizeFields,
): Promise<{ ok: true } | { ok: false; safe: boolean; message: string }> {
  if (!fields.clientId || !fields.redirectUri || !fields.state || !fields.nonce) {
    return { ok: false, safe: false, message: "The authorization request is missing required parameters." };
  }
  if (fields.responseType !== "code") {
    return { ok: false, safe: false, message: "response_type must be code." };
  }
  if (fields.state.length > 256 || fields.nonce.length > 256) {
    return { ok: false, safe: false, message: "state and nonce must be 256 characters or fewer." };
  }
  const registered = await appRedirects(env.DB, fields.clientId);
  const safe = redirectUriAllowed(fields.redirectUri, registered);
  if (!safe) return { ok: false, safe: false, message: "The redirect URI is not registered for this app." };
  if (fields.method !== "S256" || !challengeShape(fields.challenge)) {
    return { ok: false, safe: true, message: "PKCE S256 is required." };
  }
  if (!fields.scope.split(/\s+/).includes("openid")) return { ok: false, safe: true, message: "The openid scope is required." };
  return { ok: true };
}

function failRedirect(fields: AuthorizeFields, error: string, description: string): Response {
  const target = new URL(fields.redirectUri);
  target.searchParams.set("error", error);
  target.searchParams.set("error_description", description);
  target.searchParams.set("state", fields.state);
  return Response.redirect(target.toString(), 302);
}

function codeRedirect(fields: AuthorizeFields, code: string): Response {
  const target = new URL(fields.redirectUri);
  target.searchParams.set("code", code);
  target.searchParams.set("state", fields.state);
  return Response.redirect(target.toString(), 302);
}

export async function handleDiscovery(request: Request, env: Env): Promise<Response> {
  const { issuer } = publicBase(request, env);
  return json(
    {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      end_session_endpoint: `${issuer}/logout`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      id_token_signing_alg_values_supported: ["ES256"],
      scopes_supported: ["openid", "profile", "email"],
      claims_supported: ["iss", "sub", "aud", "exp", "iat", "nonce", "email", "email_verified"],
      token_endpoint_auth_methods_supported: ["none"],
      subject_types_supported: ["public"],
    },
    200,
    undefined,
    "public, max-age=300",
  );
}

export async function handleJwks(env: Env): Promise<Response> {
  return json(await jwksDocument(env), 200, undefined, "public, max-age=300");
}

export async function handleConfig(request: Request, env: Env): Promise<Response> {
  const { issuer, origin } = publicBase(request, env);
  const config: AppConfig = {
    turnstileSiteKey: env.TURNSTILE_SITE_KEY,
    turnstileConfigured: turnstileConfigured(env),
    issuer,
    clientId: SAMPLE_CLIENT_ID,
    redirectUri: `${origin}/`,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    userinfoEndpoint: `${issuer}/userinfo`,
    logoutEndpoint: `${issuer}/logout`,
    jwksUri: `${issuer}/.well-known/jwks.json`,
  };
  return json(config);
}

export async function handleAuthorizeGet(request: Request, env: Env, onHub: boolean): Promise<Response> {
  const url = new URL(request.url);
  const fields = fieldsFrom(url.searchParams);
  const basePath = onHub ? "/demos/melody-auth" : "";
  const checked = await validateAuthorize(env, fields);
  if (!checked.ok) return formHtml(errorPage(basePath, "Cannot continue", checked.message), fields, 400);
  const switchAccount = url.searchParams.get("switch") === "1";
  const user = switchAccount ? null : await sessionUser(env.DB, sessionFrom(request) ?? "", Date.now());
  const mode = url.searchParams.get("mode") === "signup" ? "signup" : "signin";
  return formHtml(
    authorizePage({
      basePath,
      siteKey: env.TURNSTILE_SITE_KEY,
      fields,
      mode,
      error: "",
      sessionEmail: user?.email ?? null,
    }),
    fields,
  );
}

export async function handleAuthorizePost(request: Request, env: Env, onHub: boolean): Promise<Response> {
  const basePath = onHub ? "/demos/melody-auth" : "";
  if (!originAllowed(request)) {
    return html(errorPage(basePath, "Cannot continue", "This request could not be verified."), 403);
  }
  const form = parseForm(await readBounded(request, 8_000));
  const fields = fieldsFrom(form);
  const email = normalizeEmail(form.email ?? "");
  const page = (
    mode: "signin" | "signup",
    error: string,
    status = 200,
    sessionEmail: string | null = null,
  ): Response =>
    formHtml(
      authorizePage({
        basePath,
        siteKey: env.TURNSTILE_SITE_KEY,
        fields,
        mode,
        error,
        sessionEmail,
        email,
      }),
      fields,
      status,
    );

  const checked = await validateAuthorize(env, fields);
  if (!checked.ok) {
    if (!checked.safe) return formHtml(errorPage(basePath, "Cannot continue", checked.message), fields, 400);
    return failRedirect(fields, "invalid_request", checked.message);
  }

  try {
    await limit(env.AUTH_LIMIT, request);
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) {
      return page(form.mode === "signup" ? "signup" : "signin", err.message, 429);
    }
    throw err;
  }

  const now = Date.now();
  const mode = form.mode === "signup" ? "signup" : form.mode === "continue" ? "continue" : "signin";

  if (mode === "continue") {
    const user = await sessionUser(env.DB, sessionFrom(request) ?? "", now);
    if (!user) return page("signin", GENERIC_SIGNIN);
    const code = await issueAuthCode(env.DB, {
      userId: user.id,
      clientId: fields.clientId,
      redirectUri: fields.redirectUri,
      challenge: fields.challenge,
      nonce: fields.nonce,
      scope: fields.scope,
      now,
    });
    return codeRedirect(fields, code);
  }

  if (!(await verifyTurnstile(env, request, form.turnstileToken ?? ""))) {
    return page(mode, "Turnstile did not pass.");
  }

  const password = form.password ?? "";
  let user = null as Awaited<ReturnType<typeof getUserByEmail>>;

  if (mode === "signup") {
    if (!emailShape(email) || !passwordShape(password)) return page("signup", GENERIC_SIGNUP);
    const hashed = await hashPassword(password);
    const existing = await getUserByEmail(env.DB, email, now);
    if (existing) return page("signup", GENERIC_SIGNUP);
    try {
      user = await createUser(env.DB, email, hashed.hash, hashed.salt, now);
    } catch {
      return page("signup", GENERIC_SIGNUP);
    }
  } else {
    const found = await getUserByEmail(env.DB, email, now);
    const ok = found ? await verifyPassword(password, found.password_hash, found.salt) : false;
    if (!found || !ok) {
      if (!found) await hashPassword(password);
      return page("signin", GENERIC_SIGNIN);
    }
    user = found;
  }

  const sessionId = await createSession(env.DB, user.id, now);
  const code = await issueAuthCode(env.DB, {
    userId: user.id,
    clientId: fields.clientId,
    redirectUri: fields.redirectUri,
    challenge: fields.challenge,
    nonce: fields.nonce,
    scope: fields.scope,
    now,
  });
  const headers = new Headers({ location: codeRedirect(fields, code).headers.get("location") ?? fields.redirectUri });
  headers.append("set-cookie", sessionCookie(sessionId, request, onHub, 30 * 60));
  return new Response(null, { status: 302, headers });
}

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

async function mintTokens(
  env: Env,
  request: Request,
  input: { userId: string; email: string; clientId: string; scope: string; nonce?: string; familyId?: string; now: number; refreshToken?: string },
): Promise<TokenResponse> {
  const { issuer } = publicBase(request, env);
  const ctx = await signingContext(env);
  const nowSec = Math.floor(input.now / 1000);
  const header = { alg: "ES256" as const, typ: "JWT" as const, kid: ctx.kid };
  const accessClaims: JwtClaims = {
    iss: issuer,
    sub: input.userId,
    aud: input.clientId,
    iat: nowSec,
    exp: nowSec + ACCESS_TTL_SEC,
    token_use: "access",
    scope: input.scope,
    email: input.email,
    email_verified: false,
  };
  const idClaims: JwtClaims = {
    iss: issuer,
    sub: input.userId,
    aud: input.clientId,
    iat: nowSec,
    exp: nowSec + ACCESS_TTL_SEC,
    token_use: "id",
    nonce: input.nonce,
    email: input.email,
    email_verified: false,
  };
  const refreshToken =
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
  return {
    access_token: await signJwt(header, accessClaims, ctx.key),
    id_token: await signJwt(header, idClaims, ctx.key),
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SEC,
    scope: input.scope,
  };
}

export async function handleToken(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(405, "method", "POST only.");
  if (!originAllowed(request)) throw new HttpError(403, "origin", "Origin not allowed.");
  await limit(env.TOKEN_LIMIT, request);
  const body = await readTokenBody(request);
  const grant = body.grant_type;
  const now = Date.now();

  if (grant === "authorization_code") {
    const code = body.code ?? "";
    const redirectUri = body.redirect_uri ?? "";
    const clientId = body.client_id ?? "";
    const verifier = body.code_verifier ?? "";
    const row = await claimCode(env.DB, code, now);
    if (!row) return oauthError("invalid_grant", "The authorization request failed.");
    if (row.client_id !== clientId || row.redirect_uri !== redirectUri) {
      return oauthError("invalid_grant", "The authorization request failed.");
    }
    if (!(await verifyS256(verifier, row.code_challenge))) {
      return oauthError("invalid_grant", "The authorization request failed.");
    }
    const user = await getUserById(env.DB, row.user_id, now);
    if (!user) return oauthError("invalid_grant", "The authorization request failed.");
    const tokens = await mintTokens(env, request, {
      userId: user.id,
      email: user.email,
      clientId: row.client_id,
      scope: row.scope,
      nonce: row.nonce,
      now,
    });
    return json(tokens);
  }

  if (grant === "refresh_token") {
    const presented = body.refresh_token ?? "";
    const clientId = body.client_id ?? "";
    const row = await claimRefresh(env.DB, presented, now);
    if (!row) return oauthError("invalid_grant", "The authorization request failed.");
    if (row.client_id !== clientId) {
      await revokeFamily(env.DB, row.family_id, now);
      return oauthError("invalid_grant", "The authorization request failed.");
    }
    const user = await getUserById(env.DB, row.user_id, now);
    if (!user) {
      await revokeFamily(env.DB, row.family_id, now);
      return oauthError("invalid_grant", "The authorization request failed.");
    }
    const next = await issueRefresh(env.DB, {
      userId: row.user_id,
      clientId: row.client_id,
      scope: row.scope,
      familyId: row.family_id,
      now,
    });
    await setReplacedBy(env.DB, row.id, next.id);
    const tokens = await mintTokens(env, request, {
      userId: user.id,
      email: user.email,
      clientId: row.client_id,
      scope: row.scope,
      familyId: row.family_id,
      refreshToken: next.token,
      now,
    });
    return json(tokens);
  }

  throw new OauthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
}

export async function handleUserinfo(request: Request, env: Env): Promise<Response> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match?.[1]) throw new HttpError(401, "unauthorized", "A bearer token is required.");
  const ctx = await signingContext(env);
  const { issuer } = publicBase(request, env);
  const claims = await verifyJwt(match[1], await importVerifyKey(ctx.publicJwk));
  if (!claims || claims.iss !== issuer || claims.token_use !== "access") {
    throw new HttpError(401, "unauthorized", "A bearer token is required.");
  }
  const user = await getUserById(env.DB, claims.sub, Date.now());
  if (!user) throw new HttpError(401, "unauthorized", "A bearer token is required.");
  const info: UserInfo = { sub: user.id, email: user.email, email_verified: false };
  return json(info);
}

export async function handleLogout(request: Request, env: Env, onHub: boolean): Promise<Response> {
  const url = new URL(request.url);
  const sessionId = sessionFrom(request);
  if (sessionId) await deleteSession(env.DB, sessionId);
  const target = url.searchParams.get("post_logout_redirect_uri") ?? "";
  const clientId = url.searchParams.get("client_id") ?? SAMPLE_CLIENT_ID;
  const headers = new Headers();
  headers.append("set-cookie", clearSessionCookie(request, onHub));
  if (target) {
    const allowed = await appRedirects(env.DB, clientId);
    if (redirectUriAllowed(target, allowed)) {
      headers.set("location", target);
      return new Response(null, { status: 302, headers });
    }
  }
  const basePath = onHub ? "/demos/melody-auth" : "";
  headers.set("location", `${basePath}/`);
  return new Response(null, { status: 302, headers });
}

export function oauthErrorResponse(err: unknown): Response {
  if (err instanceof OauthError) return oauthError(err.error, err.description, err.status);
  throw err;
}
