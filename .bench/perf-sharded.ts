// T051: bytes transferred for a sub-region read of v3_sharded_large —
// byte-range path vs whole-shard baseline. Local measurement, no CI target.
import { join } from "node:path";
import { FileSystemStore } from "../src/store/filesystem.js";
import { openArray } from "../src/index.js";
import type { Store } from "../src/store/store.js";

const FIXTURE = new URL("../tests/fixtures/v3_sharded_large", import.meta.url).pathname;

function counting(inner: FileSystemStore, ranged: boolean) {
  let bytes = 0;
  let requests = 0;
  const store: Store = {
    async get(key) {
      const r = await inner.get(key);
      if (r) {
        bytes += r.byteLength;
        requests++;
      }
      return r;
    },
    async has(key) {
      return inner.has(key);
    },
    async *list(prefix) {
      yield* inner.list(prefix);
    },
  };
  if (ranged) {
    store.getRange = async (key, offset, length) => {
      const r = await inner.getRange(key, offset, length);
      if (r) {
        bytes += r.byteLength;
        requests++;
      }
      return r;
    };
    store.head = (key) => inner.head(key);
  }
  return { store, bytes: () => bytes, requests: () => requests };
}

// Sub-region: 500x500 window crossing shard boundaries at (750..1250)^2.
// Touches 4 shards; 9 inner chunks (250x250) → ~2.25 MB of data.
const SEL: [number, number][] = [
  [750, 1250],
  [750, 1250],
];

async function run(ranged: boolean) {
  const c = counting(new FileSystemStore({ path: FIXTURE }), ranged);
  const arr = await openArray(c.store);
  const t0 = performance.now();
  const out = await arr.get(SEL);
  const ms = performance.now() - t0;
  return { out, ms, bytes: c.bytes(), requests: c.requests() };
}

async function main() {
  const rangedRun = await run(true);
  const wholeRun = await run(false);

  // sanity: identical values
  for (let i = 0; i < rangedRun.out.length; i++) {
    if (rangedRun.out[i] !== wholeRun.out[i]) throw new Error("value mismatch");
  }

  const mb = (n: number) => (n / 1e6).toFixed(2);
  console.log(`selection 500x500 f4 (~${mb(500 * 500 * 4)} MB of data)`);
  console.log(
    `byte-range path : ${mb(rangedRun.bytes)} MB in ${rangedRun.requests} requests, ${rangedRun.ms.toFixed(0)} ms`,
  );
  console.log(
    `whole-shard path: ${mb(wholeRun.bytes)} MB in ${wholeRun.requests} requests, ${wholeRun.ms.toFixed(0)} ms`,
  );
  console.log(
    `transfer reduction: ${(wholeRun.bytes / rangedRun.bytes).toFixed(1)}x`,
  );
}

void main();
