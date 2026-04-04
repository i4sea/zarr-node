import type { Codec } from "./codec.js";

export class RawCodec implements Codec {
  readonly id = "raw";

  async decode(data: Uint8Array): Promise<Uint8Array> {
    return data;
  }
}
