# Quickstart: zarr-node

## Installation

```bash
npm install zarr-node
```

For S3 support, also install the AWS SDK:

```bash
npm install @aws-sdk/client-s3
```

## Read an array from the filesystem

```typescript
import { open, FileSystemStore } from "zarr-node";

const store = new FileSystemStore({ path: "/data/my-dataset.zarr" });
const arr = await open(store);

// arr is a ZarrArray — inspect metadata
console.log(arr.shape);   // [1000, 2000]
console.log(arr.dtype);   // "<f4"
console.log(arr.chunks);  // [100, 200]

// Read all data as Float32Array
const data = await arr.get();
console.log(data.length); // 2000000
```

## Navigate a group hierarchy

```typescript
import { openGroup, FileSystemStore } from "zarr-node";

const store = new FileSystemStore({ path: "/data/climate.zarr" });
const root = await openGroup(store);

// List available arrays
for await (const [name, array] of root.arrays()) {
  console.log(`${name}: shape=${array.shape}, dtype=${array.dtype}`);
}
// Output:
// temperature: shape=[365, 180, 360], dtype=<f4
// pressure: shape=[365, 180, 360], dtype=<f4
// humidity: shape=[365, 180, 360], dtype=<f4

// Read a specific array
const temp = await root.getArray("temperature");
console.log(temp.attrs); // { units: "K", long_name: "Temperature" }
```

## Read a slice (partial data)

```typescript
import { openArray, FileSystemStore } from "zarr-node";

const store = new FileSystemStore({ path: "/data/climate.zarr" });
const temp = await openArray(store, "temperature");

// Read day 0, all latitudes, longitudes 0-10
const slice = await temp.get([0, null, [0, 10]]);
console.log(slice.length); // 1800 (1 * 180 * 10)
```

## Read from HTTP

```typescript
import { open, HTTPStore } from "zarr-node";

const store = new HTTPStore({
  url: "https://data.example.com/zarr/my-dataset",
  timeout: 10000,
  headers: { Authorization: "Bearer my-token" },
});

const arr = await open(store);
const data = await arr.get();
```

## Read from S3

```typescript
import { open, S3Store } from "zarr-node";

const store = new S3Store({
  bucket: "my-data-bucket",
  prefix: "experiments/exp-042/",
  region: "us-east-1",
});

const arr = await open(store);
const data = await arr.get();
```

S3-compatible endpoints (MinIO, LocalStack):

```typescript
const store = new S3Store({
  bucket: "local-data",
  endpoint: "http://localhost:9000",
});
```

## Register a custom codec

```typescript
import { codecRegistry } from "zarr-node";

codecRegistry.register("my-compressor", (config) => ({
  id: "my-compressor",
  async decode(data: Uint8Array): Promise<Uint8Array> {
    // Your decompression logic here
    return decompress(data, config);
  },
}));
```

## Control concurrency

```typescript
// Limit to 5 concurrent chunk fetches (default: 10)
const data = await arr.get(null, { concurrency: 5 });
```
