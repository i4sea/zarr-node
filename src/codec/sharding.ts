// v3 `sharding_indexed` reader (feature 006, US4).
//
// Sharding is NOT a plain codec: a plain codec receives already-fetched bytes,
// while sharding must decide WHAT to fetch — it needs the store, the shard
// key, `getRange` and the inner-chunk geometry BEFORE any bytes are read (see
// contracts/sharding.md "Where sharding lives"). The read path routes a
// sharded array's chunk reads here instead of `loadChunks`; each inner chunk
// is then decoded through its own inner `CodecPipeline`.
//
// This is also where the loader's historical "getRange only when uncompressed"
// gating is deliberately relaxed (research R6): inner chunks are range-read
// even when compressed, because the shard index tells us their exact byte
// extents. Non-sharded reads keep the pass-through-only gating in loader.ts.
import type { Store } from "../store/store.js";
import type { MemoryCache } from "../cache/memory.js";
import type { ObservabilityHooks } from "../observability.js";
import { safeInvoke } from "../observability.js";
import type { ByteLimiter } from "../chunk/limiter.js";
import type { DecodePool } from "./decode-pool.js";
import type { ChunkDecodeContext, CodecPipeline } from "./pipeline.js";
import type { ByteOrder, ShardingInfo } from "../metadata/types.js";
import type { LoadedChunk } from "../chunk/loader.js";
import { CodecError, MetadataError, MissingChunkError } from "../errors.js";

/** Reserved marker: offset === nbytes === 2^64-1 ⇒ empty inner chunk. */
const EMPTY_MARKER = 0xffffffffffffffffn;

/** One decoded shard-index entry; null represents the empty marker. */
export interface ShardIndexEntry {
  offset: number;
  nbytes: number;
}

/** Byte overhead each known index codec adds to the stored index. */
const INDEX_CODEC_OVERHEAD: Record<string, number> = {
  bytes: 0,
  crc32c: 4,
};

/**
 * Derive the STORED shard-index size: `N × 16` bytes of `(offset, nbytes)`
 * uint64 pairs plus the index codecs' fixed overhead (e.g. crc32c's 4 bytes).
 * Rejects index codecs with non-derivable sizes (e.g. compressors) — the
 * derived size is what lets a ranged store read only the index region.
 */
export function shardIndexSize(
  chunksPerShard: number,
  indexCodecs: Array<{ name: string }>,
): number {
  let size = chunksPerShard * 16;
  for (const codec of indexCodecs) {
    const overhead = INDEX_CODEC_OVERHEAD[codec.name];
    if (overhead === undefined) {
      throw new MetadataError(
        `Unsupported shard index codec "${codec.name}": the stored index ` +
          `size must be derivable (supported: bytes, crc32c)`,
      );
    }
    size += overhead;
  }
  return size;
}

/**
 * Decode the raw stored index through the shard's `index_codecs` pipeline
 * (verifying its crc32c when present — FR-008a), then read the
 * `(offset, nbytes)` uint64 pairs. `null` entries are empty inner chunks.
 */
export async function decodeShardIndex(
  raw: Uint8Array,
  chunksPerShard: number,
  indexPipeline: CodecPipeline,
  byteOrder: ByteOrder,
): Promise<Array<ShardIndexEntry | null>> {
  const decoded = await indexPipeline.decode(raw);
  if (decoded.byteLength !== chunksPerShard * 16) {
    throw new MetadataError(
      `Malformed shard index: decoded to ${decoded.byteLength} bytes, ` +
        `expected ${chunksPerShard * 16} (${chunksPerShard} × 16)`,
    );
  }
  const view = new DataView(
    decoded.buffer,
    decoded.byteOffset,
    decoded.byteLength,
  );
  const little = byteOrder !== "big";
  const entries: Array<ShardIndexEntry | null> = new Array(chunksPerShard);
  for (let i = 0; i < chunksPerShard; i++) {
    const offset = view.getBigUint64(i * 16, little);
    const nbytes = view.getBigUint64(i * 16 + 8, little);
    if (offset === EMPTY_MARKER && nbytes === EMPTY_MARKER) {
      entries[i] = null;
    } else {
      entries[i] = { offset: Number(offset), nbytes: Number(nbytes) };
    }
  }
  return entries;
}

/** A byte range plus whatever payload rides along with it. */
export interface RangeItem {
  offset: number;
  length: number;
}

export interface CoalescedSpan<T extends RangeItem> {
  offset: number;
  length: number;
  items: T[];
}

/**
 * Coalesce byte ranges: sort by offset, then merge ranges whose inter-range
 * gap is ≤ `gapThreshold` (exactly-contiguous ranges always merge). One
 * request is issued per resulting span (FR-015).
 */
export function coalesceRanges<T extends RangeItem>(
  items: T[],
  gapThreshold: number,
): Array<CoalescedSpan<T>> {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => a.offset - b.offset);
  const spans: Array<CoalescedSpan<T>> = [];
  let current: CoalescedSpan<T> = {
    offset: sorted[0].offset,
    length: sorted[0].length,
    items: [sorted[0]],
  };
  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i];
    const end = current.offset + current.length;
    const gap = item.offset - end;
    if (gap <= gapThreshold) {
      current.length =
        Math.max(end, item.offset + item.length) - current.offset;
      current.items.push(item);
    } else {
      spans.push(current);
      current = { offset: item.offset, length: item.length, items: [item] };
    }
  }
  spans.push(current);
  return spans;
}

/** Default coalescing gap threshold: ~1 MiB (clarified in the spec). */
export const DEFAULT_SHARD_GAP_BYTES = 1024 * 1024;

/** One inner chunk to read out of a shard. */
export interface InnerChunkRef {
  /** Inner-chunk coordinate in the array's GLOBAL inner-chunk grid. */
  coord: number[];
  /** C-order linear index of this inner chunk within its shard. */
  indexInShard: number;
}

/** All inner chunks a read needs from one shard object. */
export interface ShardReadTask {
  shardKey: string;
  inner: InnerChunkRef[];
}

export interface ShardedReadContext {
  /** Max shards processed in parallel (network-request cap). */
  concurrency: number;
  /** Shared byte budget (FR-018 — same limiter as non-sharded reads). */
  limiter: ByteLimiter;
  /** Estimated peak bytes one decoded inner chunk holds in flight. */
  peakPerInnerChunk: number;
  /** Optional decoded inner-chunk cache (keys: `${shardKey}#${index}`). */
  memoryCache?: MemoryCache | null;
  observability?: ObservabilityHooks;
  /** Throw MissingChunkError when a shard object is absent from the store. */
  strict?: boolean;
  decodePool?: DecodePool | null;
  /** Inner-chunk decode context (INNER chunk shape + dtype). */
  decodeContext: ChunkDecodeContext;
  /** Coalescing gap threshold in bytes. Default ~1 MiB. */
  gapBytes?: number;
}

/** Memory-cache key for a decoded inner chunk (cannot collide with store keys). */
function innerCacheKey(shardKey: string, indexInShard: number): string {
  return `${shardKey}#${indexInShard}`;
}

/**
 * Read the requested inner chunks of each shard, preferring byte-range reads:
 *
 * 1. Read the shard index (ranged when possible: `getRange` + a known index
 *    region — start-located, or end-located with `head` providing the size).
 * 2. Drop empty-marked inner chunks (the caller's pre-filled output already
 *    holds the fill value — an explicit empty chunk is NOT a missing chunk,
 *    so neither `strict` nor `onMissingChunk` fires for it).
 * 3. Fetch touched inner chunks by coalesced byte ranges (FR-013, FR-015),
 *    or slice everything from one whole-shard fetch when ranged reads are
 *    unavailable (FR-014).
 * 4. Decode each inner chunk through the inner `CodecPipeline` and stream it
 *    to `onChunk` (same delivery contract as `loadChunks`).
 */
export async function loadShardedChunks(
  store: Store,
  sharding: ShardingInfo,
  tasks: ShardReadTask[],
  ctx: ShardedReadContext,
  onChunk: (chunk: LoadedChunk) => void,
): Promise<void> {
  const { limiter, memoryCache } = ctx;
  const hooks = ctx.observability;
  const strict = ctx.strict === true;
  const decodePool = ctx.decodePool ?? null;
  const offload = decodePool ? { pool: decodePool } : undefined;
  const gapBytes = ctx.gapBytes ?? DEFAULT_SHARD_GAP_BYTES;
  const getRange = store.getRange?.bind(store);

  let failed = false;
  let firstError: unknown;

  function handleMissingShard(shardKey: string): void {
    if (hooks?.onMissingChunk) {
      safeInvoke(hooks.onMissingChunk, { key: shardKey });
    }
    if (strict) {
      throw new MissingChunkError(shardKey);
    }
  }

  async function decodeAndDeliver(
    ref: InnerChunkRef,
    rawInner: Uint8Array,
    shardKey: string,
  ): Promise<void> {
    let decoded: Uint8Array;
    if (hooks?.onChunkDecoded) {
      const start = performance.now();
      decoded = await sharding.innerPipeline.decode(
        rawInner,
        ctx.decodeContext,
        offload,
      );
      safeInvoke(hooks.onChunkDecoded, {
        bytes: decoded.byteLength,
        codec: sharding.innerPipeline.compressorId,
        decodeMs: performance.now() - start,
      });
    } else {
      decoded = await sharding.innerPipeline.decode(
        rawInner,
        ctx.decodeContext,
        offload,
      );
    }
    if (failed) return;
    if (memoryCache) {
      memoryCache.set(innerCacheKey(shardKey, ref.indexInShard), decoded);
    }
    onChunk({ chunkCoord: ref.coord, data: decoded });
  }

  /** Read the shard index by range; null ⇒ caller should fall back / miss. */
  async function readIndexRanged(
    shardKey: string,
  ): Promise<Uint8Array | null | "shard-missing"> {
    if (!getRange) return null;
    if (sharding.indexLocation === "start") {
      const raw = await getRange(shardKey, 0, sharding.indexSizeBytes);
      return raw === null ? "shard-missing" : raw;
    }
    // End-located index: the byte offset needs the object size.
    if (!store.head) return null;
    const head = await store.head(shardKey);
    if (head === null) return "shard-missing";
    if (head.size === null) return null;
    const raw = await getRange(
      shardKey,
      head.size - sharding.indexSizeBytes,
      sharding.indexSizeBytes,
    );
    return raw === null ? "shard-missing" : raw;
  }

  async function processShard(task: ShardReadTask): Promise<void> {
    // Serve cached inner chunks first; only misses touch the store.
    let pending = task.inner;
    if (memoryCache) {
      pending = [];
      for (const ref of task.inner) {
        const cached = memoryCache.get(
          innerCacheKey(task.shardKey, ref.indexInShard),
        );
        if (cached !== null) {
          if (hooks?.onCacheHit) {
            safeInvoke(hooks.onCacheHit, { tier: "memory", key: task.shardKey });
          }
          onChunk({ chunkCoord: ref.coord, data: cached });
        } else {
          if (hooks?.onCacheMiss) {
            safeInvoke(hooks.onCacheMiss, {
              tier: "memory",
              key: task.shardKey,
            });
          }
          pending.push(ref);
        }
      }
      if (pending.length === 0) return;
    }

    // Coarse per-shard byte reservation: the requested inner chunks' decoded
    // estimate (the limiter clamps oversized costs to its capacity).
    const cost = pending.length * ctx.peakPerInnerChunk;
    await limiter.acquire(cost);
    try {
      if (failed) return;

      // 1. Obtain the shard index (ranged if possible), or the whole shard.
      let shardBytes: Uint8Array | null = null;
      let indexRaw: Uint8Array | null = null;

      const ranged = await readIndexRanged(task.shardKey);
      if (ranged === "shard-missing") {
        handleMissingShard(task.shardKey);
        return;
      }
      if (ranged !== null) {
        indexRaw = ranged;
      } else {
        shardBytes = await store.get(task.shardKey);
        if (shardBytes === null) {
          handleMissingShard(task.shardKey);
          return;
        }
        if (shardBytes.byteLength < sharding.indexSizeBytes) {
          throw new MetadataError(
            `Malformed shard "${task.shardKey}": ${shardBytes.byteLength} ` +
              `bytes is smaller than its ${sharding.indexSizeBytes}-byte index`,
          );
        }
        indexRaw =
          sharding.indexLocation === "start"
            ? shardBytes.subarray(0, sharding.indexSizeBytes)
            : shardBytes.subarray(
                shardBytes.byteLength - sharding.indexSizeBytes,
              );
      }
      if (failed) return;

      const index = await decodeShardIndex(
        indexRaw,
        sharding.chunksPerShard,
        sharding.indexPipeline,
        sharding.indexByteOrder,
      );

      // 2. Resolve entries; empty markers ⇒ fill (no read, no delivery).
      const toFetch: Array<InnerChunkRef & RangeItem> = [];
      for (const ref of pending) {
        const entry = index[ref.indexInShard];
        if (entry === null) continue;
        if (entry === undefined) {
          throw new MetadataError(
            `Malformed shard index in "${task.shardKey}": no entry for ` +
              `inner chunk ${ref.indexInShard}`,
          );
        }
        toFetch.push({ ...ref, offset: entry.offset, length: entry.nbytes });
      }
      if (toFetch.length === 0) return;

      // 3 + 4. Fetch (whole shard slice, or coalesced ranges) and decode.
      if (shardBytes !== null) {
        for (const item of toFetch) {
          if (failed) return;
          const raw = shardBytes.subarray(
            item.offset,
            item.offset + item.length,
          );
          if (raw.byteLength !== item.length) {
            throw new CodecError(
              `Malformed shard "${task.shardKey}": inner chunk ` +
                `${item.indexInShard} extends past the shard object`,
            );
          }
          await decodeAndDeliver(item, raw, task.shardKey);
        }
        return;
      }

      // Reaching here means the index came from a ranged read, so getRange
      // exists; the guard keeps the type-narrowing explicit.
      if (!getRange) {
        throw new CodecError(
          "sharding reader: ranged index read without getRange (unreachable)",
        );
      }
      const spans = coalesceRanges(toFetch, gapBytes);
      for (const span of spans) {
        if (failed) return;
        const buf = await getRange(task.shardKey, span.offset, span.length);
        if (buf === null) {
          // Shard vanished between index read and data read.
          handleMissingShard(task.shardKey);
          return;
        }
        for (const item of span.items) {
          if (failed) return;
          const raw = buf.subarray(
            item.offset - span.offset,
            item.offset - span.offset + item.length,
          );
          await decodeAndDeliver(item, raw, task.shardKey);
        }
      }
    } finally {
      limiter.release(cost);
    }
  }

  // Same bounded-concurrency scheduler as loadChunks: first failure stops
  // new shards from launching; survivors drain before the error surfaces.
  const inFlight = new Set<Promise<void>>();
  let i = 0;
  while (i < tasks.length && !failed) {
    while (inFlight.size < ctx.concurrency && i < tasks.length && !failed) {
      const task = tasks[i++];
      const p = processShard(task).then(
        () => {
          inFlight.delete(p);
        },
        (err: unknown) => {
          inFlight.delete(p);
          if (!failed) {
            failed = true;
            firstError = err;
          }
        },
      );
      inFlight.add(p);
    }
    if (inFlight.size > 0) {
      await Promise.race(inFlight);
    }
  }
  await Promise.all(inFlight);
  if (failed) {
    throw firstError;
  }
}
