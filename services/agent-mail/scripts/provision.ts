import { chmodSync, writeFileSync } from "node:fs";

/**
 * Create an agent, an inbox, and an API key through the admin API.
 * The raw key is written to --out and is not printed.
 *
 * Local (bun run dev must already be running):
 *   bun scripts/provision.ts --name Rescue --local rescue --out ./rescue.key
 *
 * Production:
 *   ORIGIN=https://agents.theserverless.dev ACCESS_JWT=... bun scripts/provision.ts ...
 */

type Json = Record<string, unknown>;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

function usage(): never {
  console.error("Usage: bun scripts/provision.ts --name <agent> --local <inbox> --out <file>");
  console.error("The API key is written to --out and is not printed.");
  process.exit(1);
}

const name = flag("name");
const localPart = flag("local");
const out = flag("out");
const policy = flag("policy") ?? "draft";
const keyName = flag("key-name") ?? "primary";
const origin = (process.env.ORIGIN ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const accessJwt = process.env.ACCESS_JWT?.trim() ?? "";

if (!name || !localPart || !out) usage();
if (out === "-" || out === "/dev/stdout" || out === "/dev/stderr") {
  console.error("--out must be a file. The key is not written to stdout.");
  process.exit(1);
}

function headers(): Headers {
  const value = new Headers({ "content-type": "application/json", accept: "application/json" });
  if (accessJwt) value.set("cf-access-jwt-assertion", accessJwt);
  return value;
}

async function post(path: string, body: Json): Promise<{ status: number; json: Json | null }> {
  const response = await fetch(`${origin}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  const text = await response.text();
  let json: Json | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Json;
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

function errorText(json: Json | null): string {
  const error = json?.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const body = error as Json;
    const code = typeof body.code === "string" ? body.code : "error";
    const message = typeof body.message === "string" ? body.message : "";
    return `${code}${message ? `: ${message}` : ""}`;
  }
  return "The response was not the expected JSON.";
}

function stop(step: string, status: number, json: Json | null): never {
  console.error(`${step} failed with status ${status}. ${errorText(json)}`);
  process.exit(1);
}

const agent = await post("/admin/agents", { name, policy, dailySendCap: 50 });
if (agent.status !== 200 || typeof agent.json?.id !== "string") stop("Create agent", agent.status, agent.json);
const agentId = agent.json.id;

const inbox = await post(`/admin/agents/${agentId}/inboxes`, { localPart });
if (inbox.status !== 200 || typeof inbox.json?.address !== "string") stop("Create inbox", inbox.status, inbox.json);

const minted = await post(`/admin/agents/${agentId}/keys`, { name: keyName });
const key = minted.json?.key;
if (minted.status !== 201 || typeof key !== "string" || !key.startsWith("am1_")) stop("Mint key", minted.status, minted.json);

writeFileSync(out, `${key}\n`, { flag: "wx", mode: 0o600 });
chmodSync(out, 0o600);

console.log(`agent ${agentId}`);
console.log(`inbox ${inbox.json.address}`);
if (typeof inbox.json.routingRuleId === "string") console.log(`routing rule ${inbox.json.routingRuleId}`);
if (typeof inbox.json.routingNotice === "string" && inbox.json.routingNotice) console.log(inbox.json.routingNotice);
console.log(`key written to ${out}`);
