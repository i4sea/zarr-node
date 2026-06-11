import type { Store } from "./store.js";

/**
 * Derive a deterministic identity string for a store, or null when none can
 * be derived (FR-008a). Detection is duck-typed against the real store
 * fields: S3Store exposes `bucket`/`prefix` (and optionally `endpoint`),
 * HTTPStore exposes `baseUrl`, and wrapper stores (CachedStore) expose the
 * wrapped store as `inner`. Filesystem, in-memory, and custom stores return
 * null — callers that need an identity (shared metadata cache) must receive
 * an explicit storeId.
 */
export function deriveStoreId(store: Store, depth = 0): string | null {
  const s = store as unknown as Record<string, unknown>;
  if (typeof s.bucket === "string") {
    // S3Store-like. AWS bucket names are globally unique, but S3-compatible
    // endpoints (MinIO, region replicas) can reuse the same bucket/prefix —
    // include the endpoint so two environments sharing one cache never
    // collide on each other's metadata.
    const prefix = typeof s.prefix === "string" ? s.prefix : "";
    const endpoint =
      typeof s.endpoint === "string" ? `?endpoint=${s.endpoint}` : "";
    return `s3://${s.bucket}/${prefix}${endpoint}`;
  }
  if (typeof s.baseUrl === "string") {
    // HTTPStore-like
    return s.baseUrl;
  }
  // Wrapper-store-like (e.g. CachedStore): derive from the wrapped store so
  // the documented disk-cache + shared-metadata-cache combination works
  // without an explicit storeId. Depth-capped against cyclic wrappers.
  if (depth < 4 && s.inner !== null && typeof s.inner === "object") {
    return deriveStoreId(s.inner as Store, depth + 1);
  }
  return null;
}
