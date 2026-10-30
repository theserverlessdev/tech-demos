/**
 * Copy this folder alone and dry-run the deploy script.
 * Usage: bun run verify:selfhost
 */
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const src = join(import.meta.dir, "..");
const dest = await mkdtemp(join(tmpdir(), "pairlane-selfhost-"));
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
if (!deploy.includes("wrangler deploy") || !deploy.includes("bun run build")) {
  throw new Error("package.json deploy must build the page and then wrangler deploy");
}

try {
  await cp(src, dest, {
    recursive: true,
    filter: (file) => !file.includes("node_modules") && !file.includes(".wrangler") && !file.includes("/artifacts"),
  });
  console.log(`Isolated copy: ${dest}`);
  run(["bun", "install"], dest);
  run(["bun", "run", "build"], dest);
  const out = run(["bunx", "wrangler", "deploy", "--dry-run", "--outdir", outdir], dest);
  console.log(out);
  if (/Could not resolve|packages\/shared/.test(out)) {
    throw new Error("Standalone bundle still resolves files outside the Worker folder");
  }
  const bundled = await Bun.file(join(outdir, "index.js")).text();
  if (bundled.includes("packages/shared")) throw new Error("Bundled worker still mentions packages/shared");
  if (!bundled.includes("PairRoom")) throw new Error("Bundled worker is missing PairRoom");
  console.log("Standalone deploy dry-run succeeded.");
} finally {
  await rm(dest, { recursive: true, force: true });
}
