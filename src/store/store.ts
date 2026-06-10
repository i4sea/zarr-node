import type { ObservabilityHooks } from "../observability.js";

export interface Store {
  get(key: string): Promise<Uint8Array | null>;
  has(key: string): Promise<boolean>;
  list(prefix: string): AsyncIterable<string>;
  /** Fetch a byte range from a key. Optional — not all stores support this. */
  getRange?(
    key: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array | null>;
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
  /** Per-instance observability hooks (`onStoreFetch`, `onRetry`). */
  observability?: ObservabilityHooks;
}
