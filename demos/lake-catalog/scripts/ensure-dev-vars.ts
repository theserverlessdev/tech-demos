import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, ".dev.vars");
if (!existsSync(target)) {
  writeFileSync(target, readFileSync(join(root, ".dev.vars.example")));
  console.log("Wrote .dev.vars from .dev.vars.example");
}
