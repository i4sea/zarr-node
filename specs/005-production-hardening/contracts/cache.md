# Contract: `Cache` interface + adapters

Public API contract for the pluggable cache (FR-005–FR-011). Exported from package root; `RedisCache` from the `./redis` subpath.

## Interface (root export)

```ts
export interface Cache {
  /** Return the cached bytes for `key`, or null on miss. */
  get(key: string): Promise<Uint8Array | null>;
  /** Store bytes under `key`. `ttlMs` omitted ⇒ no expiry. */
  set(key: string, value: Uint8Array, ttlMs?: number): Promise<void>;
  /** Optional existence check. */
  has?(key: string): Promise<boolean>;
}

export class InMemoryCache implements Cache {
  constructor(options: { maxBytes: number });
  get(key: string): Promise<Uint8Array | null>;
  set(key: string, value: Uint8Array, ttlMs?: number): Promise<void>;
  has(key: string): Promise<boolean>;
}
```

## Subpath export `@i4sea/zarr-node/redis`

```ts
import type Redis from "ioredis"; // optional peer dependency, types only

export class RedisCache implements Cache {
  /** Accept a pre-configured ioredis client (preferred) … */
  constructor(client: Redis);
  get(key: string): Promise<Uint8Array | null>;
  set(key: string, value: Uint8Array, ttlMs?: number): Promise<void>;
  has(key: string): Promise<boolean>;
}
```

- `ioredis` is loaded via dynamic `import("ioredis")` only when this module is used (FR-009/FR-010).
- A clear error is thrown if `ioredis` is not installed when `./redis` is imported, mirroring `S3Store`'s SDK guard.

## Behavioral contract (shared `tests/contract/cache.contract.ts`)

Every `Cache` implementation MUST satisfy:

1. `get` on an unset key returns `null`.
2. After `set(k, v)`, `get(k)` returns bytes equal to `v`.
3. `set(k, v, ttlMs)` with a short TTL ⇒ `get(k)` returns `null` after expiry.
4. `has?(k)` (if implemented) is `true` after `set`, `false` for unset keys.
5. Round-tripped bytes are value-equal regardless of backing store (binary-safe).

## Wiring contract (metadata path)

- `open`/`openGroup`/`openArray` accept `OpenOptions { metadataCache?, storeId?, observability? }`.
- Effective cache key = `${storeId}:${metadataKey}` (FR-008).
- Read-through order: `metadataCache.get` → on miss, `store.get` → `metadataCache.set` (no TTL).
- If `metadataCache.get`/`set` throws or the cache is unavailable ⇒ fall back to `store.get`; the read MUST succeed (FR-011).
- If `metadataCache` is provided but no deterministic `storeId` is available (neither passed nor derivable) ⇒ throw before any fetch (FR-008a).
- With no `metadataCache` ⇒ behavior identical to today (FR-010).
