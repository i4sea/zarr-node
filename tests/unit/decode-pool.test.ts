import { describe, it, expect } from "vitest";
import { DecodePool } from "../../src/codec/decode-pool.js";

// NOTE: the real worker round-trip (spawning a thread that decodes Blosc) is
// covered by the interop smoke tests (esm-interop.mjs / cjs-interop.cjs), which
// run against the built `dist/` where the compiled worker entry exists. Here we
// test the pure scheduling/threshold logic, which needs no worker.

describe("DecodePool.shouldOffload", () => {
  it("offloads Blosc chunks at or above the threshold", () => {
    const pool = new DecodePool({ poolSize: 1, minBytes: 1024 });
    expect(pool.shouldOffload("blosc", 1024)).toBe(true);
    expect(pool.shouldOffload("blosc", 4096)).toBe(true);
  });

  it("decodes inline below the threshold", () => {
    const pool = new DecodePool({ poolSize: 1, minBytes: 1024 });
    expect(pool.shouldOffload("blosc", 1023)).toBe(false);
  });

  it("never offloads non-blocking or unknown codecs", () => {
    const pool = new DecodePool({ poolSize: 1, minBytes: 0 });
    expect(pool.shouldOffload("gzip", 1 << 20)).toBe(false);
    expect(pool.shouldOffload("zlib", 1 << 20)).toBe(false);
    expect(pool.shouldOffload(null, 1 << 20)).toBe(false);
  });

  it("stops offloading after terminate", async () => {
    const pool = new DecodePool({ poolSize: 1, minBytes: 0 });
    expect(pool.shouldOffload("blosc", 4096)).toBe(true);
    await pool.terminate();
    expect(pool.shouldOffload("blosc", 4096)).toBe(false);
  });
});

describe("DecodePool lifecycle", () => {
  it("defaults poolSize to at least 1", () => {
    const pool = new DecodePool({ poolSize: -5 });
    expect(pool.poolSize).toBeGreaterThanOrEqual(1);
  });

  it("rejects decode after terminate (no worker spawned)", async () => {
    const pool = new DecodePool({ poolSize: 1, minBytes: 0 });
    await pool.terminate();
    await expect(
      pool.decode({ id: "blosc" }, new Uint8Array([1, 2, 3])),
    ).rejects.toThrow("terminated");
  });

  it("terminate is idempotent on an unstarted pool", async () => {
    const pool = new DecodePool({ poolSize: 2 });
    await pool.terminate();
    await pool.terminate();
  });
});
