import { expect, test } from "bun:test";
import { requireConfidential } from "../src/worker/clients";
import { handleDevicePage } from "../src/worker/device";
import { OauthError } from "../src/worker/errors";
import { handleToken } from "../src/worker/grants";
import { importSigningKey, signJwt } from "../src/worker/jwt";
import { resetRingForTests } from "../src/worker/jwks";
import { hashClientSecret } from "../src/worker/secret";
import type { FullApp } from "../src/worker/store";
import { handleIntrospect, handleRevoke } from "../src/worker/tokenops";

const DEMO = {
  crv: "P-256" as const,
  d: "p2rJ5XiDRi5pLLG9gzH4qoXbs2GKJ5KN3jruLjfILW0",
  kty: "EC" as const,
  x: "7n9MQV0h4T-Efij9pjzvLnn-oJO9ML24pQucNjbzIm8",
  y: "2MvQMOmOe1_-fieWGS6QYIjtvzCAZWme26W1BNJ7qUM",
  kid: "melody-demo-1",
  alg: "ES256" as const,
  use: "sig" as const,
};

const USER = {
  id: "usr_1",
  email: "a@b.c",
  password_hash: "h",
  salt: "s",
  created_at: 1,
  expires_at: Date.now() + 60_000,
  email_verified: 1,
};

function limits(): Pick<Env, "TOKEN_LIMIT" | "INTROSPECT_LIMIT" | "REVOKE_LIMIT" | "DEVICE_LIMIT"> {
  const binding = { async limit() { return { success: true }; } };
  return {
    TOKEN_LIMIT: binding,
    INTROSPECT_LIMIT: binding,
    REVOKE_LIMIT: binding,
    DEVICE_LIMIT: binding,
  } as unknown as Pick<Env, "TOKEN_LIMIT" | "INTROSPECT_LIMIT" | "REVOKE_LIMIT" | "DEVICE_LIMIT">;
}

function envWith(db: D1Database): Env {
  const store = new Map<string, string>();
  return {
    ENVIRONMENT: "local",
    AUTH_PRIVATE_JWK: JSON.stringify(DEMO),
    AUTH_KEK: "11".repeat(32),
    ...limits(),
    DB: db,
    KEYS: {
      async get(key: string, type?: string) {
        const raw = store.get(String(key));
        if (!raw) return null;
        return type === "json" ? JSON.parse(raw) : raw;
      },
      async put(key: string, value: string) {
        store.set(String(key), value);
      },
    },
  } as unknown as Env;
}

function dbOf(input: { app?: FullApp | null; device?: Record<string, unknown> | null; refresh?: Record<string, unknown> | null; user?: typeof USER | null; onRun?: (sql: string) => void }): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (sql.includes("FROM apps")) return input.app ?? null;
          if (sql.includes("device_grants")) return input.device ?? null;
          if (sql.includes("refresh_tokens")) return input.refresh ?? null;
          if (sql.includes("FROM users") && sql.includes("WHERE id")) return input.user === undefined ? USER : input.user;
          return null;
        },
        async run() {
          input.onRun?.(sql);
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  } as unknown as D1Database;
}

function form(path: string, body: Record<string, string>): Request {
  return new Request(`http://127.0.0.1:8788${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
}

async function machine(grants: string[], scopes = "api"): Promise<FullApp> {
  return {
    client_id: "melody-machine",
    name: "Machine",
    redirect_uris: "[]",
    client_secret_hash: await hashClientSecret("secret"),
    client_secret_salt: "",
    token_endpoint_auth_method: "client_secret_post",
    grant_types: JSON.stringify(grants),
    scopes,
    jwks: null,
    client_type: "confidential",
    resources: null,
    registration_access_hash: null,
    expires_at: null,
    require_pkce: 0,
    response_types: '["code"]',
  } as FullApp;
}

test("handleToken confines client_credentials, foreign device codes, and token exchange", async () => {
  resetRingForTests();
  const cc = await machine(["client_credentials"]);
  const wide = await handleToken(form("/token", { grant_type: "client_credentials", client_id: "melody-machine", client_secret: "secret", scope: "openid" }), envWith(dbOf({ app: cc })));
  expect(wide.status).toBe(400);
  expect((await wide.json()).error).toBe("invalid_scope");

  const audience = await handleToken(
    form("/token", { grant_type: "client_credentials", client_id: "melody-machine", client_secret: "secret", scope: "api", resource: "https://evil.example" }),
    envWith(dbOf({ app: cc })),
  );
  expect(audience.status).toBe(400);
  expect((await audience.json()).error).toBe("invalid_target");

  const ok = await handleToken(form("/token", { grant_type: "client_credentials", client_id: "melody-machine", client_secret: "secret", scope: "api" }), envWith(dbOf({ app: cc })));
  expect(ok.status).toBe(200);
  const minted = (await ok.json()) as { access_token: string };
  expect(minted.access_token.split(".").length).toBe(3);

  const sample = {
    ...(await machine(["urn:ietf:params:oauth:grant-type:device_code"])),
    client_id: "melody-sample",
    client_type: "public",
    token_endpoint_auth_method: "none",
    client_secret_hash: null,
  } as FullApp;
  let consumed = 0;
  const foreign = await handleToken(
    form("/token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "melody-sample", device_code: "device" }),
    envWith(
      dbOf({
        app: sample,
        device: { id: "dev_1", client_id: "other", user_id: "usr_1", expires_at: Date.now() + 60_000, denied_at: null, last_poll_at: null, interval_sec: 5, scope: "openid" },
        onRun: (sql) => {
          if (sql.includes("expires_at = 0")) consumed += 1;
        },
      }),
    ),
  );
  expect(foreign.status).toBe(400);
  expect((await foreign.json()).error).toBe("invalid_grant");
  expect(consumed).toBe(0);

  const exchanger = await machine(["urn:ietf:params:oauth:grant-type:token-exchange"], "email");
  exchanger.client_id = "melody-exchange";
  const denied = await handleToken(
    form("/token", { grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", client_id: "melody-machine", client_secret: "secret", subject_token: "x" }),
    envWith(dbOf({ app: cc })),
  );
  expect(denied.status).toBe(400);
  expect((await denied.json()).error).toBe("unauthorized_client");

  const key = await importSigningKey(DEMO);
  const now = Math.floor(Date.now() / 1000);
  const subject = await signJwt(
    { alg: "ES256", typ: "at+jwt", kid: DEMO.kid },
    { iss: "http://127.0.0.1:8788", sub: "usr_1", aud: "melody-exchange", iat: now, exp: now + 600, token_use: "access", scope: "email", client_id: "melody-exchange", jti: "jti_sub" },
    key,
  );
  const escalated = await handleToken(
    form("/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      client_id: "melody-exchange",
      client_secret: "secret",
      subject_token: subject,
      scope: "email api",
    }),
    envWith(dbOf({ app: exchanger, user: USER })),
  );
  expect(escalated.status).toBe(400);
  expect((await escalated.json()).error).toBe("invalid_scope");
  resetRingForTests();
});

test("introspection stays confidential and revocation ignores another client's token", async () => {
  resetRingForTests();
  const publicApp = {
    client_id: "melody-sample",
    client_type: "public",
    token_endpoint_auth_method: "none",
    expires_at: null,
    grant_types: "[]",
    scopes: "openid",
    resources: null,
  } as FullApp;
  await expect(requireConfidential(publicApp)).rejects.toBeInstanceOf(OauthError);
  await expect(handleIntrospect(form("/introspect", { client_id: "melody-sample", token: "t" }), envWith(dbOf({ app: publicApp })))).rejects.toBeInstanceOf(OauthError);

  const owner = await machine(["client_credentials"]);
  let revokes = 0;
  const ignored = await handleRevoke(
    form("/revoke", { client_id: "melody-machine", client_secret: "secret", token: "refresh-token" }),
    envWith(
      dbOf({
        app: owner,
        refresh: { client_id: "someone-else", family_id: "fam", revoked_at: null, expires_at: Date.now() + 60_000 },
        onRun: (sql) => {
          if (sql.includes("revoked_at")) revokes += 1;
        },
      }),
    ),
  );
  expect(ignored.status).toBe(200);
  expect(revokes).toBe(0);

  const own = await handleRevoke(
    form("/revoke", { client_id: "melody-sample", token: "refresh-token" }),
    envWith(
      dbOf({
        app: publicApp,
        refresh: { client_id: "melody-sample", family_id: "fam", revoked_at: null, expires_at: Date.now() + 60_000 },
        onRun: (sql) => {
          if (sql.includes("revoked_at")) revokes += 1;
        },
      }),
    ),
  );
  expect(own.status).toBe(200);
  expect(revokes).toBe(1);
  resetRingForTests();
});

test("the device sign-in link returns to the user code", async () => {
  const app = {
    client_id: "melody-sample",
    name: "Sample",
    client_type: "public",
    token_endpoint_auth_method: "none",
    registration_access_hash: null,
    expires_at: null,
  } as FullApp;
  const env = envWith(
    dbOf({
      app,
      device: {
        id: "dev_1",
        client_id: "melody-sample",
        user_code: "ABCD-EFGH",
        scope: "openid",
        audience: null,
        expires_at: Date.now() + 60_000,
      },
      user: null,
    }),
  );
  const res = await handleDevicePage(new Request("http://127.0.0.1:8788/device?user_code=ABCD-EFGH"), env, false);
  expect(res.status).toBe(401);
  const html = await res.text();
  expect(html).toContain("return_to=");
  expect(html).toContain("user_code%3DABCD-EFGH");
});
