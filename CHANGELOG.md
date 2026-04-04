# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Zarr v2 array reader with `FileSystemStore`, `HTTPStore`, and `S3Store` backends
- Consolidated metadata (`.zmetadata`) support for fast group discovery
- Disk chunk cache with thundering herd protection and LRU eviction
- Built-in Blosc codec (lz4, zstd, zlib, snappy) with zero-config auto-registration
- In-memory LRU chunk cache for sub-millisecond repeated reads
- Multi-array reads with shared concurrency pool (`readMultiple`)
- Byte-range requests for partial chunk fetches on all store backends
- Reference filesystem (kerchunk) support via `ReferenceStore`
- `Dataset` class with xarray-style label-based coordinate selection (`sel()`)
