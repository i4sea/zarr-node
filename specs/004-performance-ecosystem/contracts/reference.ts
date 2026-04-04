import type { Store } from "../../../src/store/store.js";

/**
 * Kerchunk v1 reference specification format.
 */
export interface ReferenceSpec {
  version: 1;
  refs: Record<string, string | [string] | [string, number, number]>;
}

/**
 * Options for creating a ReferenceStore.
 */
export interface ReferenceStoreOptions {
  /** Parsed reference spec, or path/URL to a JSON reference file. */
  spec: ReferenceSpec | string;
}

/**
 * Store that resolves keys via a kerchunk-style JSON manifest.
 * Maps virtual Zarr chunk keys to byte ranges in target files.
 */
export interface ReferenceStore extends Store {
  /** Number of references in the manifest. */
  readonly refCount: number;
}
