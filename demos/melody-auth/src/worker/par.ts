import { parseForm, parseObject, readBounded } from "./body";
import { authenticateClient } from "./clients";
import { HttpError, OauthError } from "./errors";
import { corsJson } from "./headers";
import { limit } from "./oidc";
import { challengeShape } from "./pkce";
import { audienceAllowed } from "./policy";
import { redirectUriAllowed } from "./redirect";
import { getFullApp, parseJsonList, savePar } from "./store";

const STRIPPED = ["client_secret", "client_assertion", "client_assertion_type", "turnstileToken"];

export async function handlePar(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(405, "method", "POST only.");
  await limit(env.PAR_LIMIT, request);
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  const text = await readBounded(request, 8_000);
  const body = type.includes("application/json") ? (parseObject(text) as Record<string, string>) : parseForm(text);
  const asStrings: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) if (typeof value === "string") asStrings[key] = value;
  const now = Date.now();
  const app = await authenticateClient(env, request, asStrings, now);
  if (asStrings.client_id && asStrings.client_id !== app.client_id) {
    throw new HttpError(400, "invalid_request", "client_id does not match the authenticated client.");
  }
  if (asStrings.request_uri) throw new OauthError(400, "invalid_request", "request_uri cannot be nested.");
  for (const key of STRIPPED) delete asStrings[key];
  asStrings.client_id = app.client_id;
  const full = (await getFullApp(env.DB, app.client_id)) ?? app;
  const redirects = parseJsonList(full.redirect_uris, []);
  if (!asStrings.redirect_uri || !redirectUriAllowed(asStrings.redirect_uri, redirects)) {
    throw new OauthError(400, "invalid_request", "The redirect URI is not registered for this app.");
  }
  const responseType = asStrings.response_type || "code";
  if (responseType === "code" && (asStrings.code_challenge_method !== "S256" || !challengeShape(asStrings.code_challenge))) {
    throw new OauthError(400, "invalid_request", "PKCE S256 is required.");
  }
  if (asStrings.resource && !audienceAllowed(asStrings.resource, full.resources, full.client_id)) {
    throw new OauthError(400, "invalid_target", "The requested audience is not allowed.");
  }
  const saved = await savePar(env.DB, app.client_id, asStrings, now);
  return corsJson(request, { request_uri: saved.requestUri, expires_in: saved.expiresIn }, 201);
}
