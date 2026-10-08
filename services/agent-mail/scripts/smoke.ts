const origin = (process.env.SMOKE_ORIGIN ?? "https://agents.theserverless.dev").replace(/\/$/, "");

async function main(): Promise<void> {
  const health = await fetch(`${origin}/health`);
  const healthBody = (await health.json()) as { ok?: boolean; service?: string; domain?: string };
  if (!health.ok || healthBody.ok !== true || healthBody.service !== "agent-mail") {
    throw new Error(`GET /health failed with status ${health.status}.`);
  }
  if (healthBody.domain !== "agents.theserverless.dev") {
    throw new Error(`GET /health returned domain ${String(healthBody.domain)}.`);
  }

  const spec = await fetch(`${origin}/v1/openapi.json`);
  const openapi = (await spec.json()) as { openapi?: string };
  if (!spec.ok || openapi.openapi !== "3.1.0") {
    throw new Error(`GET /v1/openapi.json failed with status ${spec.status}.`);
  }

  const admin = await fetch(`${origin}/admin`, { redirect: "manual" });
  if (admin.status !== 403 && admin.status !== 302) {
    throw new Error(`GET /admin returned ${admin.status}. Expected 403 from the Worker or 302 from Access.`);
  }

  const key = process.env.SMOKE_API_KEY;
  if (key) {
    const me = await fetch(`${origin}/v1/me`, { headers: { authorization: `Bearer ${key}` } });
    if (!me.ok) throw new Error(`GET /v1/me failed with status ${me.status}.`);
  }

  console.log(`smoke ok ${origin}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
