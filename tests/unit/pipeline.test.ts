import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { CodecPipeline, buildV2Pipeline } from "../../src/codec/pipeline.js";
import type { PipelineStage } from "../../src/codec/pipeline.js";
import { MetadataError } from "../../src/errors.js";
import { FileSystemStore } from "../../src/store/filesystem.js";
import { openArray } from "../../src/open.js";

/** Stage whose decode appends its tag to `log` and passes bytes through. */
function tracingStage(
  kind: PipelineStage["kind"],
  tag: string,
  log: string[],
): PipelineStage {
  return {
    kind,
    config: { id: tag },
    codec: {
      id: tag,
      async decode(data: Uint8Array) {
        log.push(tag);
        return data;
      },
    },
  };
}

describe("CodecPipeline — construction and validation", () => {
  it("empty chain is a pass-through", async () => {
    const pipeline = CodecPipeline.passthrough();
    const input = new Uint8Array([1, 2, 3]);
    const out = await pipeline.decode(input);
    expect(out).toBe(input);
    expect(pipeline.isPassthrough).toBe(true);
  });

  it("rejects a non-empty chain with zero array→bytes codecs", () => {
    const log: string[] = [];
    expect(
      () => new CodecPipeline([tracingStage("bytes->bytes", "gzip", log)]),
    ).toThrow(MetadataError);
  });

  it("rejects a chain with more than one array→bytes codec", () => {
    const log: string[] = [];
    expect(
      () =>
        new CodecPipeline([
          tracingStage("array->bytes", "bytes", log),
          tracingStage("array->bytes", "bytes", log),
        ]),
    ).toThrow(MetadataError);
  });

  it("applies stages in reverse of the declared (encode) order on decode", async () => {
    const log: string[] = [];
    const pipeline = new CodecPipeline([
      tracingStage("array->array", "transpose", log),
      tracingStage("array->bytes", "bytes", log),
      tracingStage("bytes->bytes", "gzip", log),
    ]);
    await pipeline.decode(new Uint8Array([0]));
    expect(log).toEqual(["gzip", "bytes", "transpose"]);
  });

  it("is not a pass-through when a transforming stage is present", () => {
    const log: string[] = [];
    const pipeline = new CodecPipeline([
      tracingStage("array->bytes", "bytes", log),
      tracingStage("bytes->bytes", "gzip", log),
    ]);
    expect(pipeline.isPassthrough).toBe(false);
  });
});

describe("buildV2Pipeline", () => {
  it("null compressor and null filters produce a pass-through", async () => {
    const pipeline = await buildV2Pipeline(null, null);
    expect(pipeline.isPassthrough).toBe(true);
  });

  it("a compressor produces a decoding pipeline (gzip round-trip)", async () => {
    const { gzipSync } = await import("node:zlib");
    const pipeline = await buildV2Pipeline({ id: "gzip" }, null);
    expect(pipeline.isPassthrough).toBe(false);

    const raw = new Uint8Array([5, 6, 7, 8]);
    const decoded = await pipeline.decode(new Uint8Array(gzipSync(raw)));
    expect(Array.from(decoded)).toEqual([5, 6, 7, 8]);
  });

  it("reads the v2_filtered fixture — a declared filter is applied (FR-009)", async () => {
    // Reference fixture written by zarr-python with filters=[Zlib(1)] and no
    // compressor: values decode correctly only if the filter stage runs.
    const fixture = join(import.meta.dirname, "..", "fixtures", "v2_filtered");
    const expected = JSON.parse(
      await readFile(join(fixture, "expected.json"), "utf-8"),
    ) as { shape: number[]; data: number[] };

    const arr = await openArray(new FileSystemStore({ path: fixture }));
    expect(arr.shape).toEqual(expected.shape);

    const data = await arr.get();
    expect(data.length).toBe(expected.data.length);
    for (let i = 0; i < expected.data.length; i++) {
      expect(data[i]).toBe(expected.data[i]);
    }
  });

  it("applies v2 filters on decode after the compressor (FR-009)", async () => {
    // Encode order: filters first, then compressor — decode must reverse:
    // decompress, then apply each filter's decode in reverse declaration order.
    const { gzipSync, deflateSync } = await import("node:zlib");
    // filter = zlib, compressor = gzip: stored bytes are gzip(zlib(raw)).
    const pipeline = await buildV2Pipeline({ id: "gzip" }, [{ id: "zlib" }]);

    const raw = new Uint8Array([9, 8, 7]);
    const stored = new Uint8Array(gzipSync(deflateSync(raw)));
    const decoded = await pipeline.decode(stored);
    expect(Array.from(decoded)).toEqual([9, 8, 7]);
  });
});
