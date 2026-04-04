# zarr-node Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-04-04

## Active Technologies
- TypeScript 5.x with `strict: true`, targeting ES2022 + None new — uses existing Store interface and metadata parser (002-consolidated-metadata)
- N/A (reads `.zmetadata` from existing Store backends) (002-consolidated-metadata)

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
- 002-consolidated-metadata: Added TypeScript 5.x with `strict: true`, targeting ES2022 + None new — uses existing Store interface and metadata parser

- 001-zarr-v2-reader: Added TypeScript 5.x with `strict: true`, targeting ES2022 + `node:zlib` (gzip), `node:fs/promises` (filesystem), native `fetch` (HTTP), `@aws-sdk/client-s3` (S3, peer dependency)

<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->
