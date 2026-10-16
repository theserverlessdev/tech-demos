import { parseForm, readBounded } from "./body";
import { authenticateClient, clientAllowsGrant } from "./clients";
import { HttpError } from "./errors";
import { corsJson, html } from "./headers";
import { originAllowed, publicBase } from "./origin";
import { devicePage, errorPage } from "./pages";
import { filterToAppScopes, limit } from "./oidc";
import { audienceAllowed, isDcrClient } from "./policy";
import { sessionFrom } from "./session";
import {
  appScopes,
  approveDevice,
  createDeviceGrant,
  denyDevice,
  getFullApp,
  lookupDeviceByUserCode,
  sessionAuthTime,
} from "./store";

export async function handleDeviceAuthorization(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(405, "method", "POST only.");
  await limit(env.DEVICE_LIMIT, request);
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  const text = await readBounded(request, 8_000);
  let body: Record<string, string>;
  try {
    body = type.includes("application/json")
      ? (JSON.parse(text) as Record<string, string>)
      : Object.fromEntries(new URLSearchParams(text));
  } catch {
    throw new HttpError(400, "invalid_request", "The request body is not valid JSON.");
  }
  const now = Date.now();
  const app = await authenticateClient(env, request, body, now);
  if (!clientAllowsGrant(app, "urn:ietf:params:oauth:grant-type:device_code")) {
    throw new HttpError(400, "unauthorized_client", "This client cannot use that grant.");
  }
  const scope = filterToAppScopes(typeof body.scope === "string" && body.scope ? body.scope : "openid profile email offline_access", appScopes(app));
  if (!scope) throw new HttpError(400, "invalid_scope", "The requested scope is not allowed.");
  const audience = typeof body.resource === "string" ? body.resource : "";
  if (audience && !audienceAllowed(audience, app.resources, app.client_id)) {
    throw new HttpError(400, "invalid_target", "The requested audience is not allowed.");
  }
  const issued = await createDeviceGrant(env.DB, {
    clientId: app.client_id,
    scope,
    audience: audience || undefined,
    now,
  });
  const { issuer } = publicBase(request, env);
  return corsJson(request, {
    device_code: issued.deviceCode,
    user_code: issued.userCode,
    verification_uri: `${issuer}/device`,
    verification_uri_complete: `${issuer}/device?user_code=${encodeURIComponent(issued.userCode)}`,
    expires_in: issued.expiresIn,
    interval: issued.interval,
  });
}

export async function handleDevicePage(request: Request, env: Env, onHub: boolean): Promise<Response> {
  const basePath = onHub ? "/demos/melody-auth" : "";
  await limit(env.DEVICE_LIMIT, request);
  const now = Date.now();
  const url = new URL(request.url);

  if (request.method === "GET") {
    const userCode = (url.searchParams.get("user_code") ?? "").toUpperCase();
    const session = await sessionAuthTime(env.DB, sessionFrom(request) ?? "", now);
    if (!userCode) {
      return html(devicePage({ basePath, siteKey: env.TURNSTILE_SITE_KEY, userCode: "", sessionEmail: session?.user.email ?? null, error: "" }));
    }
    const row = await lookupDeviceByUserCode(env.DB, userCode);
    if (!row || row.expires_at <= now) {
      return html(devicePage({ basePath, siteKey: env.TURNSTILE_SITE_KEY, userCode, sessionEmail: session?.user.email ?? null, error: "That code is unknown or expired." }), 400);
    }
    const app = await getFullApp(env.DB, row.client_id);
    const pending = {
      pendingName: app?.name ?? row.client_id,
      scopes: row.scope.split(/\s+/).filter(Boolean),
      resource: row.audience ?? "",
      unverified: isDcrClient(row.client_id, app?.registration_access_hash),
    };
    if (!session) {
      return html(
        devicePage({
          basePath,
          siteKey: env.TURNSTILE_SITE_KEY,
          userCode: row.user_code,
          sessionEmail: null,
          error: "",
          signInHref: `${basePath}/?return_to=${encodeURIComponent(`${basePath}/device?user_code=${encodeURIComponent(row.user_code)}`)}`,
          ...pending,
        }),
        401,
      );
    }
    return html(
      devicePage({
        basePath,
        siteKey: env.TURNSTILE_SITE_KEY,
        userCode: row.user_code,
        sessionEmail: session.user.email,
        error: "",
        ...pending,
      }),
    );
  }

  if (request.method !== "POST") throw new HttpError(405, "method", "GET or POST.");
  if (!originAllowed(request)) return html(errorPage(basePath, "Cannot continue", "This request could not be verified."), 403);
  const form = parseForm(await readBounded(request, 4_000));
  const session = await sessionAuthTime(env.DB, sessionFrom(request) ?? "", now);
  if (!session) return html(errorPage(basePath, "Sign in first", "Sign in, then approve the device."), 401);
  const row = await lookupDeviceByUserCode(env.DB, form.user_code ?? "");
  if (!row || row.expires_at <= now) return html(devicePage({ basePath, siteKey: env.TURNSTILE_SITE_KEY, userCode: form.user_code ?? "", sessionEmail: session.user.email, error: "That code is unknown or expired." }), 400);
  if (form.decision === "deny") {
    await denyDevice(env.DB, row.id, now);
    return html(errorPage(basePath, "Denied", "You denied the device. The CLI will see access_denied."), 200);
  }
  await approveDevice(env.DB, row.id, session.user.id);
  return html(errorPage(basePath, "Approved", "Return to your TV or CLI. It can redeem the device code now."), 200);
}
