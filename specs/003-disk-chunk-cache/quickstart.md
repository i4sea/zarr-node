# Quickstart: Disk Chunk Cache

## Enable caching for a remote store

```typescript
import { S3Store, CachedStore, openGroup } from "zarr-node";

const s3 = new S3Store({
  bucket: "my-data-bucket",
  prefix: "weather/forecast.zarr",
});

// Wrap with disk cache
const store = new CachedStore(s3, {
  cacheDir: "/tmp/zarr-cache",
});

const root = await openGroup(store);
const temp = await root.getArray("temperature");

// First read: fetches from S3, caches locally
const data1 = await temp.get([0, null, null]);

// Second read: served from disk cache (instant)
const data2 = await temp.get([0, null, null]);
```

## With TTL (auto-expire after 1 hour)

```typescript
const store = new CachedStore(s3, {
  cacheDir: "/tmp/zarr-cache",
  ttl: 3600, // seconds
});
```

## Clear the cache

```typescript
await store.clearCache();
```

## Works with any remote store

```typescript
import { HTTPStore, CachedStore } from "zarr-node";

const http = new HTTPStore({
  url: "https://data.example.com/zarr/dataset",
});

const store = new CachedStore(http, {
  cacheDir: "./cache",
});
```

## No caching (default behavior, unchanged)

```typescript
// No CachedStore wrapper — same behavior as before
const store = new S3Store({ bucket: "data" });
const arr = await openArray(store);
```
