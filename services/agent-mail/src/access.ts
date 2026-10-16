import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { getUserByEmail, insertUser, audit } from "./db";
import type { UserRow } from "./types";
import { HttpError, newId } from "./util";

let remote: ReturnType<typeof createRemoteJWKSet> | undefined;

function remoteJwks(env: Env): ReturnType<typeof createRemoteJWKSet> {
  if (!remote) remote = createRemoteJWKSet(new URL(`${env.TEAM_DOMAIN.replace(/\/$/, "")}/cdn-cgi/access/certs`));
  return remote;
}

export async function verifyAccessJwt(token: string, env: Env): Promise<JWTPayload> {
  const issuer = env.TEAM_DOMAIN?.replace(/\/$/, "") ?? "";
  const audience = env.POLICY_AUD ?? "";
  if (!issuer || !audience || audience.startsWith("replace-with")) {
    throw new HttpError(403, "access", "Access is not configured.");
  }
  const key =
    env.ENVIRONMENT === "test"
      ? createLocalJWKSet(JSON.parse(env.ACCESS_TEST_JWK ?? "{}") as Parameters<typeof createLocalJWKSet>[0])
      : remoteJwks(env);
  try {
    const { payload } = await jwtVerify(token, key, { issuer, audience });
    return payload;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(403, "access", "The Access token is not valid.");
  }
}

/** Email from a valid Access JWT, or from DEV_PANEL_EMAIL on localhost. */
export async function identityEmail(request: Request, env: Env): Promise<string | null> {
  const host = new URL(request.url).hostname;
  if (env.DEV_PANEL_EMAIL && (host === "localhost" || host === "127.0.0.1" || host === "[::1]")) {
    const email = env.DEV_PANEL_EMAIL.trim().toLowerCase();
    return email || null;
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  const payload = await verifyAccessJwt(token, env);
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  return email || null;
}

/**
 * Load the invited user for an email.
 * The first login whose email equals ADMIN_EMAIL creates the admin row.
 */
export async function userForEmail(env: Env, email: string): Promise<UserRow | null> {
  const normalized = email.trim().toLowerCase();
  const existing = await getUserByEmail(env.DB, normalized);
  if (existing) return existing.disabled ? null : existing;
  const adminEmail = (env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  if (!adminEmail || normalized !== adminEmail) return null;
  const user = await insertUser(env.DB, {
    id: newId(),
    email: normalized,
    role: "admin",
    display_name: null,
    invited_by: null,
    created_at: Date.now(),
  });
  await audit(env.DB, {
    actor_type: "system",
    actor_id: null,
    action: "user.bootstrapped",
    target_type: "user",
    target_id: user.id,
    detail: { email: normalized },
  });
  return user;
}

export async function resolvePanelUser(request: Request, env: Env): Promise<UserRow> {
  const email = await identityEmail(request, env);
  if (!email) throw new HttpError(403, "access", "Sign in through Cloudflare Access.");
  const user = await userForEmail(env, email);
  if (!user) throw new HttpError(403, "not_invited", "This email is not invited.");
  return user;
}
