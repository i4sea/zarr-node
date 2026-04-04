import type { Store } from "./store.js";

/**
 * Slice specification for partial array reads.
 * Each element represents one dimension:
 * - number: single index (reduces dimension)
 * - [start, stop]: range (inclusive start, exclusive stop)
 * - null: entire dimension
 */
export type Slice = (number | [number, number] | null)[];

/**
 * Read options for array data access.
 */
export interface ReadOptions {
  /** Maximum concurrent chunk fetches. Default: 10. */
  concurrency?: number;
}

/**
 * ZarrArray — opened Zarr v2 array with metadata and data access.
 *
 * Constitution Principle II: TypeScript-First.
 * Dtype-parameterized — the returned TypedArray subtype is inferred
 * from the array's dtype metadata.
 */
export interface ZarrArray {
  /** Array dimensions (e.g., [100, 200, 50]). */
  readonly shape: readonly number[];
  /** Chunk dimensions (e.g., [10, 20, 10]). */
  readonly chunks: readonly number[];
  /** NumPy dtype string (e.g., "<f4"). */
  readonly dtype: string;
  /** Memory layout order. */
  readonly order: "C" | "F";
  /** Fill value for missing chunks. */
  readonly fillValue: number | null;
  /** User-defined attributes. */
  readonly attrs: Readonly<Record<string, unknown>>;

  /**
   * Read array data, optionally sliced.
   * @param selection - Per-dimension slice spec. Omit for full array.
   * @param options - Read options (concurrency, etc.).
   * @returns Typed array matching the array's dtype.
   */
  get(selection?: Slice, options?: ReadOptions): Promise<TypedArray>;
}

/**
 * ZarrGroup — opened Zarr v2 group with hierarchy traversal.
 */
export interface ZarrGroup {
  /** User-defined attributes. */
  readonly attrs: Readonly<Record<string, unknown>>;

  /** Open a child array by name. */
  getArray(name: string): Promise<ZarrArray>;

  /** Open a child group by name. */
  getGroup(name: string): Promise<ZarrGroup>;

  /** Iterate all child arrays as [name, array] pairs. */
  arrays(): AsyncIterable<[string, ZarrArray]>;

  /** Iterate all child groups as [name, group] pairs. */
  groups(): AsyncIterable<[string, ZarrGroup]>;

  /** Check if a child (array or group) exists. */
  contains(name: string): Promise<boolean>;
}

/**
 * Open a Zarr v2 store and return the root node (array or group).
 *
 * @param store - Storage backend to read from.
 * @param path - Optional sub-path within the store. Default: root "/".
 * @returns ZarrArray if the path is an array, ZarrGroup if it's a group.
 */
export declare function open(
  store: Store,
  path?: string,
): Promise<ZarrArray | ZarrGroup>;

/**
 * Convenience: open an array directly. Throws if path is a group.
 */
export declare function openArray(
  store: Store,
  path?: string,
): Promise<ZarrArray>;

/**
 * Convenience: open a group directly. Throws if path is an array.
 */
export declare function openGroup(
  store: Store,
  path?: string,
): Promise<ZarrGroup>;

/**
 * Union of all TypedArray types supported by the library.
 */
export type TypedArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;
