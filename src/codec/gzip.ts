import { promisify } from "node:util";
import { inflate as inflateCb, gunzip as gunzipCb } from "node:zlib";
import { CodecError } from "../errors.js";
import type { Codec } from "./codec.js";

const inflate = promisify(inflateCb);
const gunzip = promisify(gunzipCb);

export class GzipCodec implements Codec {
  readonly id: string;

  constructor(id: string) {
    this.id = id;
  }

  async decode(data: Uint8Array): Promise<Uint8Array> {
    try {
      const decompressFn = this.id === "gzip" ? gunzip : inflate;
      const result = await decompressFn(Buffer.from(data));
      return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
    } catch (err) {
      throw new CodecError(
        `Failed to decompress chunk with codec "${this.id}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
