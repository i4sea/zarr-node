/**
 * Diagnóstico focado: custo REAL de ler 1 ponto (série temporal) de um dataset
 * de produção, replicando a lógica de slice do nautilus (tempo inteiro + 1 célula
 * espacial; dims intermediárias singleton selecionadas em 0).
 *
 * Mede, para a variável escolhida, frio (S3) × quente-disco (só decode) ×
 * quente-memória (nada), e imprime: shape/chunks do array, bytes baixados,
 * bytes decodificados, tempo de decode e o OVER-READ RATIO (bytes movidos ÷
 * bytes úteis devolvidos). Funciona para qualquer rank (grade rank-3, hidro
 * rank-4 com z singleton, point rank-2).
 *
 * Rodar (in-region p/ refletir a latência do pod):
 *   S3_BUCKET=i4sea-zarr S3_REGION=us-east-1 \
 *     S3_PREFIX=oper/data/model/san/san001/wrf/2026061500/forcing_atm_WRF_san1_2026061506.zarr \
 *     DATA_VAR=wind_vel npx tsx examples/diagnose-prod-read.ts
 */
import {
  S3Store,
  CachedStore,
  MemoryCache,
  openGroup,
  type Store,
  type ReadOptions,
  type ObservabilityHooks,
  type Slice,
} from "../src/index.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const S3_BUCKET = process.env.S3_BUCKET ?? "i4sea-zarr";
const S3_PREFIX = process.env.S3_PREFIX ?? "";
const S3_REGION = process.env.S3_REGION ?? "us-east-1";
const DATA_VAR = process.env.DATA_VAR ?? "wind_vel";

const fmt = (ms: number): string =>
  ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : ms < 1000 ? `${ms.toFixed(1)}ms` : `${(ms / 1000).toFixed(2)}s`;
const mib = (b: number): string => `${(b / 1024 / 1024).toFixed(2)} MiB`;

// ── contadores de I/O de backend e de decode ──────────────────────────────
interface Io { gets: number; getBytes: number; getMs: number }
class TimingStore implements Store {
  io: Io = { gets: 0, getBytes: 0, getMs: 0 };
  constructor(private readonly inner: Store) {}
  reset(): void { this.io = { gets: 0, getBytes: 0, getMs: 0 }; }
  async get(key: string): Promise<Uint8Array | null> {
    const t0 = performance.now();
    const r = await this.inner.get(key);
    this.io.getMs += performance.now() - t0;
    this.io.gets++;
    if (r) this.io.getBytes += r.byteLength;
    return r;
  }
  async has(key: string): Promise<boolean> { return this.inner.has(key); }
  async *list(prefix: string): AsyncIterable<string> { yield* this.inner.list(prefix); }
  async getRange(key: string, offset: number, length: number): Promise<Uint8Array | null> {
    return (this.inner.getRange?.(key, offset, length) ?? this.inner.get(key));
  }
}
interface Ev { decodes: number; decodeMs: number; decodedBytes: number }
class Probe {
  ev: Ev = { decodes: 0, decodeMs: 0, decodedBytes: 0 };
  readonly hooks: ObservabilityHooks = {
    onChunkDecoded: (e) => { this.ev.decodes++; this.ev.decodeMs += e.decodeMs; this.ev.decodedBytes += e.bytes; },
  };
  reset(): void { this.ev = { decodes: 0, decodeMs: 0, decodedBytes: 0 }; }
}

async function tryGetArray(group: Awaited<ReturnType<typeof openGroup>>, name: string) {
  try { return await group.getArray(name); } catch { return null; }
}
function toF64(a: ArrayLike<number | bigint>): Float64Array {
  const o = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = Number(a[i]);
  return o;
}

interface Pass { ms: number; gets: number; bytes: number; decodes: number; decodedBytes: number; decodeMs: number; returned: number }
async function measure(store: TimingStore, probe: Probe, fn: () => Promise<{ length: number }>): Promise<Pass> {
  store.reset(); probe.reset();
  const t0 = performance.now();
  const v = await fn();
  const ms = performance.now() - t0;
  return { ms, gets: store.io.gets, bytes: store.io.getBytes, decodes: probe.ev.decodes, decodedBytes: probe.ev.decodedBytes, decodeMs: probe.ev.decodeMs, returned: v.length };
}

/** Slice estilo nautilus: dim0 = tempo inteiro; dims do meio (singleton) = 0; dims espaciais = índices do ponto. */
function buildSlice(rank: number, spatialDimCount: number, pointIdx: number[]): Slice {
  const sel: Slice = new Array(rank);
  sel[0] = null; // todo o tempo
  const spatialStart = rank - spatialDimCount;
  for (let i = 1; i < spatialStart; i++) sel[i] = 0;
  for (let i = 0; i < spatialDimCount; i++) sel[spatialStart + i] = pointIdx[i];
  return sel;
}

async function main(): Promise<void> {
  if (!S3_PREFIX) { console.error("Defina S3_PREFIX."); process.exit(1); }
  console.log(`\n  dataset: s3://${S3_BUCKET}/${S3_PREFIX}`);
  console.log(`  região: ${S3_REGION}  | variável: ${DATA_VAR}\n`);

  const probe = new Probe();
  const ro: ReadOptions = { observability: probe.hooks, concurrency: 50 };
  const diskDir = join(tmpdir(), `zarr-diag-${process.pid}`);
  const s3 = new S3Store({ bucket: S3_BUCKET, prefix: S3_PREFIX, region: S3_REGION, maxSockets: 128, observability: probe.hooks });
  await s3.prewarm().catch(() => {});
  const timing = new TimingStore(s3);
  const cached = new CachedStore(timing, { cacheDir: diskDir, storeId: `diag-${process.pid}`, maxSizeBytes: 2 * 1024 ** 3, observability: probe.hooks });

  try {
    const root = await openGroup(cached, "", { observability: probe.hooks });
    const arr = await root.getArray(DATA_VAR);
    const rank = arr.shape.length;
    const chunkElems = (arr.chunks as number[]).reduce((a, b) => a * b, 1);
    console.log(`  ${DATA_VAR}: shape=${JSON.stringify(arr.shape)} chunks=${JSON.stringify(arr.chunks)} dtype=${arr.dtype}`);
    console.log(`  1 chunk = ${chunkElems.toLocaleString()} elementos ≈ ${mib(chunkElems * 4)} (float32)\n`);

    // Resolver um ponto espacial real (centro). spatialDimCount: rank-2 → 1 (npoints); senão → 2 (lat/lon).
    const spatialDimCount = rank === 2 ? 1 : 2;
    let pointIdx: number[];
    if (spatialDimCount === 1) {
      const npoints = arr.shape[1];
      pointIdx = [Math.floor(npoints / 2)];
    } else {
      const ny = arr.shape[rank - 2];
      const nx = arr.shape[rank - 1];
      pointIdx = [Math.floor(ny / 2), Math.floor(nx / 2)];
    }
    const sel = buildSlice(rank, spatialDimCount, pointIdx);
    console.log(`  slice (estilo nautilus): ${JSON.stringify(sel)}  → ponto ${JSON.stringify(pointIdx)}\n`);

    const cold = await measure(timing, probe, () => arr.get(sel, ro));
    const warmDisk = await measure(timing, probe, () => arr.get(sel, ro));
    const mem = new MemoryCache({ maxBytes: 512 * 1024 * 1024 });
    const roMem: ReadOptions = { ...ro, memoryCache: mem };
    await measure(timing, probe, () => arr.get(sel, roMem)); // popula
    const warmMem = await measure(timing, probe, () => arr.get(sel, roMem));

    const returnedBytes = Math.max(1, cold.returned * 4);
    const overRead = Math.round((cold.bytes + cold.decodedBytes) / returnedBytes);

    console.log("  ── resultado (1 consulta de ponto) ────────────────────────────────");
    console.log(`  série devolvida ............ ${cold.returned} valores (${mib(returnedBytes)})`);
    console.log(`  FRIO (S3 + decode) ......... ${fmt(cold.ms).padStart(8)}  | ${cold.gets} GET ${mib(cold.bytes)} baixados | decode ${cold.decodes}× ${mib(cold.decodedBytes)} em ${fmt(cold.decodeMs)}`);
    console.log(`  quente disco (só decode) ... ${fmt(warmDisk.ms).padStart(8)}  | ${warmDisk.gets} GET | decode ${warmDisk.decodes}× ${mib(warmDisk.decodedBytes)} em ${fmt(warmDisk.decodeMs)}  ← pago a CADA request (nautilus não passa memoryCache)`);
    console.log(`  quente memória (nada) ...... ${fmt(warmMem.ms).padStart(8)}  | ${warmMem.gets} GET | decode ${warmMem.decodes}×`);
    console.log(`\n  → OVER-READ RATIO = ${overRead.toLocaleString()}×  (bytes movidos+decodificados ÷ bytes úteis)\n`);
  } finally {
    await rm(diskDir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
