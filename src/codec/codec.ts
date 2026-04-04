import { CodecError } from "../errors.js";
import type { CompressorConfig } from "../metadata/types.js";

export interface Codec {
  readonly id: string;
  decode(data: Uint8Array): Promise<Uint8Array>;
}

export type CodecFactory = (config: CompressorConfig) => Codec;

export interface CodecRegistry {
  register(id: string, factory: CodecFactory): void;
  get(config: CompressorConfig): Codec;
  has(id: string): boolean;
}

class CodecRegistryImpl implements CodecRegistry {
  private factories = new Map<string, CodecFactory>();

  register(id: string, factory: CodecFactory): void {
    this.factories.set(id, factory);
  }

  get(config: CompressorConfig): Codec {
    const factory = this.factories.get(config.id);
    if (!factory) {
      throw new CodecError(
        `No codec registered for compressor ID "${config.id}". ` +
          `Register one with codecRegistry.register("${config.id}", factory). ` +
          `Available codecs: ${[...this.factories.keys()].join(", ") || "(none)"}`,
      );
    }
    return factory(config);
  }

  has(id: string): boolean {
    return this.factories.has(id);
  }
}

export const codecRegistry: CodecRegistry = new CodecRegistryImpl();

// Register built-in codecs
import { GzipCodec } from "./gzip.js";

codecRegistry.register("zlib", () => new GzipCodec("zlib"));
codecRegistry.register("gzip", () => new GzipCodec("gzip"));
// "raw" / null compressor is handled directly in the chunk loader, not via registry
