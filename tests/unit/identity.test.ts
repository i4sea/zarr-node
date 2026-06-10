import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveStoreId } from "../../src/store/identity.js";
import { S3Store } from "../../src/store/s3.js";
import { HTTPStore } from "../../src/store/http.js";
import { FileSystemStore } from "../../src/store/filesystem.js";
import { CachedStore } from "../../src/cache/cached-store.js";

describe("deriveStoreId", () => {
  it("derives s3://bucket/prefix for S3 stores", () => {
    const store = new S3Store({ bucket: "data", prefix: "ds" });
    expect(deriveStoreId(store)).toBe("s3://data/ds");
  });

  it("includes the endpoint so S3-compatible environments never collide", () => {
    const staging = new S3Store({
      bucket: "data",
      prefix: "ds",
      endpoint: "https://minio-staging:9000",
    });
    const prod = new S3Store({
      bucket: "data",
      prefix: "ds",
      endpoint: "https://minio-prod:9000",
    });
    const idStaging = deriveStoreId(staging);
    const idProd = deriveStoreId(prod);
    expect(idStaging).not.toBeNull();
    expect(idStaging).not.toBe(idProd);
    expect(idStaging).not.toBe(deriveStoreId(new S3Store({ bucket: "data", prefix: "ds" })));
  });

  it("derives the base URL for HTTP stores", () => {
    const store = new HTTPStore({ url: "https://example.com/data/" });
    expect(deriveStoreId(store)).toBe("https://example.com/data");
  });

  it("unwraps CachedStore to the inner store's identity", () => {
    const inner = new S3Store({ bucket: "data", prefix: "ds" });
    const cached = new CachedStore(inner, {
      cacheDir: join(tmpdir(), "zarr-identity-test"),
      maxSizeBytes: 1024,
    });
    expect(deriveStoreId(cached)).toBe(deriveStoreId(inner));
  });

  it("returns null for stores with no derivable identity", () => {
    const store = new FileSystemStore({ path: "/tmp/data" });
    expect(deriveStoreId(store)).toBeNull();
  });
});
