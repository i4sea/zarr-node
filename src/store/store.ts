import type { ObservabilityHooks } from "../observability.js";

export interface Store {
  /**
   * Fetch a key's bytes. `null` means strictly "key absent" (the reader maps
   * it to fill-value semantics, and to `MissingChunkError` under `strict`);
   * any other failure MUST throw (e.g. `StoreError`), never return `null`.
   */
  get(key: string): Promise<Uint8Array | null>;
  has(key: string): Promise<boolean>;
  list(prefix: string): AsyncIterable<string>;
  /**
   * Fetch a byte range from a key. Optional — not all stores support this.
   * As with `get`, `null` means strictly "key absent"; other failures MUST
   * throw rather than return `null`.
   */
  getRange?(
    key: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array | null>;
  /**
   * Fetch object metadata (ETag / last-modified / size) without the body.
   * Optional — intended as a cheap content-version probe for cache keying: a
   * changed ETag means the object was overwritten in place, so consumers can
   * fold it into a cache key to invalidate every tier on re-ingestion. `null`
   * means the key is absent; other failures MUST throw (e.g. `StoreError`).
   */
  head?(key: string): Promise<StoreHead | null>;
}

/** Object metadata returned by {@link Store.head}. */
export interface StoreHead {
  /** Entity tag as returned by the backend (may be quoted), or null. */
  etag: string | null;
  /** Last-modified time, or null when the backend omits it. */
  lastModified: Date | null;
  /** Object size in bytes, or null when unknown. */
  size: number | null;
}

export interface FileSystemStoreOptions {
  path: string;
}

export interface HTTPStoreOptions {
  url: string;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeout?: number;
  headers?: Record<string, string>;
  /** Max retries after the initial attempt for transient failures. Default 3. */
  maxRetries?: number;
  /** Per-instance observability hooks (`onStoreFetch`, `onRetry`). */
  observability?: ObservabilityHooks;
}

export interface S3StoreOptions {
  bucket: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  /** Max retries after the initial attempt for transient failures. Default 3. */
  maxRetries?: number;
  /** Per-operation timeout in milliseconds (aborts `client.send`). Default 30000. */
  timeout?: number;
  /**
   * Max concurrent TCP connections in the HTTP keep-alive pool. Default 128.
   * Should be >= the `concurrency` used in reads, otherwise parallel chunk
   * fetches queue at the socket pool instead of running concurrently.
   */
  maxSockets?: number;
  /** Reuse TCP connections across requests (keep-alive). Default true. */
  keepAlive?: boolean;
  /** TCP connection-establishment timeout in milliseconds. Default 3000. */
  connectionTimeoutMs?: number;
  /**
   * Escape hatch: a pre-configured request handler instance (e.g. a
   * `NodeHttpHandler`). When provided, `maxSockets`/`keepAlive`/
   * `connectionTimeoutMs` are ignored — you own the handler config.
   */
  requestHandler?: unknown;
  /**
   * Open a TLS connection eagerly on construction (fire-and-forget
   * `prewarm()`), so the first real read doesn't pay the handshake. Default
   * false. Prefer awaiting `prewarm()` explicitly when you can.
   */
  warmOnCreate?: boolean;
  /** Per-instance observability hooks (`onStoreFetch`, `onRetry`). */
  observability?: ObservabilityHooks;
}
