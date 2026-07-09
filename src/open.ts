import type { Store } from "./store/store.js";
import { ZarrArray } from "./array.js";
import {
  ZarrGroup,
  materializeArrayNode,
  materializeGroupMeta,
} from "./group.js";
import type { ConsolidatedMetadata } from "./metadata/consolidated.js";
import { parseConsolidatedMetadata } from "./metadata/consolidated.js";
import { detectNode } from "./metadata/layout.js";
import type { DetectedNode, MetaReader } from "./metadata/layout.js";
import { MetadataError, StoreError } from "./errors.js";
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
  /**
   * TTL in ms applied to metadata cache writes. Omit ⇒ no expiry. Use with a
   * content-versioned `storeId` so obsolete versions' keys expire from a shared
   * cache instead of accumulating forever.
   */
  metadataCacheTtlMs?: number;
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
    ttlMs: options.metadataCacheTtlMs,
  };
}

/** Bind the store + cache context into the layout's metadata reader. */
function metaReader(store: Store, ctx?: MetadataCacheContext): MetaReader {
  return (key: string) => readMetadataThrough(store, key, ctx);
}

/**
 * Open a Zarr store path and return the appropriate object — a `ZarrArray`
 * for array nodes, a `ZarrGroup` for group nodes. The format (v2 `.zarray`/
 * `.zgroup` vs v3 `zarr.json`) is detected automatically (FR-001); no version
 * argument exists.
 */
export async function open(
  store: Store,
  path?: string,
  options?: OpenOptions,
): Promise<ZarrArray | ZarrGroup> {
  const ctx = resolveMetaContext(store, options);
  const basePath = normalizePath(path ?? "");
  const read = metaReader(store, ctx);
  const node = await detectNode(read, basePath);

  if (node.nodeType === "array") {
    return materializeArrayNode(store, node, basePath, read);
  }
  return openGroupFromNode(store, node, basePath, read, ctx);
}

/**
 * Open a group directly. Throws if the path is not a group.
 */
export async function openGroup(
  store: Store,
  path?: string,
  options?: OpenOptions,
): Promise<ZarrGroup> {
  const ctx = resolveMetaContext(store, options);
  const basePath = normalizePath(path ?? "");
  const read = metaReader(store, ctx);
  let node: DetectedNode;
  try {
    node = await detectNode(read, basePath);
  } catch (err) {
    if (err instanceof MetadataError) {
      throw new MetadataError(
        `No group metadata found at path "${basePath || "/"}"`,
      );
    }
    throw err;
  }
  if (node.nodeType !== "group") {
    throw new MetadataError(
      `Node at path "${basePath || "/"}" is an array, not a group`,
    );
  }
  return openGroupFromNode(store, node, basePath, read, ctx);
}

/**
 * Open an array directly. Throws if the path is not an array.
 */
export async function openArray(
  store: Store,
  path?: string,
  options?: OpenOptions,
): Promise<ZarrArray> {
  const ctx = resolveMetaContext(store, options);
  const basePath = normalizePath(path ?? "");
  const read = metaReader(store, ctx);
  let node: DetectedNode;
  try {
    node = await detectNode(read, basePath);
  } catch (err) {
    if (err instanceof MetadataError) {
      throw new MetadataError(
        `No array metadata found at path "${basePath || "/"}"`,
      );
    }
    throw err;
  }
  if (node.nodeType !== "array") {
    throw new MetadataError(
      `Node at path "${basePath || "/"}" is a group, not an array`,
    );
  }
  return materializeArrayNode(store, node, basePath, read);
}

async function openGroupFromNode(
  store: Store,
  node: DetectedNode,
  basePath: string,
  read: MetaReader,
  ctx?: MetadataCacheContext,
): Promise<ZarrGroup> {
  // Load consolidated metadata if available (FR-001, FR-007) — the group's
  // own attrs are then served from it instead of a store round-trip.
  const consolidated = await loadConsolidatedMetadata(store, basePath, ctx);
  const readMeta: MetaReader = consolidated
    ? async (key) => consolidated.get(key) ?? read(key)
    : read;

  const meta = await materializeGroupMeta(node, basePath, readMeta);

  return new ZarrGroup(store, meta, basePath, consolidated, ctx);
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
