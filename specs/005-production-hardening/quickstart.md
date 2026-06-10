# Quickstart: Production Hardening features

How a consumer (`nautilus-api`) uses the new capabilities. All features are opt-in; existing code keeps working unchanged.

## 1. Bounded disk cache (always set a max)

```ts
import { CachedStore, S3Store } from "@i4sea/zarr-node";

const store = new CachedStore(new S3Store({ bucket, prefix, region }), {
  cacheDir: "/tmp/zarr-cache",
  maxSizeBytes: 2 * 1024 * 1024 * 1024, // 2 GiB — REQUIRED in production
});
// Omitting maxSizeBytes logs a warning at construction: the cache would grow unbounded.
```

## 2. Shared metadata cache (Redis) across pods

```ts
import { open } from "@i4sea/zarr-node";
import { RedisCache } from "@i4sea/zarr-node/redis"; // ioredis must be installed
import Redis from "ioredis";

const metadataCache = new RedisCache(new Redis(process.env.REDIS_URL));

// storeId derived automatically for S3/HTTP; pass explicitly for custom stores.
const group = await open(store, "", { metadataCache });
// First pod to open a path fetches .zmetadata from S3 and caches it (no TTL —
// datasets are immutable per path). All later opens, on any pod, hit Redis.
```

In-memory equivalent (single process):

```ts
import { InMemoryCache } from "@i4sea/zarr-node";
const metadataCache = new InMemoryCache({ maxBytes: 64 * 1024 * 1024 });
```

If `metadataCache` is supplied but the store has no deterministic identity, pass `storeId`:

```ts
await open(customStore, "", { metadataCache, storeId: "my-dataset-v1" });
// Without a derivable id and without storeId → throws fast (prevents per-pod key divergence).
```

## 3. Observability hooks

```ts
const observability = {
  onCacheHit: ({ tier, key }) => metrics.inc(`cache.hit.${tier}`),
  onCacheMiss: ({ tier }) => metrics.inc(`cache.miss.${tier}`),
  onStoreFetch: ({ bytes, latencyMs }) => metrics.observe("s3.fetch_ms", latencyMs),
  onRetry: ({ attempt, status }) => logger.warn(`retry ${attempt} status=${status}`),
  onChunkDecoded: ({ decodeMs, codec }) => metrics.observe(`decode.${codec}`, decodeMs),
  onInFlightBytes: (n) => metrics.gauge("inflight_bytes", n),
  onMissingChunk: ({ key }) => logger.error(`missing chunk ${key}`),
};

// Same object passed where each layer fires its events:
const store = new S3Store({ bucket, region, observability });
const group = await open(store, "", { metadataCache, observability });
const data = await array.get(selection, { observability });
```

A throwing handler never breaks a read. With no hooks passed, there is zero overhead.

## 4. Network resilience config

```ts
const store = new S3Store({
  bucket, region,
  maxRetries: 5,   // default 3
  timeout: 15000,  // explicit per-op timeout (ms); default 30000
});
// Retries cover 429/500/502/503/504 + ECONNRESET/ETIMEDOUT/EAI_AGAIN, with full-jitter backoff.
```

## 5. Strict missing-chunk mode

```ts
// Default: missing chunk → zeros + onMissingChunk fired.
// Strict: missing chunk → throws MissingChunkError (no fabricated zeros).
import { MissingChunkError } from "@i4sea/zarr-node";

try {
  const data = await array.get(selection, { strict: true });
} catch (e) {
  if (e instanceof MissingChunkError) { /* surface data gap */ }
}
```

## 6. Sizing in-flight memory (docs, FR-028)

Peak bytes a single in-flight chunk holds:

```
peakPerChunk = chunkBytes × (decodeFactor + byteSwapFactor)
  decodeFactor   = 2 if compressed (input + output during decode), else 1
  byteSwapFactor = 1 if big-endian dtype (extra copy before in-place swap), else 0
```

Derive a safe `maxInFlightBytes` from a pod's RAM limit (e.g. leave headroom for the heap/runtime):

```
maxInFlightBytes ≈ (podRamLimit − baselineHeap) × safetyFraction
```

`maxInFlightBytes` caps the combined decoded footprint regardless of `concurrency` or chunk size.

## Validation checklist (maps to acceptance scenarios)

- [ ] Construct `CachedStore` without `maxSizeBytes` → warning logged once per construction (US1).
- [ ] Open same dataset twice with `metadataCache` → second open hits cache, no second store fetch (US2).
- [ ] Library loads and reads with `ioredis` absent and no cache supplied (US2).
- [ ] All seven hooks fire with documented payloads; throwing handler does not break read (US3).
- [ ] Injected 500/502/504 + ECONNRESET/ETIMEDOUT/EAI_AGAIN recover; backoff jittered; S3 timeout aborts (US4).
- [ ] Missing chunk → notification + zeros by default; `strict` → `MissingChunkError` (US5).
