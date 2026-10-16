// Smoke: bun run scripts/smoke.ts [baseUrl]
const base = (process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8788").replace(/\/$/, "");
const DUMMY = "XXXX.DUMMY.TOKEN.XXXX";

let failures = 0;
function check(label: string, ok: unknown, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
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

async function get(path: string) {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, text, location: res.headers.get("location"), cookies: res.headers.getSetCookie?.() ?? [] };
}

async function postForm(path: string, body: Record<string, string>, cookie = "") {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(body),
    redirect: "manual",
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, text, location: res.headers.get("location") };
}

console.log(`Target: ${base}`);

const health = await get("/api/health");
check("health is ok", health.status === 200 && (health.data as { ok?: boolean })?.ok === true, health.data);

const discovery = await get("/.well-known/openid-configuration");
const issuer = (discovery.data as { issuer?: string; code_challenge_methods_supported?: string[] }) ?? {};
check("discovery lists S256 only", discovery.status === 200 && issuer.code_challenge_methods_supported?.join() === "S256", issuer);

const jwks = await get("/.well-known/jwks.json");
check("jwks has an ES256 key", jwks.status === 200 && Array.isArray((jwks.data as { keys?: unknown[] })?.keys), jwks.data);

const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
const challenge = await s256(verifier);
const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
const redirectUri = `${base}/`;
const authorizeQuery = new URLSearchParams({
  response_type: "code",
  client_id: "melody-sample",
  redirect_uri: redirectUri,
  scope: "openid email profile",
  state,
  nonce,
  code_challenge: challenge,
  code_challenge_method: "S256",
  mode: "signup",
});

const authorize = await get(`/authorize?${authorizeQuery}`);
check("authorize GET is the hosted page", authorize.status === 200 && authorize.text.includes("Create account"), authorize.status);

const evil = await get(`/authorize?${new URLSearchParams({ ...Object.fromEntries(authorizeQuery), redirect_uri: "https://evil.example/cb" })}`);
check("unregistered redirect_uri stays on the error page", evil.status === 200 && evil.text.includes("not registered"), evil.status);

const email = `ada+${Date.now()}@example.com`;
const signed = await postForm("/authorize", {
  mode: "signup",
  email,
  password: "correct-horse",
  turnstileToken: DUMMY,
  client_id: "melody-sample",
  redirect_uri: redirectUri,
  state,
  nonce,
  scope: "openid email profile",
  code_challenge: challenge,
  code_challenge_method: "S256",
});
const code = signed.location ? new URL(signed.location).searchParams.get("code") : null;
check("signup redirects with a code and matching state", signed.status === 302 && Boolean(code) && signed.location?.includes(`state=${state}`), signed.status);

const tokens = await postForm("/token", {
  grant_type: "authorization_code",
  code: code ?? "",
  redirect_uri: redirectUri,
  client_id: "melody-sample",
  code_verifier: verifier,
});
const issued = tokens.data as { access_token?: string; id_token?: string; refresh_token?: string };
check("token exchange returns three tokens", tokens.status === 200 && Boolean(issued.access_token && issued.id_token && issued.refresh_token), tokens.status);

const reuse = await postForm("/token", {
  grant_type: "authorization_code",
  code: code ?? "",
  redirect_uri: redirectUri,
  client_id: "melody-sample",
  code_verifier: verifier,
});
check("code reuse is invalid_grant", reuse.status === 400 && (reuse.data as { error?: string })?.error === "invalid_grant", reuse.data);

const userinfo = await fetch(`${base}/userinfo`, { headers: { authorization: `Bearer ${issued.access_token}` } });
const info = (await userinfo.json()) as { email?: string };
check("userinfo returns the signup email", userinfo.status === 200 && info.email === email, info);

const refreshed = await postForm("/token", {
  grant_type: "refresh_token",
  refresh_token: issued.refresh_token ?? "",
  client_id: "melody-sample",
});
const next = refreshed.data as { refresh_token?: string };
check("refresh rotates the token", refreshed.status === 200 && Boolean(next.refresh_token) && next.refresh_token !== issued.refresh_token, refreshed.status);

const replay = await postForm("/token", {
  grant_type: "refresh_token",
  refresh_token: issued.refresh_token ?? "",
  client_id: "melody-sample",
});
check("refresh reuse is invalid_grant", replay.status === 400 && (replay.data as { error?: string })?.error === "invalid_grant", replay.data);

const wrong = await postForm("/authorize", {
  mode: "signin",
  email,
  password: "wrong-password",
  turnstileToken: DUMMY,
  client_id: "melody-sample",
  redirect_uri: redirectUri,
  state,
  nonce,
  scope: "openid email profile",
  code_challenge: challenge,
  code_challenge_method: "S256",
});
check("wrong password stays generic", wrong.status === 200 && wrong.text.includes("Email or password is incorrect."), wrong.status);

const admin = await get("/api/admin/overview");
const users = (admin.data as { users?: { emailMasked?: string }[] })?.users ?? [];
check("admin masks the email", admin.status === 200 && users.some((user) => user.emailMasked === "a***@e***.com"), admin.data);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll smoke checks passed.");
