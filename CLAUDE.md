# zarr-node Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-07-13

## Active Technologies
- TypeScript 5.x with `strict: true`, targeting ES2022 + None new — uses existing Store interface and metadata parser (002-consolidated-metadata)
- N/A (reads `.zmetadata` from existing Store backends) (002-consolidated-metadata)
- TypeScript 5.x with `strict: true`, targeting ES2022 + `node:fs/promises` (cache I/O), `node:path` (key mapping), `node:crypto` (store identity hash) (003-disk-chunk-cache)
- Local filesystem for cached chunks (003-disk-chunk-cache)
- TypeScript 5.x with `strict: true`, targeting ES2022 + `numcodecs` (Blosc), `node:fs/promises`, `node:crypto`, `node:path` (004-performance-ecosystem)
- Local filesystem (cache), remote stores (S3, HTTP) (004-performance-ecosystem)
- TypeScript 5.x (`strict: true`), targeting ES2022, ESM-only + `numcodecs` (Blosc, runtime), `@aws-sdk/client-s3` (optional peer), `ioredis` (NEW optional peer for the Redis adapter); Node built-ins `node:fs/promises`, `node:crypto`, `node:path`, `node:zlib`, native `fetch` (005-production-hardening)
- Local filesystem (disk chunk cache), remote stores (S3, HTTP), optional Redis (shared metadata cache) (005-production-hardening)
- TypeScript 5.x (`strict: true`), targeting ES2022, ESM-only + None new. Reuses in-repo `ZarrArray.get` (block reads), `MemoryCache` (chunk reuse), `GridIndex` (2-D curvilinear lookup), `ReadOptions`/`ObservabilityHooks`, `SliceError`. Node built-ins only. (007-polygon-reader)
- N/A (reads through existing `Store` backends — FS/HTTP/S3; no new backend) (007-polygon-reader)

- TypeScript 5.x with `strict: true`, targeting ES2022 + `node:zlib` (gzip), `node:fs/promises` (filesystem), native `fetch` (HTTP), `@aws-sdk/client-s3` (S3, peer dependency) (001-zarr-v2-reader)

## Project Structure

```text
src/
tests/
```

## Commands

npm test && npm run lint

## Code Style

TypeScript 5.x with `strict: true`, targeting ES2022: Follow standard conventions

## Recent Changes
- 007-polygon-reader: Added TypeScript 5.x (`strict: true`), targeting ES2022, ESM-only + None new. Reuses in-repo `ZarrArray.get` (block reads), `MemoryCache` (chunk reuse), `GridIndex` (2-D curvilinear lookup), `ReadOptions`/`ObservabilityHooks`, `SliceError`. Node built-ins only.
- 005-production-hardening: Added TypeScript 5.x (`strict: true`), targeting ES2022, ESM-only + `numcodecs` (Blosc, runtime), `@aws-sdk/client-s3` (optional peer), `ioredis` (NEW optional peer for the Redis adapter); Node built-ins `node:fs/promises`, `node:crypto`, `node:path`, `node:zlib`, native `fetch`
- 004-performance-ecosystem: Added TypeScript 5.x with `strict: true`, targeting ES2022 + `numcodecs` (Blosc), `node:fs/promises`, `node:crypto`, `node:path`


<!-- MANUAL ADDITIONS START -->

## Git conventions

- **Never add `Co-Authored-By: Claude` (or any AI assistant) trailer to commit messages.** Authorship stays with the human committer. This applies to all commits, including ones drafted entirely by an assistant.
- Use conventional commit prefixes (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`).

<!-- MANUAL ADDITIONS END -->
