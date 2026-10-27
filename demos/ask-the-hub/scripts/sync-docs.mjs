#!/usr/bin/env node
import { createHash, createHmac } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const BUCKET = "tech-demos-hub-docs";
const REGION = "auto";
const SERVICE = "s3";
const DOC_NAMES = ["README.md", "PLAN.md"];

export function isDocKey(key) {
  return /^[a-z0-9][a-z0-9-]*\/(README|PLAN)\.md$/.test(key);
}

export function planDiff(local, remote, { prune = false } = {}) {
  const remoteHash = new Map(remote.map((item) => [item.key, item.sha256]));
  const localKeys = new Set(local.map((item) => item.key));
  const upload = [];
  const skip = [];
  const remove = [];
  for (const item of local) {
    if (remoteHash.get(item.key) === item.sha256) skip.push(item.key);
    else upload.push(item.key);
  }
  if (prune) {
    for (const item of remote) {
      if (!localKeys.has(item.key) && isDocKey(item.key)) remove.push(item.key);
    }
  }
  upload.sort();
  skip.sort();
  remove.sort();
  return { upload, skip, remove };
}

export async function collectLocal(demosDir) {
  const entries = await readdir(demosDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]*$/.test(entry.name)) continue;
    for (const name of DOC_NAMES) {
      const full = path.join(demosDir, entry.name, name);
      try {
        const body = await readFile(full);
        files.push({
          key: `${entry.name}/${name}`,
          sha256: createHash("sha256").update(body).digest("hex"),
          body,
        });
      } catch (err) {
        if (err && err.code !== "ENOENT") throw err;
      }
    }
  }
  files.sort((a, b) => a.key.localeCompare(b.key));
  return files;
}

export function parseArgs(argv) {
  const out = { dryRun: false, prune: false, root: "", bucket: BUCKET };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--prune") out.prune = true;
    else if (arg === "--root") out.root = argv[++i] ?? "";
    else if (arg === "--bucket") out.bucket = argv[++i] || BUCKET;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

export async function runSync({ local, remote, client, dryRun, prune }) {
  const plan = planDiff(local, remote, { prune });
  const byKey = new Map(local.map((item) => [item.key, item]));
  const actions = [];
  for (const key of plan.skip) actions.push({ op: "skip", key });
  for (const key of plan.upload) {
    actions.push({ op: dryRun ? "would-upload" : "upload", key });
    if (!dryRun) {
      const file = byKey.get(key);
      await client.put(key, file.body, file.sha256);
    }
  }
  for (const key of plan.remove) {
    actions.push({ op: dryRun ? "would-delete" : "delete", key });
    if (!dryRun) await client.delete(key);
  }
  return { plan, actions };
}

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key, data) {
  return createHmac("sha256", key).update(data).digest();
}

function signingKey(secret, ymd) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, ymd), REGION), SERVICE), "aws4_request");
}

function encodePath(value) {
  return value.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function encodeQuery(params) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => [encodeURIComponent(key), encodeURIComponent(String(value))])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function decodeXml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

async function signedFetch({ accountId, accessKeyId, secretAccessKey, bucket, method, key, query, body, extraHeaders }) {
  const now = new Date();
  const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const ymd = amz.slice(0, 8);
  const payload = body ?? Buffer.alloc(0);
  const payloadHash = sha256Hex(payload);
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${encodePath(bucket)}${key ? `/${encodePath(key)}` : ""}`;
  const canonicalQuery = encodeQuery(query ?? {});
  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amz,
    ...(extraHeaders ?? {}),
  };
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = names.map((name) => `${name}:${String(headers[Object.keys(headers).find((item) => item.toLowerCase() === name)]).trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const canonical = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${ymd}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amz, scope, sha256Hex(canonical)].join("\n");
  const signature = createHmac("sha256", signingKey(secretAccessKey, ymd)).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = `https://${host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
  return fetch(url, {
    method,
    headers: { ...headers, authorization },
    body: method === "GET" || method === "HEAD" ? undefined : payload,
  });
}

export function createR2Client({ accountId, accessKeyId, secretAccessKey, bucket, fetchImpl }) {
  const call = (opts) =>
    signedFetch({
      accountId,
      accessKeyId,
      secretAccessKey,
      bucket,
      ...opts,
    });
  const request = fetchImpl ?? call;
  return {
    async list() {
      const keys = [];
      let token = "";
      for (;;) {
        const res = await request({
          method: "GET",
          query: { "list-type": "2", "continuation-token": token },
        });
        if (!res.ok) throw new Error(`List failed (${res.status})`);
        const xml = await res.text();
        for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(decodeXml(match[1]));
        if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
        const next = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/);
        if (!next) break;
        token = decodeXml(next[1]);
      }
      return keys;
    },
    async head(key) {
      const res = await request({ method: "HEAD", key });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Head failed for ${key} (${res.status})`);
      return res.headers.get("x-amz-meta-sha256") ?? "";
    },
    async put(key, body, sha256) {
      const res = await request({
        method: "PUT",
        key,
        body,
        extraHeaders: {
          "content-type": "text/markdown; charset=utf-8",
          "x-amz-meta-sha256": sha256,
        },
      });
      if (!res.ok) throw new Error(`Put failed for ${key} (${res.status})`);
    },
    async delete(key) {
      const res = await request({ method: "DELETE", key });
      if (!res.ok && res.status !== 404) throw new Error(`Delete failed for ${key} (${res.status})`);
    },
  };
}

async function remoteState(client) {
  const keys = await client.list();
  const remote = [];
  for (const key of keys) {
    if (!isDocKey(key)) continue;
    const sha256 = await client.head(key);
    if (sha256 === null) continue;
    remote.push({ key, sha256 });
  }
  return remote;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root ? path.resolve(args.root) : path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
  const demosDir = path.join(root, "demos");
  const local = await collectLocal(demosDir);
  const accountId = process.env.R2_ACCOUNT_ID ?? "";
  const accessKeyId = process.env.R2_ACCESS_KEY_ID ?? "";
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? "";
  if (!accountId || !accessKeyId || !secretAccessKey) {
    if (!args.dryRun) {
      console.error("Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY.");
      process.exit(1);
    }
    for (const file of local) console.log(`would-upload ${file.key}`);
    console.log("dry-run without R2 credentials; remote objects were not listed.");
    return;
  }
  const client = createR2Client({ accountId, accessKeyId, secretAccessKey, bucket: args.bucket });
  const remote = await remoteState(client);
  const { actions } = await runSync({ local, remote, client, dryRun: args.dryRun, prune: args.prune });
  for (const action of actions) console.log(`${action.op} ${action.key}`);
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : "sync failed");
    process.exit(1);
  });
}
