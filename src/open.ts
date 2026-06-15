import type { Store } from "./store/store.js";
import { ZarrArray } from "./array.js";
import { ZarrGroup } from "./group.js";
import type { Zattrs } from "./metadata/types.js";
import type { ConsolidatedMetadata } from "./metadata/consolidated.js";
import { parseConsolidatedMetadata } from "./metadata/consolidated.js";
import {
  parseZarrayMeta,
  parseZgroupMeta,
  parseZattrs,
} from "./metadata/v2.js";
import { MetadataError, StoreError } from "./errors.js";
import { codecRegistry } from "./codec/codec.js";
import type { Cache } from "./cache/cache.js";
import type { MetadataCacheContext } from "./cache/read-through.js";
import { readMetadataThrough } from "./cache/read-through.js";
import { deriveStoreId } from "./store/identity.js";
import type { ObservabilityHooks } from "./observability.js";

/** Options accepted by open/openGroup/openArray. */
export interface OpenOptions {
  /**
   * Shared cache for metadata reads (FR-005). Keys are scoped as
   * `${storeId}:${metadataKey}`; requires a deterministic store identity —
   * derived automatically for S3/HTTP stores, otherwise pass storeId.
   */
  metadataCache?: Cache;
  /** Explicit store identity overriding the derived one (FR-008). */
  storeId?: string;
  /** Per-instance observability hooks (shared-tier cache hit/miss). */
  observability?: ObservabilityHooks;
}

/**
 * Resolve OpenOptions into a metadata-cache context. Throws before any fetch
 * when a metadataCache is supplied but no deterministic store identity is
 * available (FR-008a).
 */
function resolveMetaContext(
  store: Store,
  options?: OpenOptions,
): MetadataCacheContext | undefined {
  if (!options?.metadataCache) return undefined;
  const storeId = options.storeId ?? deriveStoreId(store);
  if (storeId === null) {
    throw new StoreError(
      "metadataCache requires a deterministic store identity, but none could " +
        "be derived from this store type. Pass an explicit storeId in " +
        'OpenOptions (e.g. open(store, path, { metadataCache, storeId: "my-dataset" })).',
    );
  }
  return {
    cache: options.metadataCache,
    storeId,
    observability: options.observability,
  };
}

/**
 * Open a Zarr v2 store path and return the appropriate object.
 * Returns ZarrArray if the path contains .zarray, ZarrGroup if .zgroup.
 */
export async function open(
  store: Store,
  path?: string,
  options?: OpenOptions,
): Promise<ZarrArray | ZarrGroup> {
  const ctx = resolveMetaContext(store, options);
  const basePath = normalizePath(path ?? "");

  // Check for .zarray
  const zarrayKey = basePath ? `${basePath}/.zarray` : ".zarray";
  const zarrayRaw = await readMetadataThrough(store, zarrayKey, ctx);

  if (zarrayRaw) {
    return openArrayFromMeta(store, basePath, zarrayRaw, ctx);
  }

  // Check for .zgroup
  const zgroupKey = basePath ? `${basePath}/.zgroup` : ".zgroup";
  const zgroupRaw = await readMetadataThrough(store, zgroupKey, ctx);

  if (zgroupRaw) {
    return openGroupFromMeta(store, basePath, zgroupRaw, ctx);
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
  options?: OpenOptions,
): Promise<ZarrGroup> {
  const ctx = resolveMetaContext(store, options);
  const basePath = normalizePath(path ?? "");
  const zgroupKey = basePath ? `${basePath}/.zgroup` : ".zgroup";
  const zgroupRaw = await readMetadataThrough(store, zgroupKey, ctx);

  if (!zgroupRaw) {
    throw new MetadataError(
      `No .zgroup metadata found at path "${basePath || "/"}"`,
    );
  }

  return openGroupFromMeta(store, basePath, zgroupRaw, ctx);
}

/**
 * Open a Zarr v2 array directly. Throws if path is not an array.
 */
export async function openArray(
  store: Store,
  path?: string,
  options?: OpenOptions,
): Promise<ZarrArray> {
  const ctx = resolveMetaContext(store, options);
  const basePath = normalizePath(path ?? "");
  const zarrayKey = basePath ? `${basePath}/.zarray` : ".zarray";
  const zarrayRaw = await readMetadataThrough(store, zarrayKey, ctx);

  if (!zarrayRaw) {
    throw new MetadataError(
      `No .zarray metadata found at path "${basePath || "/"}"`,
    );
  }

  return openArrayFromMeta(store, basePath, zarrayRaw, ctx);
}

async function openArrayFromMeta(
  store: Store,
  basePath: string,
  zarrayRaw: Uint8Array,
  ctx?: MetadataCacheContext,
): Promise<ZarrArray> {
  const meta = parseZarrayMeta(new TextDecoder().decode(zarrayRaw));

  // Load .zattrs if present
  const zattrsKey = basePath ? `${basePath}/.zattrs` : ".zattrs";
  const zattrsRaw = await readMetadataThrough(store, zattrsKey, ctx);
  const attrs: Zattrs = zattrsRaw
    ? parseZattrs(new TextDecoder().decode(zattrsRaw))
    : {};

  const codec = meta.compressor
    ? await codecRegistry.get(meta.compressor)
    : null;

  return new ZarrArray(store, meta, attrs, basePath, codec);
}

async function openGroupFromMeta(
  store: Store,
  basePath: string,
  zgroupRaw: Uint8Array,
  ctx?: MetadataCacheContext,
): Promise<ZarrGroup> {
  parseZgroupMeta(new TextDecoder().decode(zgroupRaw));

  // Load consolidated metadata if available (FR-001, FR-007)
  const consolidated = await loadConsolidatedMetadata(store, basePath, ctx);

  // Load attrs — use consolidated cache if available
  let attrs: Zattrs = {};
  const zattrsKey = basePath ? `${basePath}/.zattrs` : ".zattrs";
  if (consolidated) {
    const cached = consolidated.get(zattrsKey);
    if (cached) {
      attrs = parseZattrs(new TextDecoder().decode(cached));
    }
  } else {
    const zattrsRaw = await readMetadataThrough(store, zattrsKey, ctx);
    attrs = zattrsRaw ? parseZattrs(new TextDecoder().decode(zattrsRaw)) : {};
  }

  return new ZarrGroup(store, attrs, basePath, consolidated, ctx);
}

/**
 * Attempt to load .zmetadata from the store root.
 * Returns null if not found (transparent fallback per FR-004).
 */
async function loadConsolidatedMetadata(
  store: Store,
  basePath: string,
  ctx?: MetadataCacheContext,
): Promise<ConsolidatedMetadata | null> {
  // .zmetadata is always at store root, not at sub-group paths
  if (basePath) return null;

  const raw = await readMetadataThrough(store, ".zmetadata", ctx);
  if (!raw) return null;
  // Malformed .zmetadata will throw MetadataError from parseConsolidatedMetadata
  return parseConsolidatedMetadata(raw);
}

function normalizePath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}
