import { MetadataError } from "./errors.js";

export type TypedArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array;

export type TypedArrayConstructor =
  | Int8ArrayConstructor
  | Uint8ArrayConstructor
  | Int16ArrayConstructor
  | Uint16ArrayConstructor
  | Int32ArrayConstructor
  | Uint32ArrayConstructor
  | Float32ArrayConstructor
  | Float64ArrayConstructor
  | BigInt64ArrayConstructor
  | BigUint64ArrayConstructor;

const DTYPE_MAP: Record<
  string,
  { ctor: TypedArrayConstructor; byteSize: number }
> = {
  "|b1": { ctor: Int8Array, byteSize: 1 },
  "|i1": { ctor: Int8Array, byteSize: 1 },
  "|u1": { ctor: Uint8Array, byteSize: 1 },
  "<i2": { ctor: Int16Array, byteSize: 2 },
  ">i2": { ctor: Int16Array, byteSize: 2 },
  "<u2": { ctor: Uint16Array, byteSize: 2 },
  ">u2": { ctor: Uint16Array, byteSize: 2 },
  "<i4": { ctor: Int32Array, byteSize: 4 },
  ">i4": { ctor: Int32Array, byteSize: 4 },
  "<u4": { ctor: Uint32Array, byteSize: 4 },
  ">u4": { ctor: Uint32Array, byteSize: 4 },
  "<f4": { ctor: Float32Array, byteSize: 4 },
  ">f4": { ctor: Float32Array, byteSize: 4 },
  "<f8": { ctor: Float64Array, byteSize: 8 },
  ">f8": { ctor: Float64Array, byteSize: 8 },
  "<i8": { ctor: BigInt64Array, byteSize: 8 },
  ">i8": { ctor: BigInt64Array, byteSize: 8 },
  "<u8": { ctor: BigUint64Array, byteSize: 8 },
  ">u8": { ctor: BigUint64Array, byteSize: 8 },
};

function lookupDtype(dtype: string) {
  const entry = DTYPE_MAP[dtype];
  if (!entry) {
    throw new MetadataError(
      `Unsupported dtype: "${dtype}". Supported dtypes: ${Object.keys(DTYPE_MAP).join(", ")}`,
    );
  }
  return entry;
}

export function dtypeToTypedArrayCtor(dtype: string): TypedArrayConstructor {
  return lookupDtype(dtype).ctor;
}

export function dtypeByteSize(dtype: string): number {
  return lookupDtype(dtype).byteSize;
}

export function isBigEndian(dtype: string): boolean {
  return dtype.startsWith(">");
}

export function byteSwap(buf: Buffer, byteSize: number): void {
  if (byteSize <= 1) return;
  if (byteSize === 2) {
    buf.swap16();
  } else if (byteSize === 4) {
    buf.swap32();
  } else if (byteSize === 8) {
    buf.swap64();
  }
}
