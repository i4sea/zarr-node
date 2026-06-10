// Guard against publishing a package.json that advertises entry points
// which the build did not produce (e.g. an exports subpath added ahead of
// its implementation). Walks every path in `exports` plus the top-level
// `main`/`module`/`types` fields and fails if any file is missing from
// the working tree. Run after `npm run build` (see prepublishOnly).
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

function collectPaths(node, found) {
  if (typeof node === "string") {
    if (node.startsWith("./")) found.add(node);
  } else if (node && typeof node === "object") {
    for (const value of Object.values(node)) collectPaths(value, found);
  }
}

const declared = new Set();
collectPaths(pkg.exports, declared);
for (const field of ["main", "module", "types"]) {
  if (typeof pkg[field] === "string") declared.add(pkg[field]);
}

const missing = [...declared].filter((p) => !existsSync(join(root, p)));

if (missing.length > 0) {
  console.error(
    "[validate-exports] package.json declares entry points that do not exist:",
  );
  for (const p of missing) console.error(`  - ${p}`);
  console.error(
    "[validate-exports] build the missing artifacts or remove the entries before publishing.",
  );
  process.exit(1);
}

console.log(
  `[validate-exports] all ${declared.size} declared entry points resolve.`,
);
