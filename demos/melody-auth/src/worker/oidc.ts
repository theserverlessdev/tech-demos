import {
  SAMPLE_CLIENT_ID,
  STANDARD_SCOPES,
  type AppConfig,
  type UserInfo,
} from "../shared/types";
import { parseForm, readBounded } from "./body";
import {
  appRedirects,
  createSession,
  createUser,
  deleteExpiredUserByEmail,
  deleteSession,
  getUserByEmail,
  getUserById,
  issueAuthCode,
} from "./db";
import { envSecret } from "./clients";
import { HttpError, OauthError } from "./errors";
import { corsJson, html, json } from "./headers";
import { clientKey } from "./ip";
import { decodeJwt, verifyJwtWithKeys } from "./jwt";
import { jwksDocument, verificationKeys } from "./jwks";
import { originAllowed, publicBase } from "./origin";
import { authorizePage, consentPage, errorPage, formPostPage, type AuthorizeFields } from "./pages";
import { emailShape, hashPassword, normalizeEmail, passwordShape, verifyPassword } from "./password";
import { challengeShape } from "./pkce";
import { redirectUriAllowed } from "./redirect";
import { clearSessionCookie, sessionCookie, sessionFrom } from "./session";
import { audienceAllowed, isAccessJwt, isDcrClient, mayPostLogoutRedirect } from "./policy";
import { appScopes, consentFor, getFullApp, isJtiRevoked, loadPar, parseJsonList, rememberConsent, scopesCovered, sessionAuthTime, type FullApp } from "./store";
import { turnstileConfigured, verifyTurnstile } from "./turnstile";

const GENERIC_SIGNIN = "Email or password is incorrect.";
const GENERIC_SIGNUP = "Could not complete sign-up.";
const ALLOWED_SCOPES = new Set<string>([...STANDARD_SCOPES]);

export function stripBase(pathname: string): { path: string; onHub: boolean; rawPath: string } {
  const onHub = pathname === "/demos/melody-auth" || pathname.startsWith("/demos/melody-auth/");
  const path = onHub ? pathname.slice("/demos/melody-auth".length) || "/" : pathname;
  return { path, onHub, rawPath: pathname };
}

export function filterScopes(scope: string, extra: string[] = []): string {
  const allow = new Set([...ALLOWED_SCOPES, ...extra]);
  return scope
    .split(/\s+/)
    .filter((part) => allow.has(part))
    .join(" ");
}

/** Authorize and device authorization keep only scopes the app itself registered. */
export function filterToAppScopes(scope: string, allowed: string[]): string {
  const allow = new Set(allowed);
  return scope
    .split(/\s+/)
    .filter((part) => allow.has(part))
    .join(" ");
}

export async function limit(binding: RateLimit, request: Request): Promise<void> {
  const { success } = await binding.limit({ key: clientKey(request) });
  if (!success) throw new HttpError(429, "rate_limited", "Too many requests from this address. Wait a minute.");
}

export function fieldsFrom(params: URLSearchParams | Record<string, string>): AuthorizeFields {
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
    prompt: get("prompt"),
    maxAge: get("max_age"),
    loginHint: get("login_hint"),
    resource: get("resource"),
    responseMode: get("response_mode"),
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

export async function resolveAuthorizeFields(
  env: Env,
  params: URLSearchParams | Record<string, string>,
  now: number,
): Promise<AuthorizeFields> {
  const get = (key: string) => (params instanceof URLSearchParams ? params.get(key) ?? "" : params[key] ?? "");
  const requestUri = get("request_uri");
  const clientId = get("client_id");
  if (requestUri && clientId) {
    const payload = await loadPar(env.DB, requestUri, clientId, now);
    if (!payload) throw new OauthError(400, "invalid_request", "The request_uri is invalid or expired.");
    return fieldsFrom({ ...payload, client_id: clientId });
  }
  return fieldsFrom(params);
}

export async function validateAuthorize(
  env: Env,
  fields: AuthorizeFields,
): Promise<{ ok: true; app: FullApp } | { ok: false; safe: boolean; message: string }> {
  if (!fields.clientId || !fields.redirectUri || !fields.state || !fields.nonce) {
    return { ok: false, safe: false, message: "The authorization request is missing required parameters." };
  }
  if (fields.responseType !== "code") {
    return { ok: false, safe: false, message: "response_type must be code." };
  }
  if (fields.responseMode && fields.responseMode !== "query" && fields.responseMode !== "form_post") {
    return { ok: false, safe: false, message: "response_mode must be query or form_post." };
  }
  if (fields.state.length > 256 || fields.nonce.length > 256) {
    return { ok: false, safe: false, message: "state and nonce must be 256 characters or fewer." };
  }
  const app = await getFullApp(env.DB, fields.clientId);
  if (!app) return { ok: false, safe: false, message: "The redirect URI is not registered for this app." };
  const uris = parseJsonList(app.redirect_uris, await appRedirects(env.DB, fields.clientId));
  const safe = redirectUriAllowed(fields.redirectUri, uris);
  if (!safe) return { ok: false, safe: false, message: "The redirect URI is not registered for this app." };
  const requirePkce = app.require_pkce !== 0;
  if (requirePkce && (fields.method !== "S256" || !challengeShape(fields.challenge))) {
    return { ok: false, safe: true, message: "PKCE S256 is required." };
  }
  fields.scope = filterToAppScopes(fields.scope, appScopes(app));
  if (!fields.scope.split(/\s+/).includes("openid")) return { ok: false, safe: true, message: "The openid scope is required." };
  if (fields.resource && !audienceAllowed(fields.resource, app.resources, app.client_id)) {
    return { ok: false, safe: true, message: "The resource is not allowed for this client." };
  }
  return { ok: true, app };
}

export function failRedirect(fields: AuthorizeFields, error: string, description: string, issuer = "", assetBase = ""): Response {
  if (fields.responseMode === "form_post") {
    return html(
      formPostPage(fields.redirectUri, { error, error_description: description, state: fields.state, ...(issuer ? { iss: issuer } : {}) }, assetBase),
      200,
      undefined,
      formActionOrigin(fields.redirectUri),
    );
  }
  const target = new URL(fields.redirectUri);
  target.searchParams.set("error", error);
  target.searchParams.set("error_description", description);
  target.searchParams.set("state", fields.state);
  if (issuer) target.searchParams.set("iss", issuer);
  return Response.redirect(target.toString(), 302);
}

export function codeRedirect(fields: AuthorizeFields, code: string, issuer = "", assetBase = ""): Response {
  if (fields.responseMode === "form_post") {
    return html(
      formPostPage(fields.redirectUri, { code, state: fields.state, ...(issuer ? { iss: issuer } : {}) }, assetBase),
      200,
      undefined,
      formActionOrigin(fields.redirectUri),
    );
  }
  const target = new URL(fields.redirectUri);
  target.searchParams.set("code", code);
  target.searchParams.set("state", fields.state);
  if (issuer) target.searchParams.set("iss", issuer);
  return Response.redirect(target.toString(), 302);
}

export function discoveryDocument(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    end_session_endpoint: `${issuer}/logout`,
    revocation_endpoint: `${issuer}/revoke`,
    introspection_endpoint: `${issuer}/introspect`,
    registration_endpoint: `${issuer}/register`,
    device_authorization_endpoint: `${issuer}/device_authorization`,
    pushed_authorization_request_endpoint: `${issuer}/par`,
    response_types_supported: ["code"],
    response_modes_supported: ["query", "form_post"],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      "client_credentials",
      "urn:ietf:params:oauth:grant-type:device_code",
      "urn:ietf:params:oauth:grant-type:token-exchange",
    ],
    code_challenge_methods_supported: ["S256"],
    id_token_signing_alg_values_supported: ["ES256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post", "private_key_jwt"],
    token_endpoint_auth_signing_alg_values_supported: ["ES256"],
    scopes_supported: [...STANDARD_SCOPES],
    claims_supported: ["iss", "sub", "aud", "exp", "iat", "nonce", "email", "email_verified", "auth_time", "azp", "jti", "client_id"],
    subject_types_supported: ["public"],
    request_parameter_supported: false,
    request_uri_parameter_supported: true,
    require_request_uri_registration: false,
    authorization_response_iss_parameter_supported: true,
    prompt_values_supported: ["none", "login", "consent"],
    introspection_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "private_key_jwt"],
    revocation_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "private_key_jwt"],
  };
}

export function federationList(env: Env): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  if (envSecret(env, "GOOGLE_CLIENT_ID")) out.push({ id: "google", label: "Google" });
  if (envSecret(env, "GITHUB_CLIENT_ID")) out.push({ id: "github", label: "GitHub" });
  if (envSecret(env, "MICROSOFT_CLIENT_ID")) out.push({ id: "microsoft", label: "Microsoft" });
  if (envSecret(env, "OIDC_ISSUER") && envSecret(env, "OIDC_CLIENT_ID")) out.push({ id: "oidc", label: "OpenID" });
  return out;
}

export async function handleDiscovery(request: Request, env: Env): Promise<Response> {
  const { issuer } = publicBase(request, env);
  return corsJson(request, discoveryDocument(issuer), 200, "public, max-age=300");
}

export async function handleJwks(request: Request, env: Env): Promise<Response> {
  return corsJson(request, await jwksDocument(env), 200, "public, max-age=300");
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
    introspectionEndpoint: `${issuer}/introspect`,
    revocationEndpoint: `${issuer}/revoke`,
    deviceAuthorizationEndpoint: `${issuer}/device_authorization`,
    registrationEndpoint: `${issuer}/register`,
    parEndpoint: `${issuer}/par`,
    federation: federationList(env),
  };
  return json(config);
}

async function needsConsent(env: Env, userId: string, fields: AuthorizeFields, now: number, force: boolean): Promise<boolean> {
  if (force || fields.prompt.split(/\s+/).includes("consent")) return true;
  const granted = await consentFor(env.DB, userId, fields.clientId, now);
  return !granted || !scopesCovered(granted, fields.scope);
}

export async function completeAuthorize(
  env: Env,
  request: Request,
  onHub: boolean,
  fields: AuthorizeFields,
  user: { id: string; email: string },
  authTime: number,
  now: number,
  sessionId?: string,
): Promise<Response> {
  const forceConsent = fields.prompt.split(/\s+/).includes("consent");
  const consentNeeded = await needsConsent(env, user.id, fields, now, forceConsent);
  const { issuer } = publicBase(request, env);
  if (fields.prompt.split(/\s+/).includes("none")) {
    if (consentNeeded) return failRedirect(fields, "consent_required", "Consent is required.", issuer, onHub ? "/demos/melody-auth" : "");
  }
  if (consentNeeded && !fields.prompt.split(/\s+/).includes("none")) {
    const app = await getFullApp(env.DB, fields.clientId);
    let redirectHost = "";
    try {
      redirectHost = new URL(fields.redirectUri).host;
    } catch {
      redirectHost = "";
    }
    const page = formHtml(
      consentPage({
        basePath: onHub ? "/demos/melody-auth" : "",
        fields,
        clientName: app?.name ?? fields.clientId,
        email: user.email,
        scopes: fields.scope.split(/\s+/).filter(Boolean),
        redirectHost,
        unverified: isDcrClient(fields.clientId, app?.registration_access_hash),
      }),
      fields,
    );
    if (!sessionId) return page;
    const headers = new Headers(page.headers);
    headers.append("set-cookie", sessionCookie(sessionId, request, onHub, 30 * 60));
    return new Response(page.body, { status: page.status, headers });
  }
  const code = await issueAuthCode(env.DB, {
    userId: user.id,
    clientId: fields.clientId,
    redirectUri: fields.redirectUri,
    challenge: fields.challenge,
    nonce: fields.nonce,
    scope: fields.scope,
    now,
    resource: fields.resource || undefined,
    authTime,
  });
  const redirect = codeRedirect(fields, code, issuer, onHub ? "/demos/melody-auth" : "");
  if (!sessionId) return redirect;
  const headers = new Headers(redirect.headers);
  if (redirect.status === 200) {
    const body = await redirect.text();
    headers.append("set-cookie", sessionCookie(sessionId, request, onHub, 30 * 60));
    return new Response(body, { status: 200, headers });
  }
  headers.append("set-cookie", sessionCookie(sessionId, request, onHub, 30 * 60));
  return new Response(null, { status: 302, headers });
}

export async function handleAuthorizeGet(request: Request, env: Env, onHub: boolean): Promise<Response> {
  const url = new URL(request.url);
  const now = Date.now();
  const fields = await resolveAuthorizeFields(env, url.searchParams, now);
  const basePath = onHub ? "/demos/melody-auth" : "";
  const checked = await validateAuthorize(env, fields);
  if (!checked.ok) return html(errorPage(basePath, "Cannot continue", checked.message), 400);
  const switchAccount = url.searchParams.get("switch") === "1" || fields.prompt.split(/\s+/).includes("login");
  const session = switchAccount ? null : await sessionAuthTime(env.DB, sessionFrom(request) ?? "", now);
  const maxAge = Number(fields.maxAge);
  const tooOld = session && Number.isFinite(maxAge) && fields.maxAge !== "" && now / 1000 - session.authTime > maxAge;
  if (fields.prompt.split(/\s+/).includes("none")) {
    if (!session || tooOld) return failRedirect(fields, "login_required", "Sign-in is required.", publicBase(request, env).issuer, basePath);
    return completeAuthorize(env, request, onHub, fields, session.user, session.authTime, now);
  }
  const user = tooOld ? null : session?.user ?? null;
  const mode = url.searchParams.get("mode") === "signup" ? "signup" : "signin";
  return formHtml(
    authorizePage({
      basePath,
      siteKey: env.TURNSTILE_SITE_KEY,
      fields,
      mode,
      error: "",
      sessionEmail: user?.email ?? null,
      email: fields.loginHint,
      providers: federationList(env),
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
  const now = Date.now();
  const fields = await resolveAuthorizeFields(env, form, now);
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
        providers: federationList(env),
      }),
      fields,
      status,
    );

  const checked = await validateAuthorize(env, fields);
  if (!checked.ok) {
    if (!checked.safe) return html(errorPage(basePath, "Cannot continue", checked.message), 400);
    return failRedirect(fields, "invalid_request", checked.message, publicBase(request, env).issuer, basePath);
  }

  try {
    await limit(env.AUTH_LIMIT, request);
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) {
      return page(form.mode === "signup" ? "signup" : "signin", err.message, 429);
    }
    throw err;
  }

  const mode = form.mode === "signup" ? "signup" : form.mode === "continue" ? "continue" : "signin";

  if (mode === "continue") {
    const session = await sessionAuthTime(env.DB, sessionFrom(request) ?? "", now);
    if (!session) return page("signin", GENERIC_SIGNIN);
    return completeAuthorize(env, request, onHub, fields, session.user, session.authTime, now);
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
    await deleteExpiredUserByEmail(env.DB, email, now);
    try {
      user = await createUser(env.DB, email, hashed.hash, hashed.salt, now, false);
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
  return completeAuthorize(env, request, onHub, fields, user, Math.floor(now / 1000), now, sessionId);
}

export async function handleConsentPost(request: Request, env: Env, onHub: boolean): Promise<Response> {
  const basePath = onHub ? "/demos/melody-auth" : "";
  if (!originAllowed(request)) {
    return html(errorPage(basePath, "Cannot continue", "This request could not be verified."), 403);
  }
  await limit(env.AUTH_LIMIT, request);
  const form = parseForm(await readBounded(request, 8_000));
  const now = Date.now();
  const fields = fieldsFrom(form);
  const checked = await validateAuthorize(env, fields);
  if (!checked.ok) {
    if (!checked.safe) return html(errorPage(basePath, "Cannot continue", checked.message), 400);
    return failRedirect(fields, "invalid_request", checked.message, publicBase(request, env).issuer, basePath);
  }
  const session = await sessionAuthTime(env.DB, sessionFrom(request) ?? "", now);
  if (!session) return html(errorPage(basePath, "Cannot continue", "Sign in first."), 401);
  if (form.decision !== "allow") return failRedirect(fields, "access_denied", "The user denied the request.", publicBase(request, env).issuer, basePath);
  await rememberConsent(env.DB, session.user.id, fields.clientId, fields.scope, now);
  const code = await issueAuthCode(env.DB, {
    userId: session.user.id,
    clientId: fields.clientId,
    redirectUri: fields.redirectUri,
    challenge: fields.challenge,
    nonce: fields.nonce,
    scope: fields.scope,
    now,
    resource: fields.resource || undefined,
    authTime: session.authTime,
  });
  return codeRedirect(fields, code, publicBase(request, env).issuer, basePath);
}

export async function handleUserinfo(request: Request, env: Env): Promise<Response> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match?.[1]) throw new HttpError(401, "unauthorized", "A bearer token is required.");
  const { issuer } = publicBase(request, env);
  const decoded = decodeJwt(match[1]);
  const claims = await verifyJwtWithKeys(match[1], await verificationKeys(env));
  if (!decoded || !claims || claims.iss !== issuer || !isAccessJwt(decoded.header.typ, claims.token_use)) {
    throw new HttpError(401, "unauthorized", "A bearer token is required.");
  }
  const now = Date.now();
  if (claims.jti && (await isJtiRevoked(env.DB, claims.jti, now))) {
    throw new HttpError(401, "unauthorized", "A bearer token is required.");
  }
  const scopes = new Set((claims.scope ?? "").split(/\s+/).filter(Boolean));
  if (!scopes.has("openid")) throw new HttpError(403, "insufficient_scope", "The openid scope is required.");
  const user = await getUserById(env.DB, claims.sub, now);
  if (!user) throw new HttpError(401, "unauthorized", "A bearer token is required.");
  const info: UserInfo = { sub: user.id };
  if (scopes.has("email")) {
    info.email = user.email;
    info.email_verified = user.email_verified === 1;
  }
  if (scopes.has("profile")) info.name = user.email.split("@")[0];
  return corsJson(request, info);
}

export async function handleLogout(request: Request, env: Env, onHub: boolean): Promise<Response> {
  const url = new URL(request.url);
  const sessionId = sessionFrom(request);
  if (sessionId) await deleteSession(env.DB, sessionId);
  let target = url.searchParams.get("post_logout_redirect_uri") ?? "";
  let clientId = url.searchParams.get("client_id") ?? "";
  const hint = url.searchParams.get("id_token_hint") ?? "";
  if (hint) {
    const claims = await verifyJwtWithKeys(hint, await verificationKeys(env), Math.floor(Date.now() / 1000), { ignoreExp: true });
    const aud = claims?.aud;
    const fromAud = Array.isArray(aud) ? aud[0] : aud;
    if (fromAud) clientId = fromAud;
  }
  const headers = new Headers();
  headers.append("set-cookie", clearSessionCookie(request, onHub));
  const app = clientId ? await getFullApp(env.DB, clientId) : null;
  if (target && app && mayPostLogoutRedirect(app.client_id, app.registration_access_hash)) {
    const allowed = parseJsonList(app.post_logout_redirect_uris, []);
    if (allowed.length && redirectUriAllowed(target, allowed)) {
      headers.set("location", target);
      return new Response(null, { status: 302, headers });
    }
  }
  const basePath = onHub ? "/demos/melody-auth" : "";
  headers.set("location", `${basePath}/`);
  return new Response(null, { status: 302, headers });
}
