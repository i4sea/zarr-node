// Worker-thread pool for offloading heavy synchronous chunk decompression
// (Blosc) off the main event loop.
//
// `numcodecs` Blosc is synchronous WASM: although `Codec.decode()` is async,
// the decompression blocks the event loop for its whole duration. In a shared
// API pod (e.g. NestJS) that starves every other in-flight request. This pool
// routes offloadable, large-enough chunks to background threads instead.
//
// Opt-in: the read path only uses it when a `DecodePool` is passed via
// `ReadOptions.decodeWorkers`. The consumer owns the lifecycle and must call
// `terminate()` when done (idle workers keep the process alive).
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodecError } from "../errors.js";
import type { CompressorConfig } from "../metadata/types.js";
import type { DecodeRequest, DecodeResponse } from "./decode-worker.js";

/**
 * Codecs whose `decode` is synchronous CPU work and therefore block the event
 * loop. Only these are offloaded — `gzip`/`zlib` already run on the libuv
 * threadpool (via `node:zlib` callbacks), so offloading them would add IPC
 * overhead for no gain.
 */
const OFFLOADABLE_CODECS = new Set(["blosc"]);

/** Default compressed-size threshold below which offload isn't worth the IPC cost. */
const DEFAULT_MIN_BYTES = 256 * 1024;

export interface DecodePoolOptions {
  /**
   * Number of worker threads. Default: `availableParallelism() - 1` (min 1),
   * leaving a core for the main event loop.
   */
  poolSize?: number;
  /**
   * Minimum *compressed* chunk size (bytes) to offload. Below this, decoding
   * happens inline — the IPC/transfer cost would exceed the decode time.
   * The threshold is on the compressed size because it's known before decode.
   * Default: 256 KiB.
   */
  minBytes?: number;
}

interface InFlight {
  resolve: (value: Uint8Array) => void;
  reject: (err: Error) => void;
}

interface PoolWorker {
  worker: Worker;
  job: { id: number; inFlight: InFlight } | null;
}

/** Resolve the compiled worker entry path under both ESM and CJS builds. */
function resolveWorkerEntry(): string {
  // CJS build: `__dirname` is defined.
  if (typeof __dirname !== "undefined") {
    return join(__dirname, "decode-worker.js");
  }
  // ESM build: derive the directory from `import.meta.url`, read through
  // `eval` so the CJS compile of this same source (module: commonjs, where
  // `import.meta` is a TS1343 error) still type-checks. Direct eval runs in
  // module scope, where `import.meta` is available at runtime under ESM.
  const metaUrl = eval("import.meta.url") as string;
  return fileURLToPath(new URL("./decode-worker.js", metaUrl));
}

export class DecodePool {
  readonly poolSize: number;
  readonly minBytes: number;

  private workers: PoolWorker[] = [];
  private idle: PoolWorker[] = [];
  private queue: Array<{
    config: CompressorConfig;
    input: Uint8Array;
    inFlight: InFlight;
  }> = [];
  private nextId = 1;
  private started = false;
  private terminated = false;

  constructor(options: DecodePoolOptions = {}) {
    const detected = availableParallelism();
    this.poolSize = Math.max(1, options.poolSize ?? detected - 1);
    this.minBytes = options.minBytes ?? DEFAULT_MIN_BYTES;
  }

  /**
   * Whether a chunk should be offloaded: the codec is synchronous/blocking and
   * the compressed payload is at least `minBytes`.
   */
  shouldOffload(codecId: string | null, rawByteLength: number): boolean {
    return (
      !this.terminated &&
      codecId !== null &&
      OFFLOADABLE_CODECS.has(codecId) &&
      rawByteLength >= this.minBytes
    );
  }

  /** Decode `input` on a worker thread, resolving with the decompressed bytes. */
  decode(config: CompressorConfig, input: Uint8Array): Promise<Uint8Array> {
    if (this.terminated) {
      return Promise.reject(new CodecError("DecodePool has been terminated"));
    }
    this.ensureStarted();
    return new Promise<Uint8Array>((resolve, reject) => {
      const inFlight: InFlight = { resolve, reject };
      const worker = this.idle.pop();
      if (worker) {
        this.dispatch(worker, config, input, inFlight);
      } else {
        this.queue.push({ config, input, inFlight });
      }
    });
  }

  /** Terminate all workers and reject any queued/in-flight jobs. */
  async terminate(): Promise<void> {
    this.terminated = true;
    for (const pending of this.queue.splice(0)) {
      pending.inFlight.reject(new CodecError("DecodePool terminated"));
    }
    const all = this.workers.splice(0);
    this.idle = [];
    await Promise.all(
      all.map((pw) => {
        if (pw.job) {
          pw.job.inFlight.reject(new CodecError("DecodePool terminated"));
          pw.job = null;
        }
        return pw.worker.terminate();
      }),
    );
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    for (let i = 0; i < this.poolSize; i++) {
      const pw = this.spawnWorker();
      this.workers.push(pw);
      this.idle.push(pw);
    }
  }

  private spawnWorker(): PoolWorker {
    const pw: PoolWorker = {
      worker: new Worker(resolveWorkerEntry()),
      job: null,
    };
    pw.worker.on("message", (res: DecodeResponse) => {
      const job = pw.job;
      if (!job || job.id !== res.id) return; // stale / already handled
      pw.job = null;
      if (res.ok && res.output) {
        job.inFlight.resolve(res.output);
      } else {
        job.inFlight.reject(
          new CodecError(res.error ?? "chunk decode failed in worker"),
        );
      }
      this.release(pw);
    });
    pw.worker.on("error", (err: Error) => {
      const job = pw.job;
      pw.job = null;
      if (job) {
        job.inFlight.reject(
          new CodecError(`decode worker error: ${err.message}`),
        );
      }
      this.handleDeath(pw);
    });
    return pw;
  }

  private dispatch(
    pw: PoolWorker,
    config: CompressorConfig,
    input: Uint8Array,
    inFlight: InFlight,
  ): void {
    const id = this.nextId++;
    pw.job = { id, inFlight };
    // The compressed input is structured-cloned (not transferred), so the
    // caller's buffer stays valid; the large decoded output is transferred back.
    const req: DecodeRequest = { id, config, input };
    pw.worker.postMessage(req);
  }

  private release(pw: PoolWorker): void {
    if (this.terminated) return;
    const next = this.queue.shift();
    if (next) {
      this.dispatch(pw, next.config, next.input, next.inFlight);
    } else {
      this.idle.push(pw);
    }
  }

  private handleDeath(pw: PoolWorker): void {
    this.workers = this.workers.filter((w) => w !== pw);
    this.idle = this.idle.filter((w) => w !== pw);
    void pw.worker.terminate();
    if (this.terminated) return;
    // Replace the dead worker so the pool keeps its size, then resume the queue.
    const fresh = this.spawnWorker();
    this.workers.push(fresh);
    this.release(fresh);
  }
}
