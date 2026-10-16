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

type TurnstileApi = { render: (el: HTMLElement, opts: { sitekey: string; callback?: (token: string) => void }) => string };
function turnstileApi(): TurnstileApi | undefined {
  return (window as Window & { turnstile?: TurnstileApi }).turnstile;
}

let config: AppConfig | null = null;
let lastTokens: TokenResponse | null = null;
let confidential: { client_id: string; client_secret?: string } | null = null;
let device: { device_code: string; user_code: string; interval: number } | null = null;

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

const configRes = await fetch(`${apiRoot()}/api/config`);
const loaded = (await configRes.json()) as AppConfig;
config = loaded;
const host = document.getElementById("turnstile");
if (host) host.dataset.sitekey = loaded.turnstileSiteKey;
const wait = async (): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < 8000 && !turnstileApi()) await new Promise((r) => setTimeout(r, 100));
  const api = turnstileApi();
  const tokenEl = document.getElementById("turnstile-token") as HTMLInputElement | null;
  if (api && host && loaded.turnstileSiteKey && !loaded.turnstileSiteKey.startsWith("REPLACE_ME")) {
    api.render(host, {
      sitekey: loaded.turnstileSiteKey,
      callback: (token) => {
        if (tokenEl) tokenEl.value = token;
      },
    });
  }
};
void wait();

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
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return;
  const raw = sessionStorage.getItem("melody-play-pkce");
  sessionStorage.removeItem("melody-play-pkce");
  if (!raw) {
    err("This tab lost the PKCE verifier.");
    return;
  }
  const stored = JSON.parse(raw) as { verifier: string; state: string };
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
  lastTokens = res.data as TokenResponse;
  sessionStorage.setItem("melody-play-tokens", JSON.stringify(lastTokens));
  history.replaceState({}, "", `${apiRoot()}/playground.html`);
  show({ request: body, status: res.status, response: res.data }, res.data, "POST /token grant_type=authorization_code");
}

document.getElementById("pkce-refresh")?.addEventListener("click", async () => {
  if (!config || !lastTokens?.refresh_token) {
    err("Complete PKCE first.");
    return;
  }
  const body = { grant_type: "refresh_token", refresh_token: lastTokens.refresh_token, client_id: config.clientId };
  const res = await post("/token", body);
  lastTokens = res.data as TokenResponse;
  show({ request: body, status: res.status, response: res.data }, res.data, "POST /token grant_type=refresh_token");
});

document.getElementById("cc-register")?.addEventListener("click", async () => {
  const token = (document.getElementById("turnstile-token") as HTMLInputElement | null)?.value ?? "";
  const body = {
    client_name: "Playground machine",
    grant_types: "client_credentials",
    token_endpoint_auth_method: "client_secret_post",
    scope: "api",
    turnstileToken: token,
  };
  const res = await fetch(`${apiRoot()}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { client_id?: string; client_secret?: string; error?: string; error_description?: string };
  if (data.client_id) confidential = { client_id: data.client_id, client_secret: data.client_secret };
  show({ request: body, status: res.status, response: data }, data, "POST /register (RFC 7591)");
});

document.getElementById("cc-token")?.addEventListener("click", async () => {
  if (!confidential?.client_secret) {
    err("Register a confidential client first.");
    return;
  }
  const body = {
    grant_type: "client_credentials",
    client_id: confidential.client_id,
    client_secret: confidential.client_secret,
    scope: "api",
  };
  const res = await post("/token", body);
  lastTokens = res.data as TokenResponse;
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
  if (res.status === 200) lastTokens = res.data as TokenResponse;
  show({ request: body, status: res.status, response: res.data }, res.data, "POST /token device_code poll");
});

document.getElementById("ops-introspect")?.addEventListener("click", async () => {
  if (!config || !lastTokens?.access_token) {
    err("Mint a token first.");
    return;
  }
  const body = { token: lastTokens.access_token, client_id: config.clientId };
  const res = await post("/introspect", body);
  show({ request: { token: "<access_token>", client_id: config.clientId }, status: res.status, response: res.data }, res.data, "POST /introspect");
});

document.getElementById("ops-revoke")?.addEventListener("click", async () => {
  if (!config || !lastTokens?.access_token) {
    err("Mint a token first.");
    return;
  }
  const body = { token: lastTokens.access_token, client_id: config.clientId };
  const res = await fetch(`${apiRoot()}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  show({ request: { token: "<access_token>" }, status: res.status, body: await res.text() }, { status: res.status }, "POST /revoke");
});

document.getElementById("ops-password")?.addEventListener("click", async () => {
  const body = { grant_type: "password", username: "ada@example.com", password: "nope", client_id: config?.clientId ?? "" };
  const res = await post("/token", body);
  show({ request: body, status: res.status, response: res.data }, res.data, "POST /token grant_type=password (must fail)");
});

const saved = sessionStorage.getItem("melody-play-tokens");
if (saved) lastTokens = JSON.parse(saved) as TokenResponse;
await finishPkce().catch((error: unknown) => err(error instanceof Error ? error.message : "Playground failed."));
