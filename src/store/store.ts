export interface Store {
  get(key: string): Promise<Uint8Array | null>;
  has(key: string): Promise<boolean>;
  list(prefix: string): AsyncIterable<string>;
}

export interface FileSystemStoreOptions {
  path: string;
}

export interface HTTPStoreOptions {
  url: string;
  timeout?: number;
  headers?: Record<string, string>;
}

export interface S3StoreOptions {
  bucket: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
}
