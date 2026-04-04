import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { FileSystemStore } from "../../src/store/filesystem.js";
import { openDataset } from "../../src/index.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

describe("Dataset", () => {
  // T035: Open fixture as Dataset, verify dimension discovery
  it("auto-discovers dimensions from _ARRAY_DIMENSIONS attrs", async () => {
    const store = new FileSystemStore({ path: join(FIXTURES, "dataset_wrf") });
    const ds = await openDataset(store);

    expect(ds.dimensionNames).toContain("time");
    expect(ds.dimensionNames).toContain("lat");
    expect(ds.dimensionNames).toContain("lon");
  });

  it("identifies coordinate and data variable arrays", async () => {
    const store = new FileSystemStore({ path: join(FIXTURES, "dataset_wrf") });
    const ds = await openDataset(store);

    // Coordinates: arrays whose name matches a dimension name
    expect(ds.coordinateNames).toContain("time");
    expect(ds.coordinateNames).toContain("lat");
    expect(ds.coordinateNames).toContain("lon");

    // Data variables: arrays that are NOT coordinates
    expect(ds.variableNames).toContain("temperature");
    expect(ds.variableNames).toContain("wind");
    expect(ds.variableNames).not.toContain("time");
    expect(ds.variableNames).not.toContain("lat");
  });

  // T036: ds.sel() with coordinate values
  it("selects data by coordinate values (nearest-neighbor)", async () => {
    const store = new FileSystemStore({ path: join(FIXTURES, "dataset_wrf") });
    const ds = await openDataset(store);

    // Load expected data for comparison
    const expectedJson = JSON.parse(
      await readFile(join(FIXTURES, "dataset_wrf", "expected.json"), "utf-8"),
    );

    // sel at first time step, nearest lat/lon
    // time=0 -> index 0, lat=-25.5 -> index 1, lon=-44.5 -> index 1
    const results = await ds.sel(
      { time: 0, lat: -25.5, lon: -44.5 },
      ["temperature", "wind"],
    );

    expect(results.size).toBe(2);
    expect(results.has("temperature")).toBe(true);
    expect(results.has("wind")).toBe(true);

    // Verify we got single values (point selection)
    const temp = results.get("temperature")!;
    const wind = results.get("wind")!;
    expect(temp.length).toBe(1);
    expect(wind.length).toBe(1);

    // Verify the values match expected[0][1][1] in the flattened data
    // temperature shape is [3,4,3], index [0,1,1] = 0*12 + 1*3 + 1 = 4
    const expectedTemp = expectedJson.temperature.data[4];
    expect(temp[0]).toBeCloseTo(expectedTemp, 4);
  });

  // 2D coordinate support (WRF-style lat[y,x], lon[y,x])
  it("handles 2D coordinates with linear nearest-neighbor", async () => {
    const store = new FileSystemStore({ path: join(FIXTURES, "dataset_2d_coords") });
    const ds = await openDataset(store);

    // lat and lon are 2D auxiliary coordinates
    expect(ds.coordinateNames).toContain("lat");
    expect(ds.coordinateNames).toContain("lon");
    expect(ds.variableNames).toContain("temp");

    // Select by 2D coordinate — should resolve to correct (y, x) indices
    // lat=-25.5 → y=1, lon=-44.5 → x=1
    const results = await ds.sel({ time: 0, lat: -25.5, lon: -44.5 }, ["temp"]);
    expect(results.has("temp")).toBe(true);

    const temp = results.get("temp")!;
    expect(temp.length).toBe(1);
    // temp[0, 1, 1] = 0*9 + 1*3 + 1 = 4
    expect(temp[0]).toBeCloseTo(4.0, 4);
  });

  it("sel with all variables (default)", async () => {
    const store = new FileSystemStore({ path: join(FIXTURES, "dataset_wrf") });
    const ds = await openDataset(store);

    const results = await ds.sel({ time: 3600, lat: -25.0, lon: -44.0 });

    // Should return all data variables
    expect(results.has("temperature")).toBe(true);
    expect(results.has("wind")).toBe(true);
    // Should NOT return coordinates
    expect(results.has("time")).toBe(false);
    expect(results.has("lat")).toBe(false);
  });
});
