/**
 * Diagnóstico de latência S3 — isola cada fator para encontrar o gargalo.
 *
 * Run: npx tsx examples/benchmark-s3-latency.ts
 */
import { S3Store, CachedStore, MemoryCache, openGroup } from "../src/index.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function fmt(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

async function measure<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t0 = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - t0 };
}

async function main() {
  const s3 = new S3Store({
    bucket: "teste-zarr",
    prefix: "wrf_sse1_complete.zarr",
    region: "us-east-1",
  });

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  Diagnóstico de latência S3                        ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  const root = await openGroup(s3);
  const wind = await root.getArray("wind_speed_at_10m_agl");
  // wind: [49, 761, 602], chunks=[49, 16, 16]
  // full field = ceil(761/16) * ceil(602/16) = 48 * 38 = 1824 chunks

  const totalChunks = Math.ceil(wind.shape[1] / wind.chunks[1]) * Math.ceil(wind.shape[2] / wind.chunks[2]);
  console.log(`  Grid: ${wind.shape[1]}×${wind.shape[2]}`);
  console.log(`  Chunks: ${wind.chunks[1]}×${wind.chunks[2]}`);
  console.log(`  Total chunks por timestep: ${totalChunks}`);
  console.log();

  // ── 1. Latência de um request S3 isolado ──
  console.log("── 1. Latência de 1 request S3 (10 amostras) ──\n");
  const latencies: number[] = [];
  for (let i = 0; i < 10; i++) {
    // Different chunk each time to avoid any caching
    const key = `wind_speed_at_10m_agl/0.${i}.${i}`;
    const { ms } = await measure(() => s3.get(key));
    latencies.push(ms);
    process.stdout.write(`  ${fmt(ms)}  `);
  }
  console.log();
  latencies.sort((a, b) => a - b);
  const p50 = latencies[4];
  const p95 = latencies[8];
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  console.log(`  p50=${fmt(p50)}  p95=${fmt(p95)}  avg=${fmt(avg)}\n`);

  // ── 2. Impacto da concorrência ──
  console.log("── 2. Full field (1 timestep) por nível de concorrência ──\n");

  const concurrencyLevels = [5, 10, 25, 50, 100, 200];

  for (const c of concurrencyLevels) {
    const { ms } = await measure(() => wind.get([0, null, null], { concurrency: c }));
    const reqPerSec = totalChunks / (ms / 1000);
    const effective = ms / totalChunks;
    console.log(
      `  concurrency=${String(c).padStart(3)}  ${fmt(ms).padStart(8)}  ` +
      `${reqPerSec.toFixed(0).padStart(5)} req/s  ` +
      `${fmt(effective).padStart(6)}/chunk`,
    );
  }

  // ── 3. Time series (1 chunk por timestep) ──
  console.log("\n── 3. Time series — 1 chunk (já quente na conexão) ──\n");

  // Single chunk covering all 49 timesteps — exactly 1 S3 request
  const { ms: ts1 } = await measure(() =>
    wind.get([null, [0, 1], [0, 1]]),
  );
  console.log(`  1 chunk (49 timesteps): ${fmt(ts1)}`);

  // 4 chunks (different lat/lon points)
  const { ms: ts4 } = await measure(async () => {
    await Promise.all([
      wind.get([null, [0, 1], [0, 1]]),
      wind.get([null, [100, 101], [100, 101]]),
      wind.get([null, [300, 301], [300, 301]]),
      wind.get([null, [500, 501], [500, 501]]),
    ]);
  });
  console.log(`  4 chunks paralelo:     ${fmt(ts4)} (${fmt(ts4 / 4)}/chunk)`);

  // ── 4. Impacto do tamanho do chunk ──
  console.log("\n── 4. Payload por chunk ──\n");

  // Each chunk is 49 * 16 * 16 * 4 bytes = 200,704 bytes ≈ 196 KB
  const chunkBytes = wind.chunks.reduce((a, b) => a * b, 1) * 4;
  const totalBytesField = totalChunks * chunkBytes;
  console.log(`  Chunk size:   ${(chunkBytes / 1024).toFixed(0)} KB (${wind.chunks.join("×")} × 4 bytes)`);
  console.log(`  Field total:  ${(totalBytesField / 1024 / 1024).toFixed(0)} MB (${totalChunks} chunks)`);
  console.log(`  S3 overhead:  ~${fmt(avg)} latência por request`);
  console.log(`  Tempo ideal (c=∞): ${fmt(avg)} (pipeline 100% paralelo)`);
  console.log(`  Tempo com c=10:    ${fmt(avg * totalChunks / 10)} (estimado)`);
  console.log(`  Tempo com c=100:   ${fmt(avg * totalChunks / 100)} (estimado)`);

  console.log("\n══════════════════════════════════════════════════════");
  console.log("  RECOMENDAÇÕES");
  console.log("══════════════════════════════════════════════════════\n");
  console.log("  1. Aumentar concurrency (default=10 → 50-100 para S3)");
  console.log("  2. DiskCache elimina S3 após primeiro acesso (159x speedup)");
  console.log("  3. MemoryCache para leituras repetidas (1000x+ speedup)");
  console.log("  4. Chunks maiores = menos requests (rechunk se possível)");
  console.log("  5. Rodar compute na mesma região do bucket S3");
  console.log("  6. S3 Express One Zone para latência <10ms\n");
}

main().catch(console.error);
