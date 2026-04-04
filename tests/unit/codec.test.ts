import { describe, it, expect } from "vitest";
import { promisify } from "node:util";
import { deflate as deflateCb } from "node:zlib";
import { RawCodec } from "../../src/codec/raw.js";
import { GzipCodec } from "../../src/codec/gzip.js";
import { codecRegistry } from "../../src/codec/codec.js";

const deflate = promisify(deflateCb);

describe("RawCodec", () => {
  it("has id 'raw'", () => {
    const codec = new RawCodec();
    expect(codec.id).toBe("raw");
  });

  it("returns the same data (no-op)", async () => {
    const codec = new RawCodec();
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const output = await codec.decode(input);
    expect(output).toEqual(input);
  });
});

describe("GzipCodec", () => {
  it("has id matching the config", () => {
    const codec = new GzipCodec("zlib");
    expect(codec.id).toBe("zlib");
  });

  it("decodes zlib-compressed data", async () => {
    const original = Buffer.from([10, 20, 30, 40, 50]);
    const compressed = await deflate(original);
    const codec = new GzipCodec("zlib");
    const decoded = await codec.decode(new Uint8Array(compressed));
    expect(Buffer.from(decoded)).toEqual(original);
  });

  it("throws on corrupted data", async () => {
    const codec = new GzipCodec("zlib");
    const garbage = new Uint8Array([0, 1, 2, 3, 4]);
    await expect(codec.decode(garbage)).rejects.toThrow();
  });
});

describe("codecRegistry", () => {
  it("has built-in zlib codec", () => {
    expect(codecRegistry.has("zlib")).toBe(true);
  });

  it("has built-in gzip codec", () => {
    expect(codecRegistry.has("gzip")).toBe(true);
  });

  it("creates a codec from compressor config", () => {
    const codec = codecRegistry.get({ id: "zlib", level: 1 });
    expect(codec.id).toBe("zlib");
  });

  it("throws for unregistered codec with descriptive message", () => {
    expect(() => codecRegistry.get({ id: "unknown-codec-xyz" })).toThrow("unknown-codec-xyz");
    expect(() => codecRegistry.get({ id: "unknown-codec-xyz" })).toThrow("register");
  });

  it("allows registering and using a custom codec", () => {
    codecRegistry.register("custom-xor", (config) => ({
      id: "custom-xor",
      async decode(data: Uint8Array): Promise<Uint8Array> {
        const key = (config.key as number) ?? 0xff;
        const out = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) {
          out[i] = data[i] ^ key;
        }
        return out;
      },
    }));

    expect(codecRegistry.has("custom-xor")).toBe(true);
    const codec = codecRegistry.get({ id: "custom-xor", key: 0xaa });
    expect(codec.id).toBe("custom-xor");
  });

  it("custom codec decodes correctly", async () => {
    const codec = codecRegistry.get({ id: "custom-xor", key: 0xff });
    const input = new Uint8Array([0x00, 0xff, 0x55]);
    const output = await codec.decode(input);
    expect(output).toEqual(new Uint8Array([0xff, 0x00, 0xaa]));
  });

  it("error message lists available codecs", () => {
    try {
      codecRegistry.get({ id: "nonexistent" });
    } catch (err) {
      expect((err as Error).message).toContain("zlib");
      expect((err as Error).message).toContain("gzip");
      expect((err as Error).message).toContain("custom-xor");
    }
  });
});
