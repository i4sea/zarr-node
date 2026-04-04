import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { FileSystemStore } from "../../src/store/filesystem.js";
import { openArray } from "../../src/index.js";
import { codecRegistry } from "../../src/codec/codec.js";
import type { Codec } from "../../src/codec/codec.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

describe("Blosc built-in codec", () => {
  // T001: Blosc-compressed array reads without manual registration
  it("reads Blosc-compressed array without manual registration", async () => {
    const store = new FileSystemStore({ path: join(FIXTURES, "compressed_blosc") });
    const arr = await openArray(store);

    const data = await arr.get();

    expect(data).toBeInstanceOf(Float32Array);
    expect(data.length).toBe(100);
    // Verify actual values
    for (let i = 0; i < 100; i++) {
      expect(data[i]).toBeCloseTo(i, 5);
    }
  });

  // T002: All Blosc sub-codecs handled via CompressorConfig passthrough
  it("handles Blosc with zstd sub-codec", async () => {
    const store = new FileSystemStore({ path: join(FIXTURES, "compressed_blosc_zstd") });
    const arr = await openArray(store);

    const data = await arr.get();

    expect(data).toBeInstanceOf(Float32Array);
    expect(data.length).toBe(50);
    for (let i = 0; i < 50; i++) {
      expect(data[i]).toBeCloseTo(i, 5);
    }
  });

  // T003: User-registered custom "blosc" codec takes precedence
  it("user-registered blosc codec takes precedence over built-in", async () => {
    // Register a custom blosc codec that returns fixed data
    let customCalled = false;
    const customCodec: Codec = {
      id: "blosc-custom",
      async decode(_data: Uint8Array): Promise<Uint8Array> {
        customCalled = true;
        // Return zeros instead of actual decompression
        return new Uint8Array(200); // 50 float32s = 200 bytes
      },
    };

    codecRegistry.register("blosc", () => customCodec);

    const store = new FileSystemStore({ path: join(FIXTURES, "compressed_blosc") });
    const arr = await openArray(store);
    await arr.get();

    expect(customCalled).toBe(true);

    // Re-register the built-in blosc (restore for other tests)
    // We need to re-import to trigger re-registration
    const { Blosc } = await import("numcodecs");
    codecRegistry.register("blosc", (config) => Blosc.fromConfig(config));
  });

  it("blosc codec is registered at import time", () => {
    expect(codecRegistry.has("blosc")).toBe(true);
  });
});
