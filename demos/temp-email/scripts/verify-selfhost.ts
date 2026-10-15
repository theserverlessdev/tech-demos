/**
 * Copy this folder alone and exercise the `deploy` script the way the Deploy to Cloudflare button does.
 * Usage: bun run verify:selfhost
 */
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const src = join(import.meta.dir, "..");
const dest = await mkdtemp(join(tmpdir(), "temp-email-selfhost-"));
const outdir = join(dest, ".dry-run");

function run(cmd: string[], cwd: string) {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (result.exitCode !== 0) {
    console.error(out);
    throw new Error(`${cmd.join(" ")} failed with ${result.exitCode}`);
  }
  return out;
}

const pkg = await Bun.file(join(src, "package.json")).json();
const deploy = String(pkg.scripts?.deploy ?? "");
const hosted = String(pkg.scripts?.["deploy:hosted"] ?? "");
if (!deploy.includes("wrangler deploy") || deploy.includes("wrangler.hosted")) {
  throw new Error("package.json deploy must be the self-host command (no wrangler.hosted.jsonc)");
}
if (!deploy.includes("d1 migrations apply DB --remote")) {
  throw new Error("package.json deploy must apply D1 migrations so the Deploy button is not an empty database");
}
if (!hosted.includes("wrangler.hosted.jsonc")) {
  throw new Error("package.json deploy:hosted must use wrangler.hosted.jsonc");
}

try {
  await cp(src, dest, {
    recursive: true,
    filter: (path) => !path.includes("node_modules") && !path.includes(".wrangler"),
  });
  console.log(`Isolated copy: ${dest}`);
  run(["bun", "install"], dest);
  // Same build the `deploy` script runs, then dry-run wrangler deploy (the Deploy button's command).
  run(["bun", "run", "build"], dest);
  const out = run(["bunx", "wrangler", "deploy", "--dry-run", "--outdir", outdir], dest);
  console.log(out);
  if (/Could not resolve|packages\/shared/.test(out)) {
    throw new Error("Standalone bundle still resolves files outside the Worker folder");
  }
  if (/wrangler\.hosted|email\.lomvic\.com/.test(out) && /Custom domains|Routes/.test(out)) {
    throw new Error("Self-host dry-run targeted hosted routes");
  }
  const bundled = await Bun.file(join(outdir, "index.js")).text();
  if (bundled.includes("packages/shared")) {
    throw new Error("Bundled worker still mentions packages/shared");
  }
  console.log("Standalone `deploy` dry-run succeeded.");
} finally {
  await rm(dest, { recursive: true, force: true });
}
