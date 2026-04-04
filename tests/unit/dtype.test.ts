import { describe, it, expect } from "vitest";
import {
  dtypeToTypedArrayCtor,
  dtypeByteSize,
  isBigEndian,
  byteSwap,
} from "../../src/dtype.js";

describe("dtypeToTypedArrayCtor", () => {
  it("maps <f4 to Float32Array", () => {
    expect(dtypeToTypedArrayCtor("<f4")).toBe(Float32Array);
  });

  it("maps >f8 to Float64Array", () => {
    expect(dtypeToTypedArrayCtor(">f8")).toBe(Float64Array);
  });

  it("maps <i4 to Int32Array", () => {
    expect(dtypeToTypedArrayCtor("<i4")).toBe(Int32Array);
  });

  it("maps <u2 to Uint16Array", () => {
    expect(dtypeToTypedArrayCtor("<u2")).toBe(Uint16Array);
  });

  it("maps |u1 to Uint8Array", () => {
    expect(dtypeToTypedArrayCtor("|u1")).toBe(Uint8Array);
  });

  it("maps |i1 to Int8Array", () => {
    expect(dtypeToTypedArrayCtor("|i1")).toBe(Int8Array);
  });

  it("maps |b1 to Int8Array", () => {
    expect(dtypeToTypedArrayCtor("|b1")).toBe(Int8Array);
  });

  it("maps <i2 to Int16Array", () => {
    expect(dtypeToTypedArrayCtor("<i2")).toBe(Int16Array);
  });

  it("maps <u4 to Uint32Array", () => {
    expect(dtypeToTypedArrayCtor("<u4")).toBe(Uint32Array);
  });

  it("throws on unsupported dtype", () => {
    expect(() => dtypeToTypedArrayCtor("<c8")).toThrow("Unsupported dtype");
  });
});

describe("dtypeByteSize", () => {
  it("returns 4 for <f4", () => {
    expect(dtypeByteSize("<f4")).toBe(4);
  });

  it("returns 8 for >f8", () => {
    expect(dtypeByteSize(">f8")).toBe(8);
  });

  it("returns 1 for |u1", () => {
    expect(dtypeByteSize("|u1")).toBe(1);
  });

  it("returns 2 for <i2", () => {
    expect(dtypeByteSize("<i2")).toBe(2);
  });
});

describe("isBigEndian", () => {
  it("returns true for > prefix", () => {
    expect(isBigEndian(">f8")).toBe(true);
  });

  it("returns false for < prefix", () => {
    expect(isBigEndian("<f4")).toBe(false);
  });

  it("returns false for | prefix (byte-order agnostic)", () => {
    expect(isBigEndian("|u1")).toBe(false);
  });
});

describe("byteSwap", () => {
  it("swaps 2-byte values in-place", () => {
    const buf = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    byteSwap(buf, 2);
    expect(buf).toEqual(Buffer.from([0x02, 0x01, 0x04, 0x03]));
  });

  it("swaps 4-byte values in-place", () => {
    const buf = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    byteSwap(buf, 4);
    expect(buf).toEqual(Buffer.from([0x04, 0x03, 0x02, 0x01]));
  });

  it("swaps 8-byte values in-place", () => {
    const buf = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    byteSwap(buf, 8);
    expect(buf).toEqual(
      Buffer.from([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]),
    );
  });

  it("is a no-op for 1-byte values", () => {
    const buf = Buffer.from([0x01, 0x02, 0x03]);
    byteSwap(buf, 1);
    expect(buf).toEqual(Buffer.from([0x01, 0x02, 0x03]));
  });
});
