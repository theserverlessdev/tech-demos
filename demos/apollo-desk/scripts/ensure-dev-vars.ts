import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const dest = join(dir, "..", ".dev.vars");
const src = join(dir, "..", ".dev.vars.example");
if (!existsSync(dest)) copyFileSync(src, dest);
