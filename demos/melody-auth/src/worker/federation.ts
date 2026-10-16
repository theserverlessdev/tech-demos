import { createSession } from "./db";
import { envSecret } from "./clients";
import { HttpError } from "./errors";
import { html } from "./headers";
import { randomBytes, toBase64Url } from "./encoding";
import { completeAuthorize, limit, resolveAuthorizeFields, validateAuthorize } from "./oidc";
import { originAllowed, publicBase } from "./origin";
import { errorPage } from "./pages";
import { sessionCookie } from "./session";
import { findFederated, linkFederated, userForVerifiedEmail } from "./store";

type FedState = {
  provider: string;
  verifier: string;
  nonce: string;
  returnTo: string;
  createdAt: number;
};

function providerConfig(env: Env, id: string): { issuer?: string; authorize: string; token: string; userinfo?: string; clientId: string; secret: string; scope: string } | null {
  if (id === "google") {
    const clientId = envSecret(env, "GOOGLE_CLIENT_ID");
    if (!clientId) return null;
    return {
      issuer: "https://accounts.google.com",
      authorize: "https://accounts.google.com/o/oauth2/v2/auth",
      token: "https://oauth2.googleapis.com/token",
      clientId,
      secret: envSecret(env, "GOOGLE_CLIENT_SECRET"),
      scope: "openid email profile",
    };
  }
  if (id === "github") {
    const clientId = envSecret(env, "GITHUB_CLIENT_ID");
    if (!clientId) return null;
    return {
      authorize: "https://github.com/login/oauth/authorize",
      token: "https://github.com/login/oauth/access_token",
      userinfo: "https://api.github.com/user",
      clientId,
      secret: envSecret(env, "GITHUB_CLIENT_SECRET"),
      scope: "read:user user:email",
    };
  }
  if (id === "microsoft") {
    const clientId = envSecret(env, "MICROSOFT_CLIENT_ID");
    if (!clientId) return null;
    return {
      issuer: "https://login.microsoftonline.com/common/v2.0",
      authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      clientId,
      secret: envSecret(env, "MICROSOFT_CLIENT_SECRET"),
      scope: "openid email profile",
    };
  }
  if (id === "oidc") {
    const issuer = envSecret(env, "OIDC_ISSUER").replace(/\/$/, "");
    const clientId = envSecret(env, "OIDC_CLIENT_ID");
    if (!issuer || !clientId) return null;
    return {
      issuer,
      authorize: `${issuer}/authorize`,
      token: `${issuer}/token`,
      clientId,
      secret: envSecret(env, "OIDC_CLIENT_SECRET"),
      scope: "openid email profile",
    };
  }
  return null;
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

export async function handleFederationStart(request: Request, env: Env, provider: string, onHub: boolean): Promise<Response> {
  await limit(env.FED_LIMIT, request);
  const cfg = providerConfig(env, provider);
  const basePath = onHub ? "/demos/melody-auth" : "";
  if (!cfg) return html(errorPage(basePath, "Provider unavailable", "That sign-in provider is not configured."), 404);
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("return_to") ?? "/";
  const verifier = toBase64Url(randomBytes(32));
  const nonce = toBase64Url(randomBytes(16));
  const state = toBase64Url(randomBytes(16));
  const packed: FedState = { provider, verifier, nonce, returnTo, createdAt: Date.now() };
  await env.KEYS.put(`fed:${state}`, JSON.stringify(packed), { expirationTtl: 600 });
  const { issuer } = publicBase(request, env);
  const redirectUri = `${issuer}/fed/${provider}/callback`;
  const authorize = new URL(cfg.authorize);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", cfg.clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", cfg.scope);
  authorize.searchParams.set("state", state);
  if (cfg.issuer) {
    authorize.searchParams.set("nonce", nonce);
    authorize.searchParams.set("code_challenge", await s256(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");
  }
  return Response.redirect(authorize.toString(), 302);
}

type TokenJson = { access_token?: string; id_token?: string };

async function exchange(cfg: NonNullable<ReturnType<typeof providerConfig>>, code: string, redirectUri: string, verifier: string): Promise<TokenJson> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.secret,
  });
  if (cfg.issuer) body.set("code_verifier", verifier);
  const res = await fetch(cfg.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  return (await res.json()) as TokenJson;
}

function jwtEmail(idToken: string | undefined): { email: string; sub: string; verified: boolean } | null {
  if (!idToken) return null;
  const part = idToken.split(".")[1];
  if (!part) return null;
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const claims = JSON.parse(atob(padded)) as { email?: string; sub?: string; email_verified?: boolean | string };
    if (!claims.email || !claims.sub) return null;
    const verified = claims.email_verified === true || claims.email_verified === "true";
    return { email: claims.email.toLowerCase(), sub: claims.sub, verified };
  } catch {
    return null;
  }
}

async function githubIdentity(access: string): Promise<{ email: string; sub: string; verified: boolean } | null> {
  const userRes = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${access}`, accept: "application/json", "user-agent": "melody-auth" } });
  const user = (await userRes.json()) as { id?: number; email?: string };
  const mailRes = await fetch("https://api.github.com/user/emails", { headers: { authorization: `Bearer ${access}`, accept: "application/json", "user-agent": "melody-auth" } });
  const emails = (await mailRes.json()) as { email: string; verified: boolean; primary: boolean }[];
  const verified = Array.isArray(emails) ? emails.find((row) => row.verified && row.primary) ?? emails.find((row) => row.verified) : undefined;
  if (!verified || typeof user.id !== "number") return null;
  return { email: verified.email.toLowerCase(), sub: String(user.id), verified: true };
}

export async function handleFederationCallback(request: Request, env: Env, provider: string, onHub: boolean): Promise<Response> {
  await limit(env.FED_LIMIT, request);
  const basePath = onHub ? "/demos/melody-auth" : "";
  if (request.method === "POST" && !originAllowed(request)) {
    return html(errorPage(basePath, "Cannot continue", "This request could not be verified."), 403);
  }
  const cfg = providerConfig(env, provider);
  if (!cfg) return html(errorPage(basePath, "Provider unavailable", "That sign-in provider is not configured."), 404);
  const url = new URL(request.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !state) return html(errorPage(basePath, "Sign-in failed", "The provider did not return a code."), 400);
  const raw = await env.KEYS.get(`fed:${state}`);
  await env.KEYS.delete(`fed:${state}`);
  if (!raw) return html(errorPage(basePath, "Sign-in failed", "The sign-in session expired. Start again."), 400);
  const packed = JSON.parse(raw) as FedState;
  if (packed.provider !== provider) return html(errorPage(basePath, "Sign-in failed", "State did not match."), 400);
  const { issuer } = publicBase(request, env);
  const redirectUri = `${issuer}/fed/${provider}/callback`;
  const tokens = await exchange(cfg, code, redirectUri, packed.verifier);
  let identity = jwtEmail(tokens.id_token);
  if (provider === "github" && tokens.access_token) identity = await githubIdentity(tokens.access_token);
  if (!identity || !identity.verified) {
    return html(errorPage(basePath, "Unverified email", "Melody Auth only links accounts with a verified upstream email."), 403);
  }
  const now = Date.now();
  const existing = await findFederated(env.DB, provider, identity.sub);
  const user = existing
    ? await userForVerifiedEmail(env.DB, identity.email, now)
    : await userForVerifiedEmail(env.DB, identity.email, now);
  await linkFederated(env.DB, provider, identity.sub, user.id, identity.email, now);
  const sessionId = await createSession(env.DB, user.id, now);
  const returnPath = packed.returnTo.startsWith("/authorize") ? packed.returnTo : `/authorize${packed.returnTo.startsWith("?") ? packed.returnTo : ""}`;
  const returnUrl = new URL(returnPath, "https://local.invalid");
  if (returnUrl.pathname === "/authorize" && returnUrl.searchParams.get("client_id")) {
    const fields = await resolveAuthorizeFields(env, returnUrl.searchParams, now);
    const checked = await validateAuthorize(env, fields);
    if (checked.ok) {
      return completeAuthorize(env, request, onHub, fields, user, Math.floor(now / 1000), now, sessionId);
    }
  }
  const dest = `${basePath}/`;
  const headers = new Headers({ location: dest });
  headers.append("set-cookie", sessionCookie(sessionId, request, onHub, 30 * 60));
  return new Response(null, { status: 302, headers });
}
