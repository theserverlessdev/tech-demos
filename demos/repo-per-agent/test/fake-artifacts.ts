import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactsBinding, ArtifactsRepo, CommitMeta, CreatedRepo, TreeEntry } from "../src/worker/env";

type Token = { plaintext: string; scope: "read" | "write"; expiresAt: number };

export type ArtifactsCalls = { method: string; repo?: string }[];

function runGit(dir: string, args: string[], input?: Uint8Array): Promise<{ code: number; stdout: Uint8Array; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: dir });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk) => out.push(chunk as Buffer));
    child.stderr.on("data", (chunk) => err.push(chunk as Buffer));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") });
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function parseCommit(hash: string, text: string): CommitMeta | null {
  const tree = text.match(/^tree ([0-9a-f]{40})/m)?.[1];
  if (!tree) return null;
  const parents = [...text.matchAll(/^parent ([0-9a-f]{40})/gm)].map((match) => match[1]!);
  const authorLine = text.match(/^author (.+) <([^>]+)> (\d+) /m);
  const message = text.split("\n\n").slice(1).join("\n\n").replace(/\n$/, "");
  return {
    hash,
    treeHash: tree,
    message,
    parents,
    authoredAt: authorLine?.[3] ? Number(authorLine[3]) * 1000 : 0,
    author: authorLine ? { name: authorLine[1], email: authorLine[2] } : undefined,
  };
}

export class FakeArtifacts implements ArtifactsBinding {
  readonly calls: ArtifactsCalls = [];
  readonly root: string;
  #server: ReturnType<typeof Bun.serve> | null = null;
  #repos = new Map<string, { dir: string; tokens: Token[] }>();

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), "rpa-art-"));
  }

  get origin(): string {
    if (!this.#server) throw new Error("fake artifacts HTTP is not listening");
    return `http://127.0.0.1:${this.#server.port}`;
  }

  async listen(): Promise<void> {
    const self = this;
    this.#server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const match = url.pathname.match(/^\/git\/([^/]+)\.git\/git-receive-pack$/);
        if (!match || request.method !== "POST") return new Response("not found", { status: 404 });
        const name = decodeURIComponent(match[1] ?? "");
        const repo = self.#repos.get(name);
        if (!repo) return new Response("missing repo", { status: 404 });
        const auth = request.headers.get("authorization") ?? "";
        const token = auth.replace(/^Bearer\s+/i, "");
        const found = repo.tokens.find((item) => item.plaintext === token && item.expiresAt > Date.now());
        if (!found) return new Response("unauthorized", { status: 401 });
        if (found.scope !== "write") return new Response("read token cannot push", { status: 403 });
        const body = new Uint8Array(await request.arrayBuffer());
        const result = await runGit(repo.dir, ["receive-pack", "--stateless-rpc", repo.dir], body);
        return new Response(result.stdout, {
          status: 200,
          headers: { "content-type": "application/x-git-receive-pack-result" },
        });
      },
    });
  }

  async create(name: string): Promise<CreatedRepo> {
    this.calls.push({ method: "create", repo: name });
    const dir = join(this.root, name);
    mkdirSync(dir, { recursive: true });
    const init = await runGit(dir, ["init", "--bare"]);
    if (init.code !== 0) throw new Error(init.stderr || "git init failed");
    await runGit(dir, ["config", "receive.advertisePushOptions", "false"]);
    const expiresAt = Date.now() + 120_000;
    const token: Token = { plaintext: `art_write_${name}_${expiresAt}?expires=${Math.floor(expiresAt / 1000)}`, scope: "write", expiresAt };
    this.#repos.set(name, { dir, tokens: [token] });
    return { name, remote: `${this.origin}/git/${name}.git`, defaultBranch: "main", token: { plaintext: token.plaintext } };
  }

  async get(name: string): Promise<ArtifactsRepo> {
    this.calls.push({ method: "get", repo: name });
    const repo = this.#repos.get(name);
    if (!repo) throw new Error(`unknown repo ${name}`);
    const dir = repo.dir;
    const self = this;
    return {
      async info() {
        return { name, remote: `${self.origin}/git/${name}.git`, defaultBranch: "main" };
      },
      async createToken(scope: "read" | "write" = "read", ttlSeconds = 600) {
        self.calls.push({ method: "createToken", repo: name });
        const expiresAt = Date.now() + ttlSeconds * 1000;
        const token: Token = {
          plaintext: `art_${scope}_${name}_${expiresAt}?expires=${Math.floor(expiresAt / 1000)}`,
          scope,
          expiresAt,
        };
        repo.tokens.push(token);
        return { plaintext: token.plaintext, expiresAt: new Date(expiresAt).toISOString() };
      },
      async revokeToken(tokenOrId: string) {
        self.calls.push({ method: "revokeToken", repo: name });
        repo.tokens = repo.tokens.filter((item) => item.plaintext !== tokenOrId);
        return {};
      },
      async log(opts) {
        self.calls.push({ method: "log", repo: name });
        const limit = String(opts?.limit ?? 20);
        const result = await runGit(dir, ["log", `-n${limit}`, "--format=%H", opts?.ref ?? "main"]);
        if (result.code !== 0) return [];
        const hashes = result.stdout.toString("utf8").trim().split("\n").filter(Boolean);
        const commits: CommitMeta[] = [];
        for (const hash of hashes) {
          const commit = await this.readCommit(hash);
          if (commit) commits.push(commit);
        }
        return commits;
      },
      async readCommit(hash: string) {
        self.calls.push({ method: "readCommit", repo: name });
        const result = await runGit(dir, ["cat-file", "-p", hash]);
        if (result.code !== 0) return null;
        return parseCommit(hash, result.stdout.toString("utf8"));
      },
      async readTree(hash: string) {
        self.calls.push({ method: "readTree", repo: name });
        const result = await runGit(dir, ["ls-tree", hash]);
        if (result.code !== 0) return null;
        const entries: TreeEntry[] = [];
        for (const line of result.stdout.toString("utf8").trim().split("\n").filter(Boolean)) {
          const match = line.match(/^(\d+)\s+(\w+)\s+([0-9a-f]{40})\t(.+)$/);
          if (!match) continue;
          const mode = match[1] ?? "";
          const type = match[2] === "tree" ? "tree" : match[2] === "blob" && mode === "100755" ? "exec" : "blob";
          entries.push({ name: match[4] ?? "", mode, hash: match[3] ?? "", type });
        }
        return entries;
      },
      async readBlob(hash: string) {
        self.calls.push({ method: "readBlob", repo: name });
        const result = await runGit(dir, ["cat-file", "blob", hash]);
        if (result.code !== 0) return null;
        return new Blob([result.stdout]);
      },
      async readFile(args: { ref: string; path: string }) {
        self.calls.push({ method: "readFile", repo: name });
        const result = await runGit(dir, ["show", `${args.ref}:${args.path}`]);
        if (result.code !== 0) return null;
        return new Blob([result.stdout]);
      },
    };
  }

  async delete(name: string): Promise<unknown> {
    this.calls.push({ method: "delete", repo: name });
    const repo = this.#repos.get(name);
    if (repo) rmSync(repo.dir, { recursive: true, force: true });
    this.#repos.delete(name);
    return {};
  }

  async list(): Promise<{ repos?: { name: string }[] }> {
    this.calls.push({ method: "list" });
    return { repos: [...this.#repos.keys()].map((name) => ({ name })) };
  }

  stop(): void {
    this.#server?.stop(true);
    this.#server = null;
    rmSync(this.root, { recursive: true, force: true });
  }
}
