import { describe, it, expect } from "vitest";
import { parseV3ArrayMeta } from "../../src/metadata/v3.js";
import { ZarrArray } from "../../src/array.js";
import { MissingChunkError } from "../../src/errors.js";
import type { Store, StoreHead } from "../../src/store/store.js";

const EMPTY = 0xffffffffffffffffn;

/**
 * Build a shard object: inner-chunk payloads packed in order, plus the
 * uint64-pair index (little-endian, no checksum) at `indexLocation`.
 * `entries` are [offset, nbytes] pairs (absolute within the shard) or null
 * for the reserved empty marker.
 */
function buildShard(
  chunks: Array<Uint8Array | null>,
  indexLocation: "start" | "end",
): Uint8Array {
  const indexSize = chunks.length * 16;
  const dataSize = chunks.reduce((a, c) => a + (c?.byteLength ?? 0), 0);
  const out = new Uint8Array(indexSize + dataSize);
  const dataStart = indexLocation === "start" ? indexSize : 0;
  const indexStart = indexLocation === "start" ? 0 : dataSize;

  const view = new DataView(out.buffer);
  let cursor = dataStart;
  chunks.forEach((chunk, i) => {
    if (chunk === null) {
      view.setBigUint64(indexStart + i * 16, EMPTY, true);
      view.setBigUint64(indexStart + i * 16 + 8, EMPTY, true);
      return;
    }
    out.set(chunk, cursor);
    view.setBigUint64(indexStart + i * 16, BigInt(cursor), true);
    view.setBigUint64(indexStart + i * 16 + 8, BigInt(chunk.byteLength), true);
    cursor += chunk.byteLength;
  });
  return out;
}

function i32(...values: number[]): Uint8Array {
  return new Uint8Array(new Int32Array(values).buffer);
}

interface Recording {
  gets: string[];
  ranges: Array<{ key: string; offset: number; length: number }>;
  heads: string[];
}

function recordingStore(
  entries: Record<string, Uint8Array>,
  capabilities: { getRange?: boolean; head?: boolean },
): { store: Store; calls: Recording } {
  const map = new Map(Object.entries(entries));
  const calls: Recording = { gets: [], ranges: [], heads: [] };
  const store: Store = {
    async get(key) {
      calls.gets.push(key);
      return map.get(key) ?? null;
    },
    async has(key) {
      return map.has(key);
    },
    async *list() {},
  };
  if (capabilities.getRange) {
    store.getRange = async (key, offset, length) => {
      calls.ranges.push({ key, offset, length });
      const data = map.get(key);
      return data ? data.subarray(offset, offset + length) : null;
    };
  }
  if (capabilities.head) {
    store.head = async (key): Promise<StoreHead | null> => {
      calls.heads.push(key);
      const data = map.get(key);
      return data
        ? { etag: null, lastModified: null, size: data.byteLength }
        : null;
    };
  }
  return { store, calls };
}

/** v3 sharded array doc: shape [8], shards [4], inner chunks [2], int32. */
function shardedDoc(indexLocation: "start" | "end"): string {
  return JSON.stringify({
    zarr_format: 3,
    node_type: "array",
    shape: [8],
    data_type: "int32",
    chunk_grid: { name: "regular", configuration: { chunk_shape: [4] } },
    chunk_key_encoding: { name: "default" },
    fill_value: -1,
    codecs: [
      {
        name: "sharding_indexed",
        configuration: {
          chunk_shape: [2],
          codecs: [{ name: "bytes", configuration: { endian: "little" } }],
          index_codecs: [{ name: "bytes", configuration: { endian: "little" } }],
          index_location: indexLocation,
        },
      },
    ],
    attributes: {},
  });
}

async function shardedArray(
  store: Store,
  indexLocation: "start" | "end" = "end",
): Promise<ZarrArray> {
  return new ZarrArray(store, await parseV3ArrayMeta(shardedDoc(indexLocation), ""));
}

describe("US4: sharded read strategy selection (FR-013, FR-014, SC-004)", () => {
  it("with getRange: only inner-chunk ranges are requested, zero whole-shard get", async () => {
    const { store, calls } = recordingStore(
      {
        "c/0": buildShard([i32(1, 2), i32(3, 4)], "end"),
        "c/1": buildShard([i32(5, 6), i32(7, 8)], "end"),
      },
      { getRange: true, head: true },
    );
    const arr = await shardedArray(store);

    // Touches only shard c/0, inner chunk 0.
    const data = await arr.get([[0, 2]]);
    expect(Array.from(data)).toEqual([1, 2]);

    expect(calls.gets).toHaveLength(0); // SC-004: zero full-shard downloads
    // Ranges: the index region + the touched inner chunk only.
    expect(calls.ranges).toEqual([
      { key: "c/0", offset: 16, length: 32 }, // index at end (2 × 16 bytes)
      { key: "c/0", offset: 0, length: 8 }, // inner chunk 0
    ]);
  });

  it("start-located index needs neither head nor whole-shard reads", async () => {
    const { store, calls } = recordingStore(
      { "c/0": buildShard([i32(1, 2), i32(3, 4)], "start") },
      { getRange: true }, // no head!
    );
    const arr = await shardedArray(store, "start");

    const data = await arr.get([[2, 4]]); // inner chunk 1 of shard 0
    expect(Array.from(data)).toEqual([3, 4]);

    expect(calls.gets).toHaveLength(0);
    expect(calls.ranges).toEqual([
      { key: "c/0", offset: 0, length: 32 }, // index at start
      { key: "c/0", offset: 32 + 8, length: 8 }, // inner chunk 1
    ]);
  });

  it("coalesces contiguous inner-chunk ranges into one request (FR-015)", async () => {
    const { store, calls } = recordingStore(
      { "c/0": buildShard([i32(1, 2), i32(3, 4)], "end") },
      { getRange: true, head: true },
    );
    const arr = await shardedArray(store);

    const data = await arr.get([[0, 4]]); // both inner chunks, contiguous
    expect(Array.from(data)).toEqual([1, 2, 3, 4]);

    expect(calls.gets).toHaveLength(0);
    // index + ONE coalesced span covering both inner chunks
    expect(calls.ranges).toEqual([
      { key: "c/0", offset: 16, length: 32 },
      { key: "c/0", offset: 0, length: 16 },
    ]);
  });

  it("without getRange: whole-shard fetch + in-memory slice (FR-014)", async () => {
    const { store, calls } = recordingStore(
      {
        "c/0": buildShard([i32(1, 2), i32(3, 4)], "end"),
        "c/1": buildShard([i32(5, 6), i32(7, 8)], "end"),
      },
      {}, // get-only store
    );
    const arr = await shardedArray(store);

    const data = await arr.get([[1, 6]]);
    expect(Array.from(data)).toEqual([2, 3, 4, 5, 6]);

    // One whole-shard fetch per touched shard, no ranges.
    expect(calls.gets.sort()).toEqual(["c/0", "c/1"]);
    expect(calls.ranges).toHaveLength(0);
  });

  it("with getRange but no head and an end index: falls back to whole-shard", async () => {
    const { store, calls } = recordingStore(
      { "c/0": buildShard([i32(1, 2), i32(3, 4)], "end") },
      { getRange: true }, // no head → end-located index size unknown
    );
    const arr = await shardedArray(store);

    const data = await arr.get([[0, 2]]);
    expect(Array.from(data)).toEqual([1, 2]);
    expect(calls.gets).toEqual(["c/0"]);
  });

  it("empty-marked inner chunks come back as fill value with no read issued (FR-012)", async () => {
    const { store, calls } = recordingStore(
      { "c/0": buildShard([i32(1, 2), null], "end") },
      { getRange: true, head: true },
    );
    const arr = await shardedArray(store);

    const data = await arr.get([[0, 4]]);
    expect(Array.from(data)).toEqual([1, 2, -1, -1]); // fill_value = -1

    // Only the index and inner chunk 0 were read (the empty chunk stores no
    // bytes, so this shard is 8 data + 32 index bytes).
    expect(calls.ranges).toEqual([
      { key: "c/0", offset: 8, length: 32 },
      { key: "c/0", offset: 0, length: 8 },
    ]);
    expect(calls.gets).toHaveLength(0);
  });

  it("a missing shard object fills with fill_value (non-strict)", async () => {
    const { store } = recordingStore(
      { "c/0": buildShard([i32(1, 2), i32(3, 4)], "end") },
      { getRange: true, head: true },
    );
    const arr = await shardedArray(store);

    const data = await arr.get(); // c/1 absent
    expect(Array.from(data)).toEqual([1, 2, 3, 4, -1, -1, -1, -1]);
  });

  it("a missing shard object throws MissingChunkError under strict", async () => {
    const { store } = recordingStore({}, { getRange: true, head: true });
    const arr = await shardedArray(store);

    await expect(arr.get(undefined, { strict: true })).rejects.toThrow(
      MissingChunkError,
    );
  });

  it("full-array read over both shards issues zero whole-shard gets", async () => {
    const { store, calls } = recordingStore(
      {
        "c/0": buildShard([i32(1, 2), i32(3, 4)], "end"),
        "c/1": buildShard([i32(5, 6), i32(7, 8)], "end"),
      },
      { getRange: true, head: true },
    );
    const arr = await shardedArray(store);

    const data = await arr.get();
    expect(Array.from(data)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(calls.gets).toHaveLength(0); // SC-004
  });
});
