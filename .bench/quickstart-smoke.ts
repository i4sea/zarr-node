// T055: run the quickstart.md scenarios end-to-end against local fixtures.
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { FileSystemStore, openArray, openGroup } from "../src/index.js";

const FIXTURES = join(new URL(".", import.meta.url).pathname, "..", "tests", "fixtures");

async function main() {
  // 1. Reading a v3 array (identical to v2) — no version argument.
  const arr = await openArray(
    new FileSystemStore({ path: join(FIXTURES, "v3_chunked_2d") }),
  );
  console.log("v3 array:", arr.shape, arr.dtype); // same fields as v2
  const region = await arr.get([
    [0, 100],
    [0, 100],
  ]);
  console.log("  region read:", region.length, "elements OK");

  // v2 through the exact same call:
  const v2 = await openArray(
    new FileSystemStore({ path: join(FIXTURES, "chunked_2d") }),
  );
  console.log("v2 array:", v2.shape, v2.dtype);

  // 2. Reading a v3 group.
  const group = await openGroup(
    new FileSystemStore({ path: join(FIXTURES, "v3_group") }),
  );
  const child = await group.getArray("data");
  const slab = await child.get([0, null]);
  console.log("v3 group child slab:", slab.length, "elements OK");

  // 3. Sharded v3 data by byte-range.
  const sharded = await openArray(
    new FileSystemStore({ path: join(FIXTURES, "v3_sharded") }),
  );
  const window = await sharded.get([
    [15, 25],
    [15, 25],
  ]);
  const expected = JSON.parse(
    await readFile(join(FIXTURES, "v3_sharded", "expected.json"), "utf-8"),
  ) as { data: number[] };
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const want = expected.data[(15 + r) * 40 + (15 + c)];
      if (Math.abs((window[r * 10 + c] as number) - want) > 1e-4) {
        throw new Error("sharded window mismatch");
      }
    }
  }
  console.log("sharded window read: values match reference OK");

  console.log("\nquickstart smoke: ALL SCENARIOS PASS");
}

void main();
