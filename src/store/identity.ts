import type { Store } from "./store.js";

/**
 * Derive a deterministic identity string for a store, or null when none can
 * be derived (FR-008a). Detection is duck-typed against the real store
 * fields: S3Store exposes `bucket`/`prefix`, HTTPStore exposes `baseUrl`.
 * Filesystem, in-memory, and custom stores return null — callers that need
 * an identity (shared metadata cache) must receive an explicit storeId.
 */
export function deriveStoreId(store: Store): string | null {
  const s = store as unknown as Record<string, unknown>;
  if (typeof s.bucket === "string") {
    // S3Store-like
    const prefix = typeof s.prefix === "string" ? s.prefix : "";
    return `s3://${s.bucket}/${prefix}`;
  }
  if (typeof s.baseUrl === "string") {
    // HTTPStore-like
    return s.baseUrl;
  }
  return null;
}
