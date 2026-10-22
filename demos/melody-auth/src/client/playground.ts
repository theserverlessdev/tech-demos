import type { AppConfig, TokenResponse } from "../shared/types";

function apiRoot(): string {
  const path = location.pathname;
  const marker = "/demos/melody-auth";
  if (path === marker || path.startsWith(`${marker}/`)) return marker;
  return "";
}

function $(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node;
}

function b64url(data: Uint8Array): string {
  let bin = "";
  for (const b of data) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

function show(data: unknown, _echo: unknown, meta: string): void {
  $("viewer").textContent = `${meta}\n\n${typeof data === "string" ? data : JSON.stringify(data, null, 2)}`;
}

function err(message: string): void {
  $("play-error").textContent = message;
}

let config: AppConfig | null = null;
let lastTokens: TokenResponse | null = null;
let device: { device_code: string; user_code: string; interval: number } | null = null;

function rememberTokens(status: number, data: unknown): void {
  if (status !== 200 || !data || typeof data !== "object" || !("access_token" in data)) return;
  const next = data as TokenResponse;
  if (!next.access_token) return;
  lastTokens = next;
  sessionStorage.setItem("melody-play-tokens", JSON.stringify(lastTokens));
}

function tokenOwner(token: string): string {
  const part = token.split(".")[1] ?? "";
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const claims = JSON.parse(atob(padded)) as { client_id?: string };
    return typeof claims.client_id === "string" ? claims.client_id : "";
  } catch {
    return "";
  }
}

function machineCreds(): { id: string; secret: string } {
  const id = (document.getElementById("cc-id") as HTMLInputElement | null)?.value.trim() ?? "";
  const secret = (document.getElementById("cc-secret") as HTMLInputElement | null)?.value ?? "";
  return { id, secret };
}

async function post(path: string, body: Record<string, string>, extra: HeadersInit = {}): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${apiRoot()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...extra },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function switchFlow(id: string): void {
  for (const key of ["pkce", "cc", "device", "ops"]) {
    const node = document.getElementById(`flow-${key}`);
    if (node) node.hidden = key !== id;
  }
}

document.querySelectorAll<HTMLButtonElement>("[data-flow]").forEach((btn) => {
  btn.addEventListener("click", () => switchFlow(btn.dataset.flow ?? "pkce"));
});

if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
  const note = document.getElementById("cc-local");
  if (note) note.hidden = false;
}

const configRes = await fetch(`${apiRoot()}/api/config`);
const loaded = (await configRes.json()) as AppConfig;
config = loaded;

document.getElementById("pkce-start")?.addEventListener("click", async () => {
  if (!config) return;
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem("melody-play-pkce", JSON.stringify({ verifier, state, nonce }));
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", `${config.redirectUri.replace(/\/$/, "")}/playground.html`);
  url.searchParams.set("scope", "openid email profile offline_access");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", await s256(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  show({ to: url.toString() }, { step: "GET /authorize" }, "Redirecting to /authorize with PKCE S256.");
  location.assign(url.toString());
});

async function finishPkce(): Promise<void> {
  if (!config) return;
  const params = new URLSearchParams(location.search);
  const error = params.get("error");
  if (error) {
    err(params.get("error_description") || error);
    history.replaceState({}, "", `${apiRoot()}/playground.html`);
    return;
  }
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return;
  const raw = sessionStorage.getItem("melody-play-pkce");
  sessionStorage.removeItem("melody-play-pkce");
  if (!raw) {
    err("This tab lost the PKCE verifier.");
    return;
  }
  const stored = JSON.parse(raw) as { verifier: string; state: string; nonce?: string };
  if (stored.state !== state) {
    err("State did not match.");
    return;
  }
  const redirectUri = `${config.redirectUri.replace(/\/$/, "")}/playground.html`;
  const body = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    code_verifier: stored.verifier,
  };
  const res = await post("/token", body);
  history.replaceState({}, "", `${apiRoot()}/playground.html`);
  if (res.status === 200 && stored.nonce && res.data && typeof res.data === "object" && "id_token" in res.data) {
    const part = String((res.data as TokenResponse).id_token ?? "").split(".")[1] ?? "";
    try {
      const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
      const claims = JSON.parse(atob(padded)) as { nonce?: string };
      if (claims.nonce !== stored.nonce) {
        err("Nonce did not match.");
        return;
      }
    } catch {
      err("The ID token could not be read.");
      return;
    }
  }
  rememberTokens(res.status, res.data);
  show({ request: body, status: res.status, response: res.data }, res.data, "POST /token grant_type=authorization_code");
}

document.getElementById("pkce-refresh")?.addEventListener("click", async () => {
  if (!config || !lastTokens?.refresh_token) {
    err("Complete PKCE first.");
    return;
  }
  const body = { grant_type: "refresh_token", refresh_token: lastTokens.refresh_token, client_id: config.clientId };
  const res = await post("/token", body);
  rememberTokens(res.status, res.data);
  show({ request: body, status: res.status, response: res.data }, res.data, "POST /token grant_type=refresh_token");
});

document.getElementById("cc-token")?.addEventListener("click", async () => {
  const creds = machineCreds();
  if (!creds.id || !creds.secret) {
    err("Enter the machine client id and secret.");
    return;
  }
  const body = {
    grant_type: "client_credentials",
    client_id: creds.id,
    client_secret: creds.secret,
    scope: "api",
  };
  const res = await post("/token", body);
  rememberTokens(res.status, res.data);
  show({ request: { ...body, client_secret: "***" }, status: res.status, response: res.data }, res.data, "POST /token grant_type=client_credentials");
});

document.getElementById("device-start")?.addEventListener("click", async () => {
  if (!config) return;
  const body = { client_id: config.clientId, scope: "openid email profile offline_access" };
  const res = await post("/device_authorization", body);
  const data = res.data as { device_code?: string; user_code?: string; interval?: number; verification_uri?: string };
  if (data.device_code && data.user_code) {
    device = { device_code: data.device_code, user_code: data.user_code, interval: data.interval ?? 5 };
    $("device-code").textContent = data.user_code;
    const open = document.getElementById("device-open") as HTMLAnchorElement | null;
    if (open) open.href = `${apiRoot()}/device?user_code=${encodeURIComponent(data.user_code)}`;
  }
  show({ request: body, status: res.status, response: data }, data, "POST /device_authorization");
});

document.getElementById("device-poll")?.addEventListener("click", async () => {
  if (!config || !device) {
    err("Start a device grant first.");
    return;
  }
  const body = {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: device.device_code,
    client_id: config.clientId,
  };
  const res = await post("/token", body);
  rememberTokens(res.status, res.data);
  show({ request: body, status: res.status, response: res.data }, res.data, "POST /token device_code poll");
});

document.getElementById("ops-introspect")?.addEventListener("click", async () => {
  const creds = machineCreds();
  if (!lastTokens?.access_token || !creds.id || !creds.secret) {
    err("Mint a token, then enter a confidential client id and secret. Introspection is confidential-only.");
    return;
  }
  const body = { token: lastTokens.access_token, client_id: creds.id, client_secret: creds.secret };
  const res = await post("/introspect", body);
  const inactive = res.data && typeof res.data === "object" && "active" in res.data && (res.data as { active?: boolean }).active === false;
  const note = inactive
    ? "POST /introspect — active:false means this client cannot see the token (not the owner, and the audience is not in its resources). It does not prove the token is dead."
    : "POST /introspect";
  show({ request: { token: "<access_token>", client_id: creds.id }, status: res.status, response: res.data }, res.data, note);
});

document.getElementById("ops-revoke")?.addEventListener("click", async () => {
  if (!lastTokens?.access_token || !config) {
    err("Mint a token first.");
    return;
  }
  const owner = tokenOwner(lastTokens.access_token);
  const creds = machineCreds();
  const publicOwn = owner !== "" && owner === config.clientId;
  if (!publicOwn && (!creds.id || !creds.secret)) {
    err("Enter a confidential client id and secret, or revoke a token this public client owns.");
    return;
  }
  const body: Record<string, string> = publicOwn
    ? { token: lastTokens.access_token, client_id: config.clientId }
    : { token: lastTokens.access_token, client_id: creds.id, client_secret: creds.secret };
  const res = await fetch(`${apiRoot()}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const foreign = !publicOwn && creds.id !== "" && owner !== "" && creds.id !== owner;
  const note = foreign ? "POST /revoke — HTTP 200, not owned, ignored." : "POST /revoke";
  show({ request: { token: "<access_token>", client_id: body.client_id }, status: res.status, body: await res.text() }, { status: res.status }, note);
});

document.getElementById("ops-password")?.addEventListener("click", async () => {
  const body = { grant_type: "password", username: "ada@example.com", password: "nope", client_id: config?.clientId ?? "" };
  const res = await post("/token", body);
  show({ request: body, status: res.status, response: res.data }, res.data, "POST /token grant_type=password (must fail)");
});

const saved = sessionStorage.getItem("melody-play-tokens");
if (saved) lastTokens = JSON.parse(saved) as TokenResponse;
await finishPkce().catch((error: unknown) => err(error instanceof Error ? error.message : "Playground failed."));
