/**
 * Minimal Git smart-HTTP push.
 * Pack zlib payloads are the object contents only. A real `git gc` pack stores
 * `hello\n` for a blob, not the loose `blob 6\0` header. The type and size live
 * in the pack object header. Object ids still hash the loose header plus contents.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ZERO_SHA = "0000000000000000000000000000000000000000";

export type GitObject = { type: "commit" | "tree" | "blob"; sha: string; data: Uint8Array };

export function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const part of parts) len += part.length;
  const out = new Uint8Array(len);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

async function sha1(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-1", data);
  return new Uint8Array(digest);
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function makeObject(type: GitObject["type"], data: Uint8Array): Promise<GitObject> {
  const header = encoder.encode(`${type} ${data.length}\0`);
  const sha = toHex(await sha1(concat([header, data])));
  return { type, sha, data };
}

export async function makeBlob(content: string): Promise<GitObject> {
  return makeObject("blob", encoder.encode(content));
}

type TreeEntryIn = { name: string; mode: string; hash: string };

function sortKey(entry: TreeEntryIn): string {
  return entry.mode === "40000" ? `${entry.name}/` : entry.name;
}

export async function makeTree(entries: TreeEntryIn[]): Promise<GitObject> {
  const sorted = [...entries].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  const parts: Uint8Array[] = [];
  for (const entry of sorted) {
    parts.push(encoder.encode(`${entry.mode} ${entry.name}\0`));
    parts.push(hexToBytes(entry.hash));
  }
  return makeObject("tree", concat(parts));
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export type Signature = { name: string; email: string; timestamp: number };

function formatSignature(signature: Signature): string {
  const name = signature.name.replace(/[<>\n]/g, "");
  const email = signature.email.replace(/[<>\n]/g, "");
  return `${name} <${email}> ${signature.timestamp} +0000`;
}

export async function makeCommit(opts: {
  tree: string;
  parents: string[];
  author: Signature;
  message: string;
}): Promise<GitObject> {
  const lines = [`tree ${opts.tree}`];
  for (const parent of opts.parents) lines.push(`parent ${parent}`);
  const who = formatSignature(opts.author);
  lines.push(`author ${who}`, `committer ${who}`);
  const message = opts.message.endsWith("\n") ? opts.message : `${opts.message}\n`;
  return makeObject("commit", encoder.encode(`${lines.join("\n")}\n\n${message}`));
}

type FsNode = { files: Map<string, string>; dirs: Map<string, FsNode> };

function emptyNode(): FsNode {
  return { files: new Map(), dirs: new Map() };
}

/** Build a tree (and nested trees) from repo-relative paths. Returns every new object. */
export async function treeFromFiles(files: Record<string, string>): Promise<{ tree: GitObject; objects: GitObject[] }> {
  const root = emptyNode();
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
      throw new Error(`Refusing path ${path}`);
    }
    let node = root;
    for (const dir of parts.slice(0, -1)) {
      let child = node.dirs.get(dir);
      if (!child) {
        child = emptyNode();
        node.dirs.set(dir, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1]!, content);
  }
  const objects: GitObject[] = [];
  const tree = await writeNode(root, objects);
  return { tree, objects };
}

async function writeNode(node: FsNode, objects: GitObject[]): Promise<GitObject> {
  const entries: TreeEntryIn[] = [];
  for (const [name, content] of node.files) {
    const blob = await makeBlob(content);
    objects.push(blob);
    entries.push({ name, mode: "100644", hash: blob.sha });
  }
  for (const [name, child] of node.dirs) {
    const subtree = await writeNode(child, objects);
    entries.push({ name, mode: "40000", hash: subtree.sha });
  }
  const tree = await makeTree(entries);
  objects.push(tree);
  return tree;
}

function objectHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let byte = (type << 4) | (size & 0x0f);
  size >>>= 4;
  while (size > 0) {
    bytes.push(byte | 0x80);
    byte = size & 0x7f;
    size >>>= 7;
  }
  bytes.push(byte);
  return new Uint8Array(bytes);
}

const TYPE_CODES = { commit: 1, tree: 2, blob: 3 } as const;

async function buildPack(objects: GitObject[]): Promise<Uint8Array> {
  const header = new Uint8Array(12);
  header.set(encoder.encode("PACK"), 0);
  const view = new DataView(header.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, objects.length);
  const parts: Uint8Array[] = [header];
  for (const object of objects) {
    parts.push(objectHeader(TYPE_CODES[object.type], object.data.length));
    parts.push(await deflate(object.data));
  }
  const body = concat(parts);
  return concat([body, await sha1(body)]);
}

function pktLine(line: string): Uint8Array {
  const payload = encoder.encode(line);
  const len = (payload.length + 4).toString(16).padStart(4, "0");
  return concat([encoder.encode(len), payload]);
}

const FLUSH = encoder.encode("0000");

type Pkt = { type: "flush" } | { type: "data"; data: Uint8Array };

function parsePktLines(buf: Uint8Array): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const len = Number.parseInt(decoder.decode(buf.subarray(offset, offset + 4)), 16);
    if (Number.isNaN(len)) break;
    if (len === 0 || len === 1 || len === 2) {
      out.push({ type: "flush" });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) break;
    out.push({ type: "data", data: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return out;
}

export class GitPushError extends Error {}

/** Push one commit to `refs/heads/main`. `parent` is null for the seed commit. */
export async function pushCommit(opts: {
  remote: string;
  token: string;
  parent: string | null;
  files: Record<string, string>;
  message: string;
  author: Signature;
}): Promise<string> {
  const { tree, objects } = await treeFromFiles(opts.files);
  const commit = await makeCommit({
    tree: tree.sha,
    parents: opts.parent ? [opts.parent] : [],
    author: opts.author,
    message: opts.message,
  });
  const pack = await buildPack([...objects, commit]);
  const old = opts.parent ?? ZERO_SHA;
  const command = pktLine(`${old} ${commit.sha} refs/heads/main\0report-status agent=tech-demos-memory-repo\n`);
  const body = concat([command, FLUSH, pack]);
  const remote = opts.remote.replace(/\/$/, "");
  const res = await fetch(`${remote}/git-receive-pack`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.token}`,
      "content-type": "application/x-git-receive-pack-request",
      accept: "application/x-git-receive-pack-result",
      "user-agent": "git/2.47.0",
    },
    body,
  });
  const raw = new Uint8Array(await res.arrayBuffer());
  const text = decoder.decode(raw);
  if (!res.ok) throw new GitPushError(`push failed: ${res.status} ${text.slice(0, 240)}`);
  const report = parsePktLines(raw)
    .filter((pkt): pkt is { type: "data"; data: Uint8Array } => pkt.type === "data")
    .map((pkt) => decoder.decode(pkt.data).trim());
  const unpack = report.find((line) => line.startsWith("unpack"));
  if (unpack && unpack !== "unpack ok") throw new GitPushError(unpack);
  const failed = report.filter((line) => line.startsWith("ng "));
  if (failed.length > 0) throw new GitPushError(failed.join("; "));
  return commit.sha;
}
