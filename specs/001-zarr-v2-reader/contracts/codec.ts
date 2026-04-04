/**
 * Codec interface — decompresses chunk data.
 *
 * Constitution Principle IV: Extensible Plugin Architecture.
 * Users can implement this interface for custom codecs.
 */
export interface Codec {
  /** Compressor identifier (e.g., "zlib", "gzip"). */
  readonly id: string;

  /**
   * Decompress chunk bytes.
   * @param data - Compressed chunk data.
   * @returns Decompressed bytes.
   */
  decode(data: Uint8Array): Promise<Uint8Array>;
}

/**
 * Compressor configuration from .zarray metadata.
 */
export interface CompressorConfig {
  /** Compressor identifier. */
  id: string;
  /** Additional compressor-specific parameters. */
  [key: string]: unknown;
}

/**
 * Codec factory function — creates a Codec from compressor config.
 */
export type CodecFactory = (config: CompressorConfig) => Codec;

/**
 * CodecRegistry — maps compressor IDs to codec factories.
 *
 * Pre-populated with built-in codecs. Users register custom codecs
 * via register(). Throws if an unregistered compressor is encountered.
 */
export interface CodecRegistry {
  /** Register a codec factory for a compressor ID. */
  register(id: string, factory: CodecFactory): void;

  /** Create a codec from a compressor config. Throws if ID not registered. */
  get(config: CompressorConfig): Codec;

  /** Check if a compressor ID has a registered factory. */
  has(id: string): boolean;
}
