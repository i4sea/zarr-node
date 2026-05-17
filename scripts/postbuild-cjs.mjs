// Post-process the CJS build so it can consume ESM-only deps.
//
// Two tasks:
//
//   1. Drop `dist/cjs/package.json` with `{"type":"commonjs"}` so Node
//      treats the .js files in that folder as CommonJS, overriding the
//      parent package.json's `"type": "module"`.
//
//   2. Patch `dist/cjs/codec/codec.js`: tsc transpiles dynamic
//      `import("numcodecs")` to `Promise.resolve().then(() => require(...))`
//      under `module: commonjs`. That `require()` of an ESM-only
//      package throws `ERR_REQUIRE_ESM` at runtime. We rewrite that one
//      line to use a real ESM dynamic `import()` via indirect eval —
//      Node always honors the ESM loader for `import()`, regardless of
//      the caller's module system. Indirect eval (the `(0, eval)(...)`
//      form) executes in global scope where Node attaches the import
//      callback.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cjsRoot = resolve(here, "..", "dist", "cjs");

await mkdir(cjsRoot, { recursive: true });
await writeFile(
  join(cjsRoot, "package.json"),
  JSON.stringify({ type: "commonjs" }, null, 2) + "\n",
  "utf8",
);

const codecPath = join(cjsRoot, "codec", "codec.js");
const before = await readFile(codecPath, "utf8");
const patched = before.replace(
  /Promise\.resolve\(\)\.then\(\(\) => __importStar\(require\("numcodecs"\)\)\);?/g,
  '(0, eval)(\'import("numcodecs")\');',
);
if (patched === before) {
  throw new Error(
    `[postbuild-cjs] failed to patch numcodecs dynamic import in ${codecPath}. ` +
      `The tsc emit shape may have changed.`,
  );
}
await writeFile(codecPath, patched, "utf8");

console.log(`[postbuild-cjs] wrote ${join(cjsRoot, "package.json")}`);
console.log(`[postbuild-cjs] patched ${codecPath}`);
