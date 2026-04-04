# Quickstart: Consolidated Metadata

## No code changes required

Consolidated metadata support is **transparent**. If your Zarr v2 store
contains a `.zmetadata` file, the library uses it automatically.

## Before (slow — many network requests)

```typescript
import { openGroup, S3Store } from "zarr-node";

const store = new S3Store({ bucket: "my-data", prefix: "dataset.zarr" });
const root = await openGroup(store);

// This was slow: ~40 seconds for 19 arrays on S3
for await (const [name, arr] of root.arrays()) {
  console.log(name, arr.shape);
}
```

## After (fast — same code, automatic optimization)

```typescript
// Exact same code — no changes needed
import { openGroup, S3Store } from "zarr-node";

const store = new S3Store({ bucket: "my-data", prefix: "dataset.zarr" });
const root = await openGroup(store);

// Now fast: < 2 seconds (if store has .zmetadata)
for await (const [name, arr] of root.arrays()) {
  console.log(name, arr.shape);
}
```

## How to generate .zmetadata for your store

If your Zarr store doesn't have `.zmetadata`, generate it with Python:

```python
import zarr
store = zarr.open("path/to/store.zarr", mode="r+")
zarr.consolidate_metadata(store.store)
```

Or with xarray (automatic when saving):

```python
import xarray as xr
ds.to_zarr("store.zarr", consolidated=True)
```
