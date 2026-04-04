import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileSystemStore } from "../../src/store/filesystem.js";
import { runStoreContractTests } from "../contract/store.contract.js";

const TMP_DIR = join(tmpdir(), `zarr-node-fs-test-${Date.now()}`);

// Run shared contract tests
runStoreContractTests("FileSystemStore", async () => {
  const dir = join(TMP_DIR, `contract-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, "prefix"), { recursive: true });
  await writeFile(join(dir, "test-key"), Buffer.from([1, 2, 3]));
  await writeFile(join(dir, "prefix", "a"), Buffer.from([10]));
  await writeFile(join(dir, "prefix", "b"), Buffer.from([20]));

  const store = new FileSystemStore({ path: dir });
  return {
    store,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
});

describe("FileSystemStore — filesystem-specific", () => {
  const fixtureDir = join(TMP_DIR, "fs-specific");

  beforeAll(async () => {
    await mkdir(fixtureDir, { recursive: true });
    await writeFile(join(fixtureDir, "data.bin"), Buffer.from([42, 43, 44]));
  });

  afterAll(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
  });

  it("reads binary data correctly", async () => {
    const store = new FileSystemStore({ path: fixtureDir });
    const data = await store.get("data.bin");
    expect(data).toEqual(new Uint8Array([42, 43, 44]));
  });
});
