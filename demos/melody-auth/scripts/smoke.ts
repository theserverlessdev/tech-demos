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
  return { status: res.status, data, text, location: res.headers.get("location"), cache: res.headers.get("cache-control") };
}

async function postForm(path: string, body: Record<string, string>, extra: HeadersInit = {}) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...extra,
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

function authFields(input: { redirectUri: string; state: string; nonce: string; challenge: string; mode?: string }) {
  return {
    response_type: "code",
    client_id: "melody-sample",
    redirect_uri: input.redirectUri,
    scope: "openid email profile",
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    ...(input.mode ? { mode: input.mode } : {}),
  };
}

async function signupCode(redirectUri: string) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = await s256(verifier);
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const email = `ada+${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
  const signed = await postForm("/authorize", {
    ...authFields({ redirectUri, state, nonce, challenge, mode: "signup" }),
    email,
    password: "correct-horse",
    turnstileToken: DUMMY,
  });
  const code = signed.location ? new URL(signed.location).searchParams.get("code") : null;
  return { verifier, state, nonce, email, signed, code };
}

console.log(`Target: ${base}`);

const health = await get("/api/health");
check("health is ok and D1 answered", health.status === 200 && (health.data as { ok?: boolean; d1?: boolean })?.d1 === true, health.data);

const discovery = await get("/.well-known/openid-configuration");
const issuerDoc = (discovery.data as { issuer?: string; code_challenge_methods_supported?: string[]; claims_supported?: string[] }) ?? {};
check("discovery lists S256 only", discovery.status === 200 && issuerDoc.code_challenge_methods_supported?.join() === "S256", issuerDoc);
check("discovery lists claims_supported", Array.isArray(issuerDoc.claims_supported) && issuerDoc.claims_supported.includes("email_verified"), issuerDoc.claims_supported);
check("discovery issuer is this origin locally", issuerDoc.issuer === base, issuerDoc.issuer);
check("discovery is cacheable for 300s", discovery.cache === "public, max-age=300", discovery.cache);

const jwks = await get("/.well-known/jwks.json");
check("jwks has an ES256 key", jwks.status === 200 && Array.isArray((jwks.data as { keys?: unknown[] })?.keys), jwks.data);
check("jwks is cacheable for 300s", jwks.cache === "public, max-age=300", jwks.cache);

const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
const challenge = await s256(verifier);
const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
const redirectUri = `${base}/`;
const authorizeQuery = new URLSearchParams(authFields({ redirectUri, state, nonce, challenge, mode: "signup" }));

const authorize = await get(`/authorize?${authorizeQuery}`);
check("authorize GET is the hosted page", authorize.status === 200 && authorize.text.includes("Create account"), authorize.status);

const evil = await get(`/authorize?${new URLSearchParams({ ...Object.fromEntries(authorizeQuery), redirect_uri: "https://evil.example/cb" })}`);
check("unregistered redirect_uri is a 400 error page", evil.status === 400 && evil.text.includes("not registered"), evil.status);

const missingType = await get(`/authorize?${new URLSearchParams({ ...Object.fromEntries(authorizeQuery), response_type: "token" })}`);
check("response_type other than code is a 400", missingType.status === 400 && missingType.text.includes("response_type"), missingType.status);

const originNull = await postForm(
  "/authorize",
  {
    ...authFields({ redirectUri, state, nonce, challenge, mode: "signin" }),
    email: "ada@example.com",
    password: "correct-horse",
    turnstileToken: DUMMY,
  },
  { origin: "null" },
);
check("Origin null is rejected in-page", originNull.status === 403 && originNull.text.includes("could not be verified"), originNull.status);

const email = `ada+${Date.now()}@example.com`;
const signed = await postForm("/authorize", {
  ...authFields({ redirectUri, state, nonce, challenge, mode: "signup" }),
  email,
  password: "correct-horse",
  turnstileToken: DUMMY,
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
const info = (await userinfo.json()) as { email?: string; email_verified?: boolean };
check("userinfo returns the signup email", userinfo.status === 200 && info.email === email, info);
check("email_verified is false", info.email_verified === false, info);

const payload = issued.id_token ? JSON.parse(atob(issued.id_token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(issued.id_token.split(".")[1]!.length / 4) * 4, "="))) : {};
check("id token email_verified is false", payload.email_verified === false, payload.email_verified);

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

const raced = await signupCode(redirectUri);
check("second signup issued a code for the race", raced.signed.status === 302 && Boolean(raced.code), raced.signed.status);
if (raced.code) {
  const body = {
    grant_type: "authorization_code",
    code: raced.code,
    redirect_uri: redirectUri,
    client_id: "melody-sample",
    code_verifier: raced.verifier,
  };
  const [a, b] = await Promise.all([postForm("/token", body), postForm("/token", body)]);
  const oks = [a, b].filter((res) => res.status === 200);
  check("concurrent code exchange yields exactly one 200", oks.length === 1, { a: a.status, b: b.status });
}

const wrong = await postForm("/authorize", {
  ...authFields({ redirectUri, state, nonce, challenge, mode: "signin" }),
  email,
  password: "wrong-password",
  turnstileToken: DUMMY,
});
check("wrong password stays generic and in-page", wrong.status === 200 && wrong.text.includes("Email or password is incorrect.") && wrong.text.includes(email), wrong.status);

const admin = await get("/api/admin/overview");
const users = (admin.data as { users?: { emailMasked?: string; id?: string }[] })?.users ?? [];
check("admin masks the email to last label only", admin.status === 200 && users.some((user) => user.emailMasked === "a***@***.com"), admin.data);
check("admin does not emit user id", users.every((user) => user.id === undefined), users[0]);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll smoke checks passed.");
