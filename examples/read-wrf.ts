/**
 * Example: Read WRF weather data from S3 using zarr-node.
 *
 * Run with: npx tsx examples/read-wrf.ts
 */
import { S3Store, openGroup, openArray, codecRegistry } from "../src/index.js";
import { Blosc } from "numcodecs";

// Register Blosc codec
codecRegistry.register("blosc", () => ({
  id: "blosc",
  async decode(data: Uint8Array): Promise<Uint8Array> {
    const codec = Blosc.fromConfig({
      id: "blosc",
      cname: "lz4",
      clevel: 5,
      shuffle: 1,
      blocksize: 0,
    });
    return codec.decode(data);
  },
}));

async function main() {
  const store = new S3Store({
    bucket: "teste-zarr",
    prefix: "wrf_sse1_complete.zarr",
    region: "us-east-1",
  });

  // Open root group
  console.log("Opening WRF store...");
  const root = await openGroup(store);
  console.log("Root attrs:", root.attrs);

  // List available variables
  console.log("\nAvailable arrays:");
  for await (const [name, arr] of root.arrays()) {
    console.log(`  ${name}: shape=${JSON.stringify(arr.shape)}, dtype=${arr.dtype}, attrs=${JSON.stringify(arr.attrs)}`);
  }

  // Read wind_speed_at_10m_agl — full first time step
  console.log("\n--- Reading wind_speed_at_10m_agl ---");
  const wind = await root.getArray("wind_speed_at_10m_agl");
  console.log(`Shape: ${JSON.stringify(wind.shape)}`);
  console.log(`Dtype: ${wind.dtype}`);
  console.log(`Chunks: ${JSON.stringify(wind.chunks)}`);
  console.log(`Attrs: ${JSON.stringify(wind.attrs)}`);

  // Read a small slice: first time step, small lat/lon region
  console.log("\nReading slice [0, 0:10, 0:10]...");
  const start = performance.now();
  const slice = await wind.get([0, [0, 10], [0, 10]]);
  const elapsed = performance.now() - start;

  console.log(`Result: ${slice.constructor.name}[${slice.length}]`);
  console.log(`Time: ${elapsed.toFixed(0)}ms`);
  console.log("Values (first 10):", Array.from(slice.slice(0, 10)).map(v => v.toFixed(2)));

  // Read time coordinate
  console.log("\n--- Reading time coordinate ---");
  const time = await root.getArray("time");
  console.log(`Time shape: ${JSON.stringify(time.shape)}, dtype: ${time.dtype}`);
  const timeData = await time.get();
  console.log(`First 5 time values: ${Array.from(timeData.slice(0, 5))}`);

  // Read lat/lon
  console.log("\n--- Reading lat/lon ---");
  const lat = await root.getArray("lat");
  const lon = await root.getArray("lon");
  console.log(`Lat shape: ${JSON.stringify(lat.shape)}, dtype: ${lat.dtype}`);
  console.log(`Lon shape: ${JSON.stringify(lon.shape)}, dtype: ${lon.dtype}`);

  // Read a small corner of lat/lon (2D arrays)
  const latSlice = await lat.get([[0, 3], [0, 3]]);
  const lonSlice = await lon.get([[0, 3], [0, 3]]);
  console.log("Lat [0:3, 0:3]:", Array.from(latSlice).map(v => v.toFixed(4)));
  console.log("Lon [0:3, 0:3]:", Array.from(lonSlice).map(v => v.toFixed(4)));
}

main().catch(console.error);
