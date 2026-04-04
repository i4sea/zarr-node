"""Generate large Zarr v2 fixtures for performance benchmarks.

Run: .venv/bin/python tests/fixtures/generate_large.py
"""

import os
import numpy as np
import zarr

def generate_large_100mb(base: str) -> None:
    """Generate a ~100MB chunked float32 array."""
    path = os.path.join(base, "large_100mb")
    # 100MB of float32 = 25M elements. Shape [5000, 5000] = 25M * 4 bytes = 100MB
    shape = (5000, 5000)
    data = np.random.RandomState(42).standard_normal(shape).astype("<f4")
    z = zarr.open_array(path, mode="w", shape=shape, dtype="<f4",
                        chunks=(500, 500), compressor=None, zarr_format=2)
    z[:] = data
    print(f"  large_100mb: shape={shape}, size={data.nbytes / 1e6:.0f}MB")

def generate_large_1gb(base: str) -> None:
    """Generate a ~1GB chunked float64 array for memory profiling."""
    path = os.path.join(base, "large_1gb")
    # 1GB of float64 ≈ 128M elements. Shape [8192, 16384] ≈ 134M * 8 = 1.07GB
    # Actually let's be more precise: 131072 * 1024 = 134M elements * 8 = 1.07GB
    # Simpler: [16384, 8192] = ~134M * 8 bytes = ~1GB
    shape = (16384, 8192)
    # Don't load full array into memory — write chunk-by-chunk
    z = zarr.open_array(path, mode="w", shape=shape, dtype="<f8",
                        chunks=(1024, 1024), compressor=None, zarr_format=2)
    rng = np.random.RandomState(42)
    for r in range(0, shape[0], 1024):
        for c in range(0, shape[1], 1024):
            r_end = min(r + 1024, shape[0])
            c_end = min(c + 1024, shape[1])
            chunk = rng.standard_normal((r_end - r, c_end - c))
            z[r:r_end, c:c_end] = chunk
    print(f"  large_1gb: shape={shape}, size~={shape[0]*shape[1]*8 / 1e9:.1f}GB")


if __name__ == "__main__":
    base = os.path.dirname(os.path.abspath(__file__))
    print("Generating large fixtures...")
    generate_large_100mb(base)
    generate_large_1gb(base)
    print("Done.")
