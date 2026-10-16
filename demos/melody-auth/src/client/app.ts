import type { ApiError, AppConfig, TokenResponse, UserInfo } from "../shared/types";

const PKCE_KEY = "melody-pkce";

type TurnstileApi = {
  render: (el: HTMLElement, opts: { sitekey: string; action?: string; callback?: (token: string) => void }) => string;
  getResponse: (id?: string) => string | undefined;
  reset: (id?: string) => void;
};

type StoredPkce = { verifier: string; state: string; nonce: string; mode?: string; returnTo?: string };

function safeDeviceReturn(value: string | null): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.includes("://")) return null;
  const path = value.split("?")[0] ?? "";
  const root = apiRoot();
  if (path !== `${root}/device`) return null;
  return value;
}

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

function randomB64(size: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(size)));
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function idTokenExpired(token: string): boolean {
  const claims = decodeJwtPayload(token);
  return !claims || typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000);
}

function idTokenInvalid(
  token: string,
  expected: { nonce?: string; aud: string; iss: string },
  opts: { ignoreExp?: boolean } = {},
): string | null {
  const claims = decodeJwtPayload(token);
  if (!claims) return "The ID token could not be read.";
  if (expected.nonce !== undefined && claims.nonce !== expected.nonce) return "Nonce did not match. Start again.";
  if (claims.aud !== expected.aud) return "Audience did not match. Start again.";
  if (claims.iss !== expected.iss) return "Issuer did not match. Start again.";
  if (!opts.ignoreExp && idTokenExpired(token)) return "The ID token expired. Start again.";
  return null;
}

function isError(data: unknown): data is ApiError {
  if (!data || typeof data !== "object" || !("error" in data)) return false;
  const error = (data as ApiError).error;
  return Boolean(error && typeof error.message === "string");
}

function messageOf(data: unknown, fallback: string): string {
  if (isError(data)) return data.error.message;
  if (data && typeof data === "object" && "error_description" in data && typeof (data as { error_description: string }).error_description === "string") {
    return (data as { error_description: string }).error_description;
  }
  return fallback;
}

async function call<T>(path: string, init: { method?: string; body?: unknown; token?: string; form?: boolean } = {}): Promise<{ status: number; data: T | ApiError | null }> {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = init.form ? "application/x-www-form-urlencoded" : "application/json";
    body = init.form ? new URLSearchParams(init.body as Record<string, string>).toString() : JSON.stringify(init.body);
  }
  const res = await fetch(`${apiRoot()}${path}`, { method: init.method ?? "GET", headers, body, credentials: "include" });
  const data = (await res.json().catch(() => null)) as T | ApiError | null;
  return { status: res.status, data };
}

function turnstileApi(): TurnstileApi | undefined {
  const candidate = (window as Window & { turnstile?: TurnstileApi }).turnstile;
  if (!candidate || typeof candidate.render !== "function") return undefined;
  return candidate;
}

async function waitForTurnstile(): Promise<TurnstileApi | undefined> {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    const api = turnstileApi();
    if (api) return api;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return turnstileApi();
}

async function wireAuthorizeForm(): Promise<void> {
  const form = document.getElementById("auth-form") as HTMLFormElement | null;
  const host = document.getElementById("turnstile");
  const hidden = document.getElementById("turnstile-token") as HTMLInputElement | null;
  const submit = document.getElementById("submit") as HTMLButtonElement | null;
  if (!form || !host || !hidden) return;
  if (submit) submit.disabled = true;
  const sitekey = host.dataset.sitekey ?? "";
  const ready = (token: string) => {
    hidden.value = token;
    if (submit && token) submit.disabled = false;
  };
  const api = await waitForTurnstile();
  let widgetId = "";
  if (api && sitekey && !sitekey.startsWith("REPLACE_ME")) {
    widgetId = api.render(host, {
      sitekey,
      action: "melody-auth",
      callback: ready,
    });
  }
  form.addEventListener("submit", (event) => {
    if (!hidden.value) hidden.value = turnstileApi()?.getResponse(widgetId) || "";
    if (!hidden.value) {
      event.preventDefault();
      if (widgetId) turnstileApi()?.reset(widgetId);
    }
  });
}

function paintClaims(idToken: string, userinfo: UserInfo | null): void {
  const claims = decodeJwtPayload(idToken) ?? {};
  const table = $("claims");
  table.replaceChildren();
  const rows: [string, string][] = [
    ["iss", String(claims.iss ?? "")],
    ["sub", String(claims.sub ?? "")],
    ["aud", String(claims.aud ?? "")],
    ["email", String(claims.email ?? "")],
    ["nonce", String(claims.nonce ?? "")],
    ["exp", String(claims.exp ?? "")],
  ];
  for (const [key, value] of rows) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = key;
    const td = document.createElement("td");
    td.className = "mono";
    td.textContent = value;
    tr.append(th, td);
    table.append(tr);
  }
  $("userinfo").textContent = userinfo ? JSON.stringify(userinfo, null, 2) : "—";
}

function showTokens(): void {
  $("intro").hidden = true;
  $("tokens").hidden = false;
}

function showIntro(): void {
  $("intro").hidden = false;
  $("tokens").hidden = true;
}

let config: AppConfig | null = null;
let tokens: TokenResponse | null = null;

async function loadUserinfo(access: string): Promise<UserInfo | null> {
  const res = await call<UserInfo>("/userinfo", { token: access });
  if (res.status === 200 && res.data && "sub" in res.data) return res.data;
  return null;
}

async function startPkce(mode: "signin" | "signup"): Promise<void> {
  if (!config) return;
  const verifier = randomB64(32);
  const state = randomB64(16);
  const nonce = randomB64(16);
  const returnTo = safeDeviceReturn(sessionStorage.getItem("melody-return")) ?? undefined;
  const stored: StoredPkce = { verifier, state, nonce, mode, returnTo };
  sessionStorage.setItem(PKCE_KEY, JSON.stringify(stored));
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", "openid email profile offline_access");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", await s256(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("mode", mode);
  location.assign(url.toString());
}

async function finishPkce(): Promise<boolean> {
  const params = new URLSearchParams(location.search);
  const oauthError = params.get("error");
  if (oauthError) {
    $("intro-error").textContent = params.get("error_description") || oauthError;
    history.replaceState({}, "", `${apiRoot()}/`);
    return true;
  }
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state || !config) return false;
  const raw = sessionStorage.getItem(PKCE_KEY);
  sessionStorage.removeItem(PKCE_KEY);
  if (!raw) {
    $("intro-error").textContent = "This tab lost the PKCE verifier. Start again.";
    return true;
  }
  const stored = JSON.parse(raw) as StoredPkce;
  if (stored.state !== state) {
    $("intro-error").textContent = "State did not match. Start again.";
    return true;
  }
  const res = await call<TokenResponse>("/token", {
    method: "POST",
    form: true,
    body: {
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: stored.verifier,
    },
  });
  history.replaceState({}, "", `${apiRoot()}/`);
  if (res.status !== 200 || !res.data || !("access_token" in res.data) || !res.data.id_token) {
    $("intro-error").textContent = messageOf(res.data, "The token exchange failed.");
    return true;
  }
  const invalid = idTokenInvalid(res.data.id_token, { nonce: stored.nonce, aud: config.clientId, iss: config.issuer });
  if (invalid) {
    $("intro-error").textContent = invalid;
    return true;
  }
  tokens = res.data;
  sessionStorage.setItem("melody-tokens", JSON.stringify(tokens));
  const back = safeDeviceReturn(stored.returnTo ?? null);
  sessionStorage.removeItem("melody-return");
  if (back) {
    location.assign(back);
    return true;
  }
  paintClaims(res.data.id_token, await loadUserinfo(tokens.access_token));
  showTokens();
  return true;
}

async function bootSample(): Promise<void> {
  const intro = document.getElementById("intro");
  if (!intro) return;
  const configRes = await call<AppConfig>("/api/config");
  if (configRes.status === 200 && configRes.data && "issuer" in configRes.data) config = configRes.data;
  if (!config) {
    $("intro-error").textContent = "The page could not reach the Worker.";
    return;
  }
  const pendingReturn = safeDeviceReturn(new URLSearchParams(location.search).get("return_to"));
  if (pendingReturn) sessionStorage.setItem("melody-return", pendingReturn);
  if (await finishPkce()) return;
  const saved = sessionStorage.getItem("melody-tokens");
  if (saved) {
    const parsed = JSON.parse(saved) as TokenResponse;
    if (!parsed.id_token) {
      sessionStorage.removeItem("melody-tokens");
      return;
    }
    const invalid = idTokenInvalid(parsed.id_token, { aud: config.clientId, iss: config.issuer }, { ignoreExp: true });
    if (invalid) {
      sessionStorage.removeItem("melody-tokens");
      $("intro-error").textContent = invalid;
      return;
    }
    tokens = parsed;
    paintClaims(parsed.id_token, await loadUserinfo(tokens.access_token));
    showTokens();
    if (idTokenExpired(parsed.id_token)) $("token-error").textContent = "expired, refresh";
  }
}

async function boot(): Promise<void> {
  if (document.getElementById("auth-form")) {
    await wireAuthorizeForm();
    return;
  }
  await bootSample();
}

const start = document.getElementById("start");
if (start) start.addEventListener("click", () => void startPkce("signin"));
const startSignup = document.getElementById("start-signup");
if (startSignup) startSignup.addEventListener("click", () => void startPkce("signup"));

const refreshBtn = document.getElementById("refresh");
if (refreshBtn) {
  refreshBtn.addEventListener("click", async () => {
    if (!config || !tokens) return;
    $("token-error").textContent = "";
    const res = await call<TokenResponse>("/token", {
      method: "POST",
      form: true,
      body: {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: config.clientId,
      },
    });
    if (res.status !== 200 || !res.data || !("access_token" in res.data) || !res.data.id_token) {
      $("token-error").textContent = messageOf(res.data, "Refresh failed.");
      return;
    }
    const invalid = idTokenInvalid(res.data.id_token, { aud: config.clientId, iss: config.issuer });
    if (invalid) {
      $("token-error").textContent = invalid;
      return;
    }
    tokens = res.data;
    sessionStorage.setItem("melody-tokens", JSON.stringify(tokens));
    paintClaims(res.data.id_token, await loadUserinfo(tokens.access_token));
  });
}

const signout = document.getElementById("signout");
if (signout) {
  signout.addEventListener("click", () => {
    sessionStorage.removeItem("melody-tokens");
    tokens = null;
    const dest = config ? `${config.logoutEndpoint}?client_id=${encodeURIComponent(config.clientId)}&post_logout_redirect_uri=${encodeURIComponent(config.redirectUri)}` : `${apiRoot()}/`;
    location.assign(dest);
  });
}

void boot().catch(() => {
  const err = document.getElementById("intro-error") ?? document.getElementById("auth-error");
  if (err) err.textContent = "The page could not reach the Worker.";
});
