import type { Store } from "./store/store.js";
import { ZarrArray } from "./array.js";
import { ZarrGroup } from "./group.js";
import type { Zattrs } from "./metadata/types.js";
import { parseZarrayMeta, parseZgroupMeta, parseZattrs } from "./metadata/v2.js";
import { MetadataError } from "./errors.js";

// Re-export public API
export { ZarrArray } from "./array.js";
export { ZarrGroup } from "./group.js";
export type { ReadOptions, Slice } from "./array.js";
export type { TypedArray, TypedArrayConstructor } from "./dtype.js";
export type { Store, FileSystemStoreOptions, HTTPStoreOptions, S3StoreOptions } from "./store/store.js";
export { FileSystemStore } from "./store/filesystem.js";
export { HTTPStore } from "./store/http.js";
export { S3Store } from "./store/s3.js";
export type { Codec, CodecFactory, CodecRegistry } from "./codec/codec.js";
export { codecRegistry } from "./codec/codec.js";
export type { CompressorConfig, FilterConfig, ZarrayMeta, ZgroupMeta, Zattrs } from "./metadata/types.js";
export {
  ZarrError,
  MetadataError,
  StoreError,
  CodecError,
  SliceError,
  UnsupportedOperationError,
} from "./errors.js";

/**
 * Open a Zarr v2 store path and return the appropriate object.
 * Returns ZarrArray if the path contains .zarray, ZarrGroup if .zgroup.
 */
export async function open(
  store: Store,
  path?: string,
): Promise<ZarrArray | ZarrGroup> {
  const basePath = normalizePath(path ?? "");

  // Check for .zarray
  const zarrayKey = basePath ? `${basePath}/.zarray` : ".zarray";
  const zarrayRaw = await store.get(zarrayKey);

  if (zarrayRaw) {
    return openArrayFromMeta(store, basePath, zarrayRaw);
  }

  // Check for .zgroup
  const zgroupKey = basePath ? `${basePath}/.zgroup` : ".zgroup";
  const zgroupRaw = await store.get(zgroupKey);

  if (zgroupRaw) {
    return openGroupFromMeta(store, basePath, zgroupRaw);
  }

  throw new MetadataError(
    `No .zarray or .zgroup metadata found at path "${basePath || "/"}"`,
  );
}

/**
 * Open a Zarr v2 group directly. Throws if path is not a group.
 */
export async function openGroup(
  store: Store,
  path?: string,
): Promise<ZarrGroup> {
  const basePath = normalizePath(path ?? "");
  const zgroupKey = basePath ? `${basePath}/.zgroup` : ".zgroup";
  const zgroupRaw = await store.get(zgroupKey);

  if (!zgroupRaw) {
    throw new MetadataError(
      `No .zgroup metadata found at path "${basePath || "/"}"`,
    );
  }

  return openGroupFromMeta(store, basePath, zgroupRaw);
}

/**
 * Open a Zarr v2 array directly. Throws if path is not an array.
 */
export async function openArray(
  store: Store,
  path?: string,
): Promise<ZarrArray> {
  const basePath = normalizePath(path ?? "");
  const zarrayKey = basePath ? `${basePath}/.zarray` : ".zarray";
  const zarrayRaw = await store.get(zarrayKey);

  if (!zarrayRaw) {
    throw new MetadataError(
      `No .zarray metadata found at path "${basePath || "/"}"`,
    );
  }

  return openArrayFromMeta(store, basePath, zarrayRaw);
}

async function openArrayFromMeta(
  store: Store,
  basePath: string,
  zarrayRaw: Uint8Array,
): Promise<ZarrArray> {
  const meta = parseZarrayMeta(
    new TextDecoder().decode(zarrayRaw),
  );

  // Load .zattrs if present
  const zattrsKey = basePath ? `${basePath}/.zattrs` : ".zattrs";
  const zattrsRaw = await store.get(zattrsKey);
  const attrs: Zattrs = zattrsRaw
    ? parseZattrs(new TextDecoder().decode(zattrsRaw))
    : {};

  return new ZarrArray(store, meta, attrs, basePath);
}

async function openGroupFromMeta(
  store: Store,
  basePath: string,
  zgroupRaw: Uint8Array,
): Promise<ZarrGroup> {
  parseZgroupMeta(new TextDecoder().decode(zgroupRaw));

  const zattrsKey = basePath ? `${basePath}/.zattrs` : ".zattrs";
  const zattrsRaw = await store.get(zattrsKey);
  const attrs: Zattrs = zattrsRaw
    ? parseZattrs(new TextDecoder().decode(zattrsRaw))
    : {};

  return new ZarrGroup(store, attrs, basePath);
}

function normalizePath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}
