import { createSession } from "./db";
import { envSecret } from "./clients";
import { html } from "./headers";
import { randomBytes, toBase64Url } from "./encoding";
import { completeAuthorize, limit, resolveAuthorizeFields, validateAuthorize } from "./oidc";
import { originAllowed, publicBase } from "./origin";
import { upstreamIdOk } from "./policy";
import { errorPage } from "./pages";
import { clearFedCookie, fedStateCookie, fedStateFrom, sessionCookie } from "./session";
import { claimFedState, findFederated, linkFederated, saveFedState, userForFederation } from "./store";

type FedState = {
  provider: string;
  verifier: string;
  nonce: string;
  returnTo: string;
  createdAt: number;
};

type ProviderCfg = {
  issuer?: string;
  authorize: string;
  token: string;
  clientId: string;
  secret: string;
  scope: string;
};

type DiscoveryDoc = {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
};

const discoveryCache = new Map<string, { at: number; authorize: string; token: string; issuer: string }>();

function providerConfig(env: Env, id: string): ProviderCfg | null {
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
    if (!issuer.startsWith("https://") || !clientId) return null;
    return {
      issuer,
      authorize: issuer,
      token: issuer,
      clientId,
      secret: envSecret(env, "OIDC_CLIENT_SECRET"),
      scope: "openid email profile",
    };
  }
  return null;
}

async function discoverIssuer(issuer: string): Promise<{ authorize: string; token: string; issuer: string } | null> {
  const cached = discoveryCache.get(issuer);
  if (cached && Date.now() - cached.at < 300_000) return cached;
  if (!issuer.startsWith("https://")) return null;
  let res: Response;
  try {
    res = await fetch(`${issuer}/.well-known/openid-configuration`);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const doc = (await res.json().catch(() => null)) as DiscoveryDoc | null;
  if (!doc?.issuer || doc.issuer.replace(/\/$/, "") !== issuer) return null;
  if (!doc.authorization_endpoint?.startsWith("https://") || !doc.token_endpoint?.startsWith("https://")) return null;
  const found = { at: Date.now(), authorize: doc.authorization_endpoint, token: doc.token_endpoint, issuer: doc.issuer.replace(/\/$/, "") };
  discoveryCache.set(issuer, found);
  return found;
}

async function resolveProvider(env: Env, id: string): Promise<ProviderCfg | null> {
  const cfg = providerConfig(env, id);
  if (!cfg || id !== "oidc" || !cfg.issuer) return cfg;
  const doc = await discoverIssuer(cfg.issuer);
  if (!doc) return null;
  return { ...cfg, issuer: doc.issuer, authorize: doc.authorize, token: doc.token };
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

export async function handleFederationStart(request: Request, env: Env, provider: string, onHub: boolean): Promise<Response> {
  await limit(env.FED_LIMIT, request);
  const cfg = await resolveProvider(env, provider);
  const basePath = onHub ? "/demos/melody-auth" : "";
  if (!cfg) return html(errorPage(basePath, "Provider unavailable", "That sign-in provider is not configured."), 404);
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("return_to") ?? "/";
  const verifier = toBase64Url(randomBytes(32));
  const nonce = toBase64Url(randomBytes(16));
  const state = toBase64Url(randomBytes(16));
  const now = Date.now();
  const packed: FedState = { provider, verifier, nonce, returnTo, createdAt: now };
  await saveFedState(env.DB, state, JSON.stringify(packed), now);
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
  const headers = new Headers({ location: authorize.toString() });
  headers.append("set-cookie", fedStateCookie(state, request, onHub));
  return new Response(null, { status: 302, headers });
}

type TokenJson = { access_token?: string; id_token?: string };

async function exchange(cfg: ProviderCfg, code: string, redirectUri: string, verifier: string): Promise<TokenJson | null> {
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
  if (!res.ok) return null;
  return (await res.json()) as TokenJson;
}

function parseIdClaims(idToken: string | undefined): Record<string, unknown> | null {
  if (!idToken) return null;
  const part = idToken.split(".")[1];
  if (!part) return null;
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function githubIdentity(access: string): Promise<{ email: string; sub: string } | null> {
  const userRes = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${access}`, accept: "application/json", "user-agent": "melody-auth" } });
  if (!userRes.ok) return null;
  const user = (await userRes.json()) as { id?: number };
  const mailRes = await fetch("https://api.github.com/user/emails", { headers: { authorization: `Bearer ${access}`, accept: "application/json", "user-agent": "melody-auth" } });
  if (!mailRes.ok) return null;
  const emails = (await mailRes.json()) as { email: string; verified: boolean; primary: boolean }[];
  const verified = Array.isArray(emails) ? emails.find((row) => row.verified && row.primary) ?? emails.find((row) => row.verified) : undefined;
  if (!verified || typeof user.id !== "number") return null;
  return { email: verified.email.toLowerCase(), sub: String(user.id) };
}

export async function handleFederationCallback(request: Request, env: Env, provider: string, onHub: boolean): Promise<Response> {
  await limit(env.FED_LIMIT, request);
  const basePath = onHub ? "/demos/melody-auth" : "";
  const fail = (title: string, message: string, status: number) => {
    const page = html(errorPage(basePath, title, message), status);
    const headers = new Headers(page.headers);
    headers.append("set-cookie", clearFedCookie(request, onHub));
    return new Response(page.body, { status, headers });
  };
  if (request.method === "POST" && !originAllowed(request)) return fail("Cannot continue", "This request could not be verified.", 403);
  const cfg = await resolveProvider(env, provider);
  if (!cfg) return fail("Provider unavailable", "That sign-in provider is not configured.", 404);
  const url = new URL(request.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !state) return fail("Sign-in failed", "The provider did not return a code.", 400);
  if (fedStateFrom(request) !== state) return fail("Sign-in failed", "The sign-in session did not match this browser.", 400);
  const now = Date.now();
  const raw = await claimFedState(env.DB, state, now);
  if (!raw) return fail("Sign-in failed", "The sign-in session expired. Start again.", 400);
  const packed = JSON.parse(raw) as FedState;
  if (packed.provider !== provider) return fail("Sign-in failed", "State did not match.", 400);
  const { issuer } = publicBase(request, env);
  const redirectUri = `${issuer}/fed/${provider}/callback`;
  const tokens = await exchange(cfg, code, redirectUri, packed.verifier);
  if (!tokens) return fail("Sign-in failed", "The provider rejected the code.", 400);
  let email = "";
  let sub = "";
  if (provider === "github") {
    if (!tokens.access_token) return fail("Unverified email", "Melody Auth only links accounts with a verified upstream email.", 403);
    const identity = await githubIdentity(tokens.access_token);
    if (!identity) return fail("Unverified email", "Melody Auth only links accounts with a verified upstream email.", 403);
    email = identity.email;
    sub = identity.sub;
  } else {
    const claims = parseIdClaims(tokens.id_token);
    if (
      !claims ||
      !upstreamIdOk(claims as Parameters<typeof upstreamIdOk>[0], {
        issuer: cfg.issuer,
        clientId: cfg.clientId,
        nonce: packed.nonce,
        nowSec: Math.floor(now / 1000),
        microsoft: provider === "microsoft",
      })
    ) {
      return fail("Unverified email", "Melody Auth only links accounts with a verified upstream email.", 403);
    }
    email = String(claims.email).toLowerCase();
    sub = String(claims.sub);
  }
  const linked = await findFederated(env.DB, provider, sub);
  const user = await userForFederation(env.DB, email, now, linked?.user_id ?? null);
  if (!user) return fail("Sign-in failed", "The linked account is no longer available.", 400);
  await linkFederated(env.DB, provider, sub, user.id, email, now);
  const sessionId = await createSession(env.DB, user.id, now);
  const headers = new Headers();
  headers.append("set-cookie", clearFedCookie(request, onHub));
  headers.append("set-cookie", sessionCookie(sessionId, request, onHub, 30 * 60));
  const returnPath = packed.returnTo.startsWith("/authorize") ? packed.returnTo : `/authorize${packed.returnTo.startsWith("?") ? packed.returnTo : ""}`;
  const returnUrl = new URL(returnPath, "https://local.invalid");
  if (returnUrl.pathname === "/authorize" && returnUrl.searchParams.get("client_id")) {
    const fields = await resolveAuthorizeFields(env, returnUrl.searchParams, now);
    const checked = await validateAuthorize(env, fields);
    if (checked.ok) {
      const done = await completeAuthorize(env, request, onHub, fields, user, Math.floor(now / 1000), now, sessionId);
      const merged = new Headers(done.headers);
      merged.append("set-cookie", clearFedCookie(request, onHub));
      return new Response(done.body, { status: done.status, headers: merged });
    }
  }
  headers.set("location", `${basePath}/`);
  return new Response(null, { status: 302, headers });
}
