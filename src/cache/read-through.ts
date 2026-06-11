import type { Store } from "../store/store.js";
import type { ObservabilityHooks } from "../observability.js";
import { safeInvoke } from "../observability.js";
import type { Cache } from "./cache.js";
import { scopeKey } from "./cache.js";

/**
 * Resolved metadata-cache wiring threaded from OpenOptions through the open
 * path and onto ZarrGroup. Only constructed when a metadataCache is supplied
 * and a deterministic storeId is available (FR-008a).
 */
export interface MetadataCacheContext {
  cache: Cache;
  storeId: string;
  observability?: ObservabilityHooks;
}

/**
 * Negative-cache sentinel: marks a key known to be absent from the store, so
 * repeated opens never re-probe missing metadata (e.g. the .zarray check on a
 * group, or an absent .zattrs/.zmetadata). Metadata files are JSON and can
 * never legitimately be empty, so zero length is unambiguous.
 */
const ABSENT = new Uint8Array(0);

/**
 * Shared read-through for metadata keys: cache.get → store.get → cache.set
 * (no TTL). Cache errors fall back to the store — the read must succeed even
 * with an unavailable cache (FR-011). Without a context this is a plain
 * store.get (FR-010).
 */
export async function readMetadataThrough(
  store: Store,
  key: string,
  ctx?: MetadataCacheContext,
): Promise<Uint8Array | null> {
  if (!ctx) return store.get(key);

  const scoped = scopeKey(ctx.storeId, key);
  const hooks = ctx.observability;

  let cached: Uint8Array | null = null;
  try {
    cached = await ctx.cache.get(scoped);
  } catch {
    cached = null; // cache unavailable — fall back to store (FR-011)
  }
  // Loose != also treats undefined as a miss: plain-JS Cache adapters
  // commonly resolve undefined instead of null (e.g. Map-backed get).
  if (cached != null) {
    if (hooks?.onCacheHit) {
      safeInvoke(hooks.onCacheHit, { tier: "shared", key });
    }
    return cached.byteLength === 0 ? null : cached;
  }

  if (hooks?.onCacheMiss) {
    safeInvoke(hooks.onCacheMiss, { tier: "shared", key });
  }
  const data = await store.get(key);
  try {
    await ctx.cache.set(scoped, data ?? ABSENT);
  } catch {
    // cache write failure must not affect the read (FR-011)
  }
  return data;
}
