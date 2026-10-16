import { parseForm, parseObject, readBounded } from "./body";
import { authenticateClient } from "./clients";
import { HttpError } from "./errors";
import { corsJson } from "./headers";
import { limit } from "./oidc";
import { savePar } from "./store";

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
  asStrings.client_id = app.client_id;
  const saved = await savePar(env.DB, app.client_id, asStrings, now);
  return corsJson(request, { request_uri: saved.requestUri, expires_in: saved.expiresIn }, 201);
}
