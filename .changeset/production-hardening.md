---
"@i4sea/zarr-node": minor
---

Production hardening: shared pluggable metadata cache (in-memory + Redis adapter at `@i4sea/zarr-node/redis`), per-instance observability hooks across all layers, broadened retry policy with full-jitter backoff and explicit S3 timeouts, missing-chunk notification + opt-in `strict` mode (`MissingChunkError`), and an unbounded disk-cache warning. The unbounded-cache warning is a new warning, not a behavior break. The disk-cache fallback identity for unrecognized stores changed (no longer `store-${Date.now()}`), which cache-busts those disk caches on deploy — they were already non-reusable across restarts; S3/HTTP-backed caches are unaffected.
