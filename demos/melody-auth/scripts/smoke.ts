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

function cookiesOf(headers: Headers): string {
  const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : headers.get("set-cookie") ? [headers.get("set-cookie") as string] : [];
  return list.map((item) => item.split(";")[0] ?? "").filter(Boolean).join("; ");
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
  return { status: res.status, data, text, location: res.headers.get("location"), cookies: cookiesOf(res.headers) };
}

function authFields(input: { redirectUri: string; state: string; nonce: string; challenge: string; mode?: string }) {
  return {
    response_type: "code",
    client_id: "melody-sample",
    redirect_uri: input.redirectUri,
    scope: "openid email profile offline_access",
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    ...(input.mode ? { mode: input.mode } : {}),
  };
}

async function finishConsent(
  signed: Awaited<ReturnType<typeof postForm>>,
  fields: Record<string, string>,
): Promise<Awaited<ReturnType<typeof postForm>>> {
  if (signed.status === 302) return signed;
  if (signed.status === 200 && signed.text.includes("wants access")) {
    return postForm(
      "/consent",
      { ...fields, decision: "allow" },
      signed.cookies ? { cookie: signed.cookies } : {},
    );
  }
  return signed;
}

async function signupCode(redirectUri: string) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = await s256(verifier);
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const email = `ada+${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
  const fields = authFields({ redirectUri, state, nonce, challenge, mode: "signup" });
  const signed = await finishConsent(
    await postForm("/authorize", { ...fields, email, password: "correct-horse", turnstileToken: DUMMY }),
    fields,
  );
  const code = signed.location ? new URL(signed.location).searchParams.get("code") : null;
  return { verifier, state, nonce, email, signed, code };
}

console.log(`Target: ${base}`);

const health = await get("/api/health");
check("health is ok and D1 answered", health.status === 200 && (health.data as { ok?: boolean; d1?: boolean })?.d1 === true, health.data);

const discovery = await get("/.well-known/openid-configuration");
const issuerDoc = (discovery.data as {
  issuer?: string;
  code_challenge_methods_supported?: string[];
  claims_supported?: string[];
  grant_types_supported?: string[];
  introspection_endpoint?: string;
  device_authorization_endpoint?: string;
}) ?? {};
check("discovery lists S256 only", discovery.status === 200 && issuerDoc.code_challenge_methods_supported?.join() === "S256", issuerDoc);
check("discovery lists claims_supported", Array.isArray(issuerDoc.claims_supported) && issuerDoc.claims_supported.includes("email_verified"), issuerDoc.claims_supported);
check("discovery issuer is this origin locally", issuerDoc.issuer === base, issuerDoc.issuer);
check("discovery is cacheable for 300s", discovery.cache === "public, max-age=300", discovery.cache);
check(
  "discovery lists modern grants and not password",
  issuerDoc.grant_types_supported?.includes("client_credentials") === true &&
    issuerDoc.grant_types_supported?.includes("urn:ietf:params:oauth:grant-type:device_code") === true &&
    !issuerDoc.grant_types_supported?.includes("password"),
  issuerDoc.grant_types_supported,
);
check("discovery lists introspect and device", Boolean(issuerDoc.introspection_endpoint && issuerDoc.device_authorization_endpoint), issuerDoc);

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
const fields = authFields({ redirectUri, state, nonce, challenge, mode: "signup" });
const signedUp = await postForm("/authorize", {
  ...fields,
  email,
  password: "correct-horse",
  turnstileToken: DUMMY,
});
check("signup shows the consent screen", signedUp.status === 200 && signedUp.text.includes("wants access"), signedUp.status);
const signed = await finishConsent(signedUp, fields);
const code = signed.location ? new URL(signed.location).searchParams.get("code") : null;
check("consent allow redirects with a code and matching state", signed.status === 302 && Boolean(code) && signed.location?.includes(`state=${state}`), signed.status);

const tokens = await postForm("/token", {
  grant_type: "authorization_code",
  code: code ?? "",
  redirect_uri: redirectUri,
  client_id: "melody-sample",
  code_verifier: verifier,
});
const issued = tokens.data as { access_token?: string; id_token?: string; refresh_token?: string };
check("token exchange returns three tokens", tokens.status === 200 && Boolean(issued.access_token && issued.id_token && issued.refresh_token), tokens.status);

const accessHeader = issued.access_token ? JSON.parse(atob(issued.access_token.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(issued.access_token.split(".")[0]!.length / 4) * 4, "="))) : {};
check("access token typ is at+jwt", accessHeader.typ === "at+jwt", accessHeader);

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

const reuse = await postForm("/token", {
  grant_type: "authorization_code",
  code: code ?? "",
  redirect_uri: redirectUri,
  client_id: "melody-sample",
  code_verifier: verifier,
});
check("code reuse is invalid_grant", reuse.status === 400 && (reuse.data as { error?: string })?.error === "invalid_grant", reuse.data);

const afterReuse = await postForm("/token", {
  grant_type: "refresh_token",
  refresh_token: next.refresh_token ?? "",
  client_id: "melody-sample",
});
check("code reuse revokes the refresh family", afterReuse.status === 400 && (afterReuse.data as { error?: string })?.error === "invalid_grant", afterReuse.data);

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

const refreshRace = await signupCode(redirectUri);
const refreshIssued = refreshRace.code
  ? await postForm("/token", {
      grant_type: "authorization_code",
      code: refreshRace.code,
      redirect_uri: redirectUri,
      client_id: "melody-sample",
      code_verifier: refreshRace.verifier,
    })
  : { status: 0, data: {} };
const parentRefresh = (refreshIssued.data as { refresh_token?: string }).refresh_token ?? "";
check("refresh-race parent token issued", refreshIssued.status === 200 && Boolean(parentRefresh), refreshIssued.status);
if (parentRefresh) {
  const body = { grant_type: "refresh_token", refresh_token: parentRefresh, client_id: "melody-sample" };
  const [a, b] = await Promise.all([postForm("/token", body), postForm("/token", body)]);
  const oks = [a, b].filter((res) => res.status === 200);
  check("parallel refresh reuse yields exactly one 200", oks.length === 1, { a: a.status, b: b.status });
  const child = (oks[0]?.data as { refresh_token?: string } | undefined)?.refresh_token ?? "";
  const childReplay = await postForm("/token", { grant_type: "refresh_token", refresh_token: child, client_id: "melody-sample" });
  check("winner child is invalid_grant after parallel reuse", childReplay.status === 400 && (childReplay.data as { error?: string })?.error === "invalid_grant", childReplay.data);
}

const wrong = await postForm("/authorize", {
  ...authFields({ redirectUri, state, nonce, challenge, mode: "signin" }),
  email,
  password: "wrong-password",
  turnstileToken: DUMMY,
});
check("wrong password stays generic and in-page", wrong.status === 200 && wrong.text.includes("Email or password is incorrect.") && wrong.text.includes(email), wrong.status);

const passwordGrant = await postForm("/token", { grant_type: "password", username: email, password: "correct-horse", client_id: "melody-sample" });
check("password grant is unsupported", passwordGrant.status === 400 && (passwordGrant.data as { error?: string })?.error === "unsupported_grant_type", passwordGrant.data);

const machine = await postForm("/token", {
  grant_type: "client_credentials",
  client_id: "melody-machine",
  client_secret: "melody-machine-secret",
  scope: "api",
});
const machineTok = machine.data as { access_token?: string };
check("client_credentials returns an access token", machine.status === 200 && Boolean(machineTok.access_token), machine.data);

const introspect = await postForm("/introspect", { token: machineTok.access_token ?? "", client_id: "melody-machine", client_secret: "melody-machine-secret" });
check("introspect marks the machine token active", introspect.status === 200 && (introspect.data as { active?: boolean })?.active === true, introspect.data);

const deviceStart = await postForm("/device_authorization", { client_id: "melody-sample", scope: "openid email profile" });
const device = deviceStart.data as { device_code?: string; user_code?: string; interval?: number };
check("device authorization returns a user code", deviceStart.status === 200 && Boolean(device.device_code && device.user_code), deviceStart.data);

const pending = await postForm("/token", {
  grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  device_code: device.device_code ?? "",
  client_id: "melody-sample",
});
check("device poll before approve is authorization_pending", pending.status === 400 && (pending.data as { error?: string })?.error === "authorization_pending", pending.data);

const tooFast = await postForm("/token", {
  grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  device_code: device.device_code ?? "",
  client_id: "melody-sample",
});
check("device poll inside interval is slow_down", tooFast.status === 400 && (tooFast.data as { error?: string })?.error === "slow_down", tooFast.data);

const dcr = await fetch(`${base}/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "Smoke app",
    redirect_uris: [`${base}/`],
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: "none",
    turnstileToken: DUMMY,
  }),
});
const dcrBody = (await dcr.json()) as { client_id?: string };
check("dynamic registration creates a public client", dcr.status === 201 && Boolean(dcrBody.client_id), dcrBody);

const devicePage = await get("/device");
check("device page renders", devicePage.status === 200 && devicePage.text.includes("Device authorization"), devicePage.status);

const playground = await get("/playground.html");
check("playground renders", playground.status === 200 && playground.text.includes("OAuth playground"), playground.status);

const admin = await get("/api/admin/overview");
const users = (admin.data as { users?: { emailMasked?: string; id?: string }[] })?.users ?? [];
check("admin masks the email to last label only", admin.status === 200 && users.some((user) => user.emailMasked === "a***@***.com"), admin.data);
check("admin does not emit user id", users.every((user) => user.id === undefined), users[0]);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll smoke checks passed.");
