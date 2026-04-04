/**
 * Store interface — abstract read-only key-value access to Zarr data.
 *
 * Constitution Principle I: Read-Only by Design.
 * Only three operations: get, has, list. No write paths.
 */
export interface Store {
  /**
   * Retrieve raw bytes for a key.
   * @returns Uint8Array of data, or null if the key does not exist.
   */
  get(key: string): Promise<Uint8Array | null>;

  /**
   * Check whether a key exists in the store.
   */
  has(key: string): Promise<boolean>;

  /**
   * Enumerate all keys under a given prefix.
   * Yields key strings (not full paths). Lazy iteration for large stores.
   */
  list(prefix: string): AsyncIterable<string>;
}

/**
 * Options for FileSystemStore.
 */
export interface FileSystemStoreOptions {
  /** Absolute path to the root directory of the Zarr store. */
  path: string;
}

/**
 * Options for HTTPStore.
 */
export interface HTTPStoreOptions {
  /** Base URL of the Zarr store (e.g., "https://data.example.com/zarr"). */
  url: string;
  /** Request timeout in milliseconds. Default: 30000. */
  timeout?: number;
  /** Custom headers to include in every request. */
  headers?: Record<string, string>;
}

/**
 * Options for S3Store.
 */
export interface S3StoreOptions {
  /** S3 bucket name. */
  bucket: string;
  /** Key prefix within the bucket (e.g., "datasets/experiment-1/"). */
  prefix?: string;
  /** AWS region. Default: inferred from SDK config. */
  region?: string;
  /** Custom endpoint URL for S3-compatible services (e.g., MinIO). */
  endpoint?: string;
}
