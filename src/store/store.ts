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
  timeout?: number;
  headers?: Record<string, string>;
  /** Per-instance observability hooks (`onStoreFetch`). */
  observability?: ObservabilityHooks;
}

export interface S3StoreOptions {
  bucket: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  /** Per-instance observability hooks (`onStoreFetch`). */
  observability?: ObservabilityHooks;
}
