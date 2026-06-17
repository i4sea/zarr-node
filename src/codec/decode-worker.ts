// Worker entry for offloaded chunk decompression.
//
// Runs in a `worker_threads` Worker spawned by `DecodePool`. It reuses the
// main `codecRegistry` — which already handles loading the ESM-only
// `numcodecs` package (including the CJS `eval`-import escape hatch patched by
// `scripts/postbuild-cjs.mjs`) — so heavy synchronous Blosc decodes run off the
// main event loop. The decoded buffer is transferred back to the parent (no
// copy) whenever it owns a standalone ArrayBuffer.
import { parentPort } from "node:worker_threads";
import { codecRegistry } from "./codec.js";
import type { Codec } from "./codec.js";
import type { CompressorConfig } from "../metadata/types.js";

export interface DecodeRequest {
  id: number;
  config: CompressorConfig;
  input: Uint8Array;
}

export interface DecodeResponse {
  id: number;
  ok: boolean;
  output?: Uint8Array;
  error?: string;
}

// Cache codec instances per compressor id. Blosc decode is self-describing
// (the codec is read from the blob header), so one instance per id suffices.
const codecCache = new Map<string, Promise<Codec>>();

function getCodec(config: CompressorConfig): Promise<Codec> {
  let cached = codecCache.get(config.id);
  if (!cached) {
    cached = codecRegistry.get(config);
    codecCache.set(config.id, cached);
  }
  return cached;
}

/** Ensure a Uint8Array backed by a standalone ArrayBuffer so it can be transferred. */
function toTransferable(u8: Uint8Array): Uint8Array {
  if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) {
    return u8;
  }
  return u8.slice();
}

if (parentPort) {
  const port = parentPort;
  port.on("message", (req: DecodeRequest) => {
    void (async () => {
      try {
        const codec = await getCodec(req.config);
        const decoded = await codec.decode(req.input);
        const output = toTransferable(decoded);
        const res: DecodeResponse = { id: req.id, ok: true, output };
        port.postMessage(res, [output.buffer as ArrayBuffer]);
      } catch (err) {
        const res: DecodeResponse = {
          id: req.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
        port.postMessage(res);
      }
    })();
  });
}
