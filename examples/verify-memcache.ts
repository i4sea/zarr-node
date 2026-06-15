/**
 * Verifica o quick win: um MemoryCache POR DATASET, reusado entre requests
 * (exatamente o que a mudança no nautilus faz — o cache vive no handle).
 *
 * Simula um dataset já aberto e com disk cache QUENTE (estado de produção), e
 * roda várias "requisições" de ponto (mesmo ponto repetido + vizinhos no mesmo
 * chunk 128x128). Compara:
 *   A) SEM memoryCache  → comportamento atual: re-decodifica o chunk a cada request.
 *   B) COM memoryCache  → minha mudança: 1º request decodifica, demais batem no cache.
 *
 * Rodar:
 *   S3_BUCKET=i4sea-zarr S3_REGION=us-east-1 \
 *     S3_PREFIX=oper/data/model/san/san001/wrf/2026061500/forcing_atm_WRF_san1_2026061506.zarr \
 *     DATA_VAR=wind_vel npx tsx examples/verify-memcache.ts
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
const ROUNDS = Number(process.env.ROUNDS ?? "5"); // nº de "requisições" simuladas por ponto

const fmt = (ms: number): string =>
  ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : ms < 1000 ? `${ms.toFixed(1)}ms` : `${(ms / 1000).toFixed(2)}s`;
const mib = (b: number): string => `${(b / 1024 / 1024).toFixed(1)} MiB`;

interface Ev { decodes: number; decodeMs: number; decodedBytes: number }
class Probe {
  ev: Ev = { decodes: 0, decodeMs: 0, decodedBytes: 0 };
  readonly hooks: ObservabilityHooks = {
    onChunkDecoded: (e) => { this.ev.decodes++; this.ev.decodeMs += e.decodeMs; this.ev.decodedBytes += e.bytes; },
  };
  reset(): void { this.ev = { decodes: 0, decodeMs: 0, decodedBytes: 0 }; }
}

function buildSlice(rank: number, spatialDimCount: number, pointIdx: number[]): Slice {
  const sel: Slice = new Array(rank);
  sel[0] = null;
  const spatialStart = rank - spatialDimCount;
  for (let i = 1; i < spatialStart; i++) sel[i] = 0;
  for (let i = 0; i < spatialDimCount; i++) sel[spatialStart + i] = pointIdx[i];
  return sel;
}

async function main(): Promise<void> {
  if (!S3_PREFIX) { console.error("Defina S3_PREFIX."); process.exit(1); }
  console.log(`\n  dataset: s3://${S3_BUCKET}/${S3_PREFIX}`);
  console.log(`  variável: ${DATA_VAR}  | rounds por ponto: ${ROUNDS}\n`);

  const probe = new Probe();
  const ro: ReadOptions = { observability: probe.hooks, concurrency: 50 };
  const diskDir = join(tmpdir(), `zarr-verify-${process.pid}`);
  const s3 = new S3Store({ bucket: S3_BUCKET, prefix: S3_PREFIX, region: S3_REGION, maxSockets: 128 });
  await s3.prewarm().catch(() => {});
  const cached: Store = new CachedStore(s3, { cacheDir: diskDir, storeId: `verify-${process.pid}`, maxSizeBytes: 2 * 1024 ** 3 });

  try {
    const root = await openGroup(cached, "");
    const arr = await root.getArray(DATA_VAR);
    const rank = arr.shape.length;
    const spatialDimCount = rank === 2 ? 1 : 2;

    // Pontos: centro + 2 vizinhos no MESMO chunk 128x128 (deslocados em poucas células).
    const ny = arr.shape[rank - 2];
    const nx = arr.shape[rank - 1];
    const ci = Math.floor(ny / 2);
    const cj = Math.floor(nx / 2);
    const points: number[][] =
      spatialDimCount === 1
        ? [[Math.floor(nx / 2)], [Math.floor(nx / 2) + 1]]
        : [[ci, cj], [ci, cj + 1], [ci + 1, cj]];

    console.log(`  ${DATA_VAR} shape=${JSON.stringify(arr.shape)} chunks=${JSON.stringify(arr.chunks)}`);
    console.log(`  pontos simulados (mesmo chunk): ${JSON.stringify(points)}\n`);

    // Aquece o disk cache (1 leitura por ponto) — daqui pra frente backend=0; só decode.
    for (const p of points) await arr.get(buildSlice(rank, spatialDimCount, p), ro);

    // ── A) SEM memoryCache (produção hoje) ──────────────────────────────────
    probe.reset();
    const tA = performance.now();
    for (let r = 0; r < ROUNDS; r++) {
      for (const p of points) await arr.get(buildSlice(rank, spatialDimCount, p), ro);
    }
    const msA = performance.now() - tA;
    const decA = { ...probe.ev };

    // ── B) COM memoryCache por dataset (minha mudança) ──────────────────────
    const memoryCache = new MemoryCache({ maxBytes: 128 * 1024 * 1024 });
    const roMem: ReadOptions = { ...ro, memoryCache };
    probe.reset();
    const tB = performance.now();
    for (let r = 0; r < ROUNDS; r++) {
      for (const p of points) await arr.get(buildSlice(rank, spatialDimCount, p), roMem);
    }
    const msB = performance.now() - tB;
    const decB = { ...probe.ev };

    const reqs = ROUNDS * points.length;
    console.log("  ── comparação (disk cache quente — backend=0 em ambos) ─────────────");
    console.log(`  requisições simuladas: ${reqs}  (${points.length} pontos × ${ROUNDS} rounds)\n`);
    console.log(`  A) SEM memoryCache (prod hoje)`);
    console.log(`       total ${fmt(msA).padStart(8)}  | por request ${fmt(msA / reqs)}  | decode ${decA.decodes}× ${mib(decA.decodedBytes)} em ${fmt(decA.decodeMs)}`);
    console.log(`  B) COM memoryCache (minha mudança)`);
    console.log(`       total ${fmt(msB).padStart(8)}  | por request ${fmt(msB / reqs)}  | decode ${decB.decodes}× ${mib(decB.decodedBytes)} em ${fmt(decB.decodeMs)}`);
    const speedup = msB > 0 ? msA / msB : 0;
    console.log(`\n  → speedup ${speedup.toFixed(1)}× no wall-clock | decodes ${decA.decodes} → ${decB.decodes} (${mib(decA.decodedBytes)} → ${mib(decB.decodedBytes)} descomprimidos)`);
    console.log(`    Esperado: B decodifica só ${points.length} (1º round); A decodifica ${reqs} (todo request).\n`);
  } finally {
    await rm(diskDir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
