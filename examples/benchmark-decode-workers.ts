/**
 * A/B do offload de descompressão (issue #5).
 *
 * Lê a mesma variável Blosc do dataset duas vezes — SEM e COM `decodeWorkers`
 * (DecodePool) — e compara: total de `decodeMs` (via hook onChunkDecoded), p95
 * por chunk e o *event-loop lag* durante o read (perf_hooks). É o gate da #5:
 * rode contra um dataset de produção e registre os números na issue.
 *
 * IMPORTANTE: importa de ../dist (o worker compilado precisa existir), então
 * rode `npm run build` antes:
 *
 *   npm run build && ZARR_LOCAL_PATH=/caminho/dataset.zarr DATA_VAR=wind_vel \
 *     npx tsx examples/benchmark-decode-workers.ts
 *
 * Variáveis: ZARR_LOCAL_PATH, DATA_VAR, POOL_SIZE, MIN_BYTES, CONCURRENCY.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import {
  FileSystemStore,
  open,
  ZarrGroup,
  DecodePool,
  type ObservabilityHooks,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR =
  process.env.ZARR_LOCAL_PATH ?? resolve(__dirname, "..", ".bench", "wrf.zarr");
const DATA_VAR = process.env.DATA_VAR ?? "wind_vel";
const POOL_SIZE = process.env.POOL_SIZE ? Number(process.env.POOL_SIZE) : undefined;
const MIN_BYTES = process.env.MIN_BYTES ? Number(process.env.MIN_BYTES) : 0;
const CONCURRENCY = process.env.CONCURRENCY ? Number(process.env.CONCURRENCY) : 50;

const fmt = (ms: number) => `${ms.toFixed(1)}ms`;
const p95 = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
};

interface Sample {
  decodes: number;
  decodeMsTotal: number;
  perChunk: number[];
  codec: string | null;
  wallMs: number;
  loopLagMaxMs: number;
  loopLagMeanMs: number;
}

async function measure(useWorkers: boolean): Promise<Sample> {
  const store = new FileSystemStore({ path: DATA_DIR });
  const grp = await open(store);
  if (!(grp instanceof ZarrGroup)) {
    throw new Error("Dataset raiz não é um grupo Zarr");
  }
  const arr = await grp.getArray(DATA_VAR);

  const perChunk: number[] = [];
  let decodes = 0;
  let decodeMsTotal = 0;
  let codec: string | null = null;
  const hooks: ObservabilityHooks = {
    onChunkDecoded: (e) => {
      decodes++;
      decodeMsTotal += e.decodeMs;
      perChunk.push(e.decodeMs);
      codec = e.codec;
    },
  };

  const pool = useWorkers
    ? new DecodePool({ poolSize: POOL_SIZE, minBytes: MIN_BYTES })
    : undefined;

  // Mede o atraso do event loop DURANTE o read: quanto o loop fica bloqueado.
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  const start = performance.now();
  await arr.get(undefined, {
    concurrency: CONCURRENCY,
    observability: hooks,
    decodeWorkers: pool,
  });
  const wallMs = performance.now() - start;
  h.disable();

  if (pool) await pool.terminate();

  return {
    decodes,
    decodeMsTotal,
    perChunk,
    codec,
    wallMs,
    loopLagMaxMs: h.max / 1e6,
    loopLagMeanMs: h.mean / 1e6,
  };
}

function printRow(label: string, s: Sample): void {
  console.log(
    `  ${label.padEnd(14)} ` +
      `codec=${s.codec ?? "-"} chunks=${s.decodes} ` +
      `decode total=${fmt(s.decodeMsTotal)} p95=${fmt(p95(s.perChunk))} ` +
      `| wall=${fmt(s.wallMs)} ` +
      `| loop-lag mean=${fmt(s.loopLagMeanMs)} max=${fmt(s.loopLagMaxMs)}`,
  );
}

async function main(): Promise<void> {
  console.log(`\nDataset: ${DATA_DIR}  var=${DATA_VAR}`);
  console.log(`concurrency=${CONCURRENCY} minBytes=${MIN_BYTES} poolSize=${POOL_SIZE ?? "auto"}\n`);

  // Aquece o cache de FS/SO para os dois rodarem em igualdade.
  await measure(false);

  const inline = await measure(false);
  const workers = await measure(true);

  printRow("inline", inline);
  printRow("decodeWorkers", workers);

  const lagDrop =
    inline.loopLagMaxMs > 0
      ? (1 - workers.loopLagMaxMs / inline.loopLagMaxMs) * 100
      : 0;
  console.log(
    `\n  → event-loop lag máx: ${fmt(inline.loopLagMaxMs)} → ${fmt(workers.loopLagMaxMs)} ` +
      `(${lagDrop >= 0 ? "-" : "+"}${Math.abs(lagDrop).toFixed(0)}%)`,
  );
  console.log(
    `  → wall-clock: ${fmt(inline.wallMs)} → ${fmt(workers.wallMs)} ` +
      `(inclui overhead de IPC/transfer)\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
