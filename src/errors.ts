export class ZarrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZarrError";
  }
}

export class MetadataError extends ZarrError {
  constructor(message: string) {
    super(message);
    this.name = "MetadataError";
  }
}

export class StoreError extends ZarrError {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

export class CodecError extends ZarrError {
  constructor(message: string) {
    super(message);
    this.name = "CodecError";
  }
}

export class SliceError extends ZarrError {
  constructor(message: string) {
    super(message);
    this.name = "SliceError";
  }
}

export class MissingChunkError extends ZarrError {
  constructor(key: string) {
    super(`Missing chunk: "${key}"`);
    this.name = "MissingChunkError";
  }
}

export class UnsupportedOperationError extends StoreError {
  constructor(operation: string, storeName: string) {
    super(`${storeName} does not support ${operation}`);
    this.name = "UnsupportedOperationError";
  }
}
