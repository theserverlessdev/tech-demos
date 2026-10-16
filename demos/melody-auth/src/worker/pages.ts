function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type AuthorizeFields = {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  scope: string;
  challenge: string;
  method: string;
  responseType: string;
  prompt: string;
  maxAge: string;
  loginHint: string;
  resource: string;
  responseMode: string;
};

export function authorizePage(input: {
  basePath: string;
  siteKey: string;
  fields: AuthorizeFields;
  mode: "signin" | "signup";
  error: string;
  sessionEmail: string | null;
  email?: string;
  providers?: { id: string; label: string }[];
}): string {
  const { basePath, siteKey, fields, mode, error, sessionEmail } = input;
  const email = input.email ?? fields.loginHint ?? "";
  const hidden = hiddenOauth(fields);
  const signinActive = mode === "signin" ? " is-active" : "";
  const signupActive = mode === "signup" ? " is-active" : "";
  const continueBlock = sessionEmail
    ? `<form method="post" action="${escapeHtml(`${basePath}/authorize`)}" class="card card--auth">
        ${hidden}
        <input type="hidden" name="mode" value="continue" />
        <p class="eyebrow">Already signed in</p>
        <h2>Continue as ${escapeHtml(sessionEmail)}</h2>
        <p class="lede">This browser already has a hosted session. Continue to review consent and issue a one-time code.</p>
        <button class="btn btn-primary btn-block" type="submit">Continue as ${escapeHtml(sessionEmail)}</button>
        <p class="fine"><a href="${escapeHtml(tabHref(basePath, fields, "signin", true))}">Use a different account</a></p>
      </form>`
    : "";
  const fed = (input.providers ?? [])
    .map((provider) => {
      const url = `${basePath}/fed/${encodeURIComponent(provider.id)}?return_to=${encodeURIComponent(authorizeQuery(fields))}`;
      return `<a class="btn btn-block" href="${escapeHtml(url)}">Sign in with ${escapeHtml(provider.label)}</a>`;
    })
    .join("");
  return layout({
    basePath,
    title: mode === "signup" ? "Create account" : "Sign in",
    body: `
      <section class="gate">
        <p class="eyebrow">Hosted authorize</p>
        <h2>${mode === "signup" ? "Create a demo account" : "Sign in to continue"}</h2>
        <p class="lede"><span class="shows__k">What this shows</span> A Worker hosts the sign-in page. Passwords are PBKDF2-hashed in D1. The sample app never sees your password.</p>
        ${continueBlock}
        <div class="tabs" role="tablist">
          <a class="tab${signinActive}" href="${escapeHtml(tabHref(basePath, fields, "signin"))}">Sign in</a>
          <a class="tab${signupActive}" href="${escapeHtml(tabHref(basePath, fields, "signup"))}">Create account</a>
        </div>
        <form method="post" action="${escapeHtml(`${basePath}/authorize`)}" class="card card--auth" id="auth-form">
          ${hidden}
          <input type="hidden" name="mode" value="${mode}" />
          <label>Email
            <input id="email" name="email" type="email" autocomplete="${mode === "signup" ? "email" : "username"}" required maxlength="254" value="${escapeHtml(email)}" />
          </label>
          <label>Password
            <input id="password" name="password" type="password" autocomplete="${mode === "signup" ? "new-password" : "current-password"}" required minlength="8" maxlength="128" />
          </label>
          <p class="fine">At least 8 characters. Demo accounts expire after 24 hours. No email is sent. Local sign-up sets <span class="mono">email_verified=false</span>.</p>
          <div id="turnstile" class="turnstile" data-sitekey="${escapeHtml(siteKey)}"></div>
          <input type="hidden" name="turnstileToken" id="turnstile-token" />
          <button class="btn btn-primary btn-block" id="submit" type="submit" disabled>${mode === "signup" ? "Create account" : "Sign in"}</button>
          ${fed ? `<div class="actions">${fed}</div>` : ""}
          <p class="hint" id="auth-error" role="status">${escapeHtml(error)}</p>
        </form>
      </section>`,
  });
}

export function consentPage(input: {
  basePath: string;
  fields: AuthorizeFields;
  clientName: string;
  email: string;
  scopes: string[];
  error?: string;
}): string {
  const hidden = hiddenOauth(input.fields);
  const items = input.scopes.map((scope) => `<li class="row">${escapeHtml(scope)}</li>`).join("");
  return layout({
    basePath: input.basePath,
    title: "Consent",
    body: `
      <section class="gate">
        <p class="eyebrow">Consent</p>
        <h2>${escapeHtml(input.clientName)} wants access</h2>
        <p class="lede"><span class="shows__k">What this shows</span> Consent is remembered per client + scopes. <span class="shows__k">Try</span> Allow once, then sign in again — this page is skipped until scopes grow. Signed in as ${escapeHtml(input.email)}.</p>
        <ul class="list">${items}</ul>
        <form method="post" action="${escapeHtml(`${input.basePath}/consent`)}" class="card card--auth">
          ${hidden}
          <input type="hidden" name="decision" value="allow" />
          <button class="btn btn-primary btn-block" type="submit">Allow</button>
        </form>
        <form method="post" action="${escapeHtml(`${input.basePath}/consent`)}" class="card card--auth">
          ${hidden}
          <input type="hidden" name="decision" value="deny" />
          <button class="btn btn-block" type="submit">Deny</button>
        </form>
        <p class="hint" role="status">${escapeHtml(input.error ?? "")}</p>
      </section>`,
  });
}

export function devicePage(input: {
  basePath: string;
  siteKey: string;
  userCode: string;
  sessionEmail: string | null;
  error: string;
  pendingName?: string;
}): string {
  if (input.sessionEmail && input.pendingName) {
    return layout({
      basePath: input.basePath,
      title: "Device",
      body: `
        <section class="gate">
          <p class="eyebrow">Device authorization</p>
          <h2>Approve ${escapeHtml(input.pendingName)}?</h2>
          <p class="lede"><span class="shows__k">What this shows</span> RFC 8628 — the TV/CLI flow. Signed in as ${escapeHtml(input.sessionEmail)}. User code <span class="device-code">${escapeHtml(input.userCode)}</span></p>
          <form method="post" action="${escapeHtml(`${input.basePath}/device`)}" class="card card--auth">
            <input type="hidden" name="user_code" value="${escapeHtml(input.userCode)}" />
            <input type="hidden" name="decision" value="allow" />
            <button class="btn btn-primary btn-block" type="submit">Approve</button>
          </form>
          <form method="post" action="${escapeHtml(`${input.basePath}/device`)}" class="card card--auth">
            <input type="hidden" name="user_code" value="${escapeHtml(input.userCode)}" />
            <input type="hidden" name="decision" value="deny" />
            <button class="btn btn-block" type="submit">Deny</button>
          </form>
        </section>`,
    });
  }
  return layout({
    basePath: input.basePath,
    title: "Device",
    body: `
      <section class="gate">
        <p class="eyebrow">Device authorization</p>
        <h2>Enter the code from your TV or CLI</h2>
        <p class="lede"><span class="shows__k">What this shows</span> RFC 8628 user-code page. <span class="shows__k">Try</span> Start a device grant in the playground, type the code here, then approve.</p>
        <form method="get" action="${escapeHtml(`${input.basePath}/device`)}" class="card card--auth">
          <label>User code
            <input name="user_code" value="${escapeHtml(input.userCode)}" maxlength="9" autocapitalize="characters" autocomplete="one-time-code" />
          </label>
          <button class="btn btn-primary btn-block" type="submit">Continue</button>
        </form>
        ${
          input.sessionEmail
            ? `<p class="fine">Signed in as ${escapeHtml(input.sessionEmail)}.</p>`
            : `<p class="fine">You will sign in on the next step.</p>`
        }
        <p class="hint" role="status">${escapeHtml(input.error)}</p>
      </section>`,
  });
}

export function formPostPage(target: string, fields: Record<string, string>): string {
  const inputs = Object.entries(fields)
    .map(([name, value]) => hiddenField(name, value))
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Returning to the app</title>
</head>
<body>
  <form method="post" action="${escapeHtml(target)}">${inputs}<button type="submit">Continue</button></form>
  <script>document.forms[0].submit()</script>
</body>
</html>`;
}

export function errorPage(basePath: string, title: string, message: string): string {
  return layout({
    basePath,
    title,
    body: `
      <section class="gate">
        <p class="eyebrow">Authorize</p>
        <h2>${escapeHtml(title)}</h2>
        <p class="lede">${escapeHtml(message)}</p>
        <a class="btn btn-primary" href="${escapeHtml(`${basePath}/`)}">Back to sample app</a>
      </section>`,
  });
}

function hiddenOauth(fields: AuthorizeFields): string {
  return [
    hiddenField("response_type", fields.responseType || "code"),
    hiddenField("client_id", fields.clientId),
    hiddenField("redirect_uri", fields.redirectUri),
    hiddenField("state", fields.state),
    hiddenField("nonce", fields.nonce),
    hiddenField("scope", fields.scope),
    hiddenField("code_challenge", fields.challenge),
    hiddenField("code_challenge_method", fields.method),
    hiddenField("prompt", fields.prompt),
    hiddenField("max_age", fields.maxAge),
    hiddenField("login_hint", fields.loginHint),
    hiddenField("resource", fields.resource),
    hiddenField("response_mode", fields.responseMode),
  ].join("");
}

function hiddenField(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`;
}

function authorizeQuery(fields: AuthorizeFields): string {
  const url = new URL("https://local.invalid/authorize");
  url.searchParams.set("response_type", fields.responseType || "code");
  url.searchParams.set("client_id", fields.clientId);
  url.searchParams.set("redirect_uri", fields.redirectUri);
  url.searchParams.set("state", fields.state);
  url.searchParams.set("nonce", fields.nonce);
  url.searchParams.set("scope", fields.scope);
  url.searchParams.set("code_challenge", fields.challenge);
  url.searchParams.set("code_challenge_method", fields.method);
  if (fields.prompt) url.searchParams.set("prompt", fields.prompt);
  if (fields.maxAge) url.searchParams.set("max_age", fields.maxAge);
  if (fields.loginHint) url.searchParams.set("login_hint", fields.loginHint);
  if (fields.resource) url.searchParams.set("resource", fields.resource);
  if (fields.responseMode) url.searchParams.set("response_mode", fields.responseMode);
  return `${url.pathname}${url.search}`;
}

function tabHref(basePath: string, fields: AuthorizeFields, mode: "signin" | "signup", switchAccount = false): string {
  const url = new URL(`https://local.invalid${authorizeQuery(fields)}`);
  url.searchParams.set("mode", mode);
  if (switchAccount) url.searchParams.set("switch", "1");
  return `${basePath}${url.pathname}${url.search}`;
}

function layout(input: { basePath: string; title: string; body: string }): string {
  const css = `${input.basePath}/assets/app.css`;
  const app = `${input.basePath}/assets/app.js`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="color-scheme" content="dark" />
  <meta name="theme-color" content="#0e0e11" />
  <title>${escapeHtml(input.title)} · Melody Auth</title>
  <link rel="icon" href="${input.basePath}/favicon.svg" type="image/svg+xml" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,560..760&family=Hanken+Grotesk:wght@420..680&family=JetBrains+Mono:wght@440;560&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="${css}" />
</head>
<body>
  <header class="topbar">
    <a class="brand" href="https://tech-demos.theserverless.dev/" aria-label="Tech Demos gallery">
      <svg class="brand__mark" width="26" height="26" viewBox="0 -3 128 128" aria-hidden="true">
        <g stroke="currentColor" stroke-width="6" stroke-linecap="round" opacity="0.45"><line x1="4" y1="58" x2="20" y2="58"/><line x1="1" y1="72" x2="19" y2="72"/><line x1="6" y1="86" x2="22" y2="86"/></g>
        <path d="M44 92 C31 92 20 82 20 69 C20 57 29 47 41 46 C45 33 57 24 70 24 C85 24 98 35 100 51 C110 53 118 62 118 72 C118 83 109 92 97 92 Z" fill="none" stroke="currentColor" stroke-width="7.5" stroke-linejoin="round"/>
        <path d="M69 36 L50 71 L63 71 L57 102 L88 60 L72 60 L80 36 Z" fill="currentColor"/>
      </svg>
      <span>Tech Demos</span>
    </a>
    <div class="topbar__title">
      <h1>Melody Auth</h1>
      <p>OAuth 2.1 / OIDC at the edge</p>
    </div>
    <div class="topbar__actions">
      <a class="btn" href="${input.basePath}/">Sample</a>
      <a class="btn" href="${input.basePath}/playground.html">Playground</a>
      <a class="btn btn-ghost" href="${input.basePath}/admin">Admin</a>
    </div>
  </header>
  <main>${input.body}</main>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>
  <script type="module" src="${app}"></script>
</body>
</html>`;
}
