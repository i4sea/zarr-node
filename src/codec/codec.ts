import { CodecError } from "../errors.js";
import type { CompressorConfig } from "../metadata/types.js";

export interface Codec {
  readonly id: string;
  decode(data: Uint8Array): Promise<Uint8Array>;
}

export type CodecFactory = (config: CompressorConfig) => Codec | Promise<Codec>;

export interface CodecRegistry {
  register(id: string, factory: CodecFactory): void;
  get(config: CompressorConfig): Promise<Codec>;
  has(id: string): boolean;
}

class CodecRegistryImpl implements CodecRegistry {
  private factories = new Map<string, CodecFactory>();

  register(id: string, factory: CodecFactory): void {
    this.factories.set(id, factory);
  }

  async get(config: CompressorConfig): Promise<Codec> {
    const factory = this.factories.get(config.id);
    if (!factory) {
      throw new CodecError(
        `No codec registered for compressor ID "${config.id}". ` +
          `Register one with codecRegistry.register("${config.id}", factory). ` +
          `Available codecs: ${[...this.factories.keys()].join(", ") || "(none)"}`,
      );
    }
    return await factory(config);
  }

  has(id: string): boolean {
    return this.factories.has(id);
  }
}

export const codecRegistry: CodecRegistry = new CodecRegistryImpl();

// Register built-in codecs (sync factories).
import { GzipCodec } from "./gzip.js";

codecRegistry.register("zlib", () => new GzipCodec("zlib"));
codecRegistry.register("gzip", () => new GzipCodec("gzip"));

// Lazy-load Blosc. `numcodecs` is ESM-only — its package.json `exports`
// map has only an `"import"` condition. Two consequences for the CJS
// build:
//
//   1. A static `import { Blosc } from "numcodecs"` would compile to a
//      synchronous `require("numcodecs")` and throw `ERR_REQUIRE_ESM`
//      at load time.
//   2. Even a TypeScript dynamic `import("numcodecs")` gets transpiled
//      under `module: commonjs` to `Promise.resolve().then(s =>
//      require(s))` — same crash, deferred to first use.
//
// The escape hatch is to hide the dynamic import from tsc using the
// `Function` constructor. tsc sees an opaque function call; at runtime
// V8 parses the body and emits a real ESM `import()` call, which Node
// always routes through the ESM loader regardless of the caller's
// module system. This is the standard pattern for consuming ESM-only
// deps from a dual-published library.
interface NumcodecsModule {
  Blosc: { fromConfig(config: CompressorConfig): Codec };
}
let bloscModulePromise: Promise<NumcodecsModule> | null = null;
function loadNumcodecs(): Promise<NumcodecsModule> {
  if (!bloscModulePromise) {
    bloscModulePromise = import("numcodecs") as Promise<NumcodecsModule>;
  }
  return bloscModulePromise;
}

if (!codecRegistry.has("blosc")) {
  codecRegistry.register("blosc", async (config) => {
    const { Blosc } = await loadNumcodecs();
    return Blosc.fromConfig(config);
  });
}
// "raw" / null compressor is handled directly in the chunk loader, not via registry
