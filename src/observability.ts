/**
 * Observability hooks (FR-012–FR-018).
 *
 * Hooks are registered per instance via option bags (HTTPStoreOptions,
 * S3StoreOptions, CacheOptions, OpenOptions, ReadOptions) — no global
 * registry. The same hooks object may be passed to multiple layers; each
 * layer fires only the events it owns.
 */

/** Cache layer that produced a hit/miss event. */
export type CacheTier = "memory" | "disk" | "shared";

export interface ObservabilityHooks {
  onCacheHit?(e: { tier: CacheTier; key: string }): void;
  onCacheMiss?(e: { tier: CacheTier; key: string }): void;
  onStoreFetch?(e: { key: string; bytes: number; latencyMs: number }): void;
  onRetry?(e: { attempt: number; status?: number; error?: string }): void;
  onChunkDecoded?(e: {
    bytes: number;
    codec: string | null;
    decodeMs: number;
  }): void;
  onInFlightBytes?(current: number): void;
  onMissingChunk?(e: { key: string }): void;
}

/**
 * Invoke a hook handler, swallowing anything it throws so a faulty handler
 * can never abort or corrupt a read.
 *
 * Throw-isolation only — it is NOT the dispatch guard. Every emission site
 * must check hook existence before constructing the payload, so that reads
 * with no hooks registered pay zero allocation/dispatch cost (SC-004):
 *
 * ```ts
 * if (hooks?.onChunkDecoded) {
 *   safeInvoke(hooks.onChunkDecoded, { bytes, codec, decodeMs });
 * }
 * ```
 */
export function safeInvoke<T>(fn: (arg: T) => void, arg: T): void {
  try {
    fn(arg);
  } catch {
    // Hook errors are intentionally swallowed (observability must never
    // affect read correctness).
  }
}
