# Quickstart: Performance & Ecosystem Improvements

## 1. Blosc works out of the box (zero config)

```typescript
import { S3Store, openArray } from "zarr-node";

// No codec registration needed — Blosc is built-in
const store = new S3Store({ bucket: "data", prefix: "wrf.zarr" });
const arr = await openArray(store, "wind_speed_at_10m_agl");
const data = await arr.get([0, null, null]); // Just works with Blosc
```

## 2. In-memory LRU cache for repeated reads

```typescript
import { MemoryCache } from "zarr-node";

const cache = new MemoryCache({ maxBytes: 100 * 1024 * 1024 }); // 100MB

// Pass to read options
const data1 = await arr.get([0, null, null], { memoryCache: cache });
const data2 = await arr.get([0, null, null], { memoryCache: cache });
// data2 served from memory — no disk I/O, no decompression
```

## 3. Disk cache with size limit

```typescript
import { CachedStore } from "zarr-node";

const store = new CachedStore(s3, {
  cacheDir: "/tmp/zarr-cache",
  maxSizeBytes: 1024 * 1024 * 1024, // 1GB limit
  ttl: 3600,
});
// Cache stays under 1GB — oldest entries evicted automatically
```

## 4. Read multiple arrays at once

```typescript
const root = await openGroup(store);

const results = await root.readMultiple(
  ["wind_speed_at_10m_agl", "air_temperature_at_2m_agl", "relative_humidity_at_2m_agl"],
  [0, [380, 381], [301, 302]], // same selection for all
);

console.log(results.get("wind_speed_at_10m_agl"));   // Float32Array
console.log(results.get("air_temperature_at_2m_agl")); // Float32Array
```

## 5. Byte-range requests (uncompressed data)

```typescript
// Automatic for uncompressed arrays — no code changes needed.
// The library uses Range headers when store supports getRange()
// and the array has compressor: null.
```

## 6. Reference filesystem (kerchunk)

```typescript
import { ReferenceStore, openGroup } from "zarr-node";

// Open an HDF5/NetCDF file through a kerchunk reference manifest
const store = new ReferenceStore({
  spec: "s3://bucket/references/wrf-refs.json",
});

const root = await openGroup(store);
const wind = await root.getArray("wind_speed_at_10m_agl");
const data = await wind.get([0, null, null]);
// Data fetched directly from the HDF5 file via byte-range requests
```

## 7. Dataset with label-based selection

```typescript
import { openDataset } from "zarr-node";

const ds = await openDataset(store);

// Select by dimension names and coordinate values
const point = await ds.sel(
  { time: 1757959200, lat: -25.5, lon: -44.5 },
  ["wind_speed_at_10m_agl", "air_temperature_at_2m_agl"],
);

console.log(point.get("wind_speed_at_10m_agl"));   // Float32Array [16.3]
console.log(point.get("air_temperature_at_2m_agl")); // Float32Array [21.4]
```
