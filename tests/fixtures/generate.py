"""Generate Zarr v2 test fixtures for zarr-node.

Requires: pip install zarr numpy numcodecs
Run from repo root: python tests/fixtures/generate.py
"""

import json
import os
import numpy as np
import zarr
import numcodecs


def save_expected(path: str, data: np.ndarray) -> None:
    """Save expected values as JSON for test verification."""
    expected = {
        "shape": list(data.shape),
        "dtype": data.dtype.str,
        "data": data.flatten().tolist(),
    }
    with open(os.path.join(path, "expected.json"), "w") as f:
        json.dump(expected, f)


def generate_simple_1d(base: str) -> None:
    path = os.path.join(base, "simple_1d")
    data = np.arange(10, dtype="<f4")
    z = zarr.open_array(path, mode="w", shape=data.shape, dtype=data.dtype,
                        chunks=(10,), compressor=None, zarr_format=2)
    z[:] = data
    save_expected(path, data)
    print(f"  simple_1d: shape={data.shape}, dtype={data.dtype}")


def generate_chunked_2d(base: str) -> None:
    path = os.path.join(base, "chunked_2d")
    data = np.arange(20000, dtype="<i4").reshape(100, 200)
    z = zarr.open_array(path, mode="w", shape=data.shape, dtype=data.dtype,
                        chunks=(10, 20), compressor=None, zarr_format=2)
    z[:] = data
    save_expected(path, data)
    print(f"  chunked_2d: shape={data.shape}, dtype={data.dtype}")


def generate_compressed_gzip(base: str) -> None:
    path = os.path.join(base, "compressed_gzip")
    data = np.random.RandomState(42).standard_normal((50, 100)).astype("<f8")
    compressor = numcodecs.Zlib(level=1)
    z = zarr.open_array(path, mode="w", shape=data.shape, dtype=data.dtype,
                        chunks=(10, 25), compressor=compressor, zarr_format=2)
    z[:] = data
    save_expected(path, data)
    print(f"  compressed_gzip: shape={data.shape}, dtype={data.dtype}")


def generate_nested_groups(base: str) -> None:
    path = os.path.join(base, "nested_groups")
    root = zarr.open_group(path, mode="w", zarr_format=2)
    root.attrs["description"] = "Test nested groups"

    grp = root.create_group("level1")
    grp.attrs["depth"] = 1

    data_a = np.array([1.0, 2.0, 3.0], dtype="<f4")
    arr = grp.create_array("array_a", shape=data_a.shape, dtype=data_a.dtype,
                           chunks=(3,), compressor=None)
    arr[:] = data_a

    sub = grp.create_group("level2")
    sub.attrs["depth"] = 2

    data_b = np.array([10, 20, 30, 40], dtype="<i4")
    arr_b = sub.create_array("array_b", shape=data_b.shape, dtype=data_b.dtype,
                             chunks=(4,), compressor=None)
    arr_b[:] = data_b

    expected = {
        "root_attrs": {"description": "Test nested groups"},
        "level1_attrs": {"depth": 1},
        "level2_attrs": {"depth": 2},
        "array_a": {"shape": list(data_a.shape), "dtype": data_a.dtype.str,
                     "data": data_a.tolist()},
        "array_b": {"shape": list(data_b.shape), "dtype": data_b.dtype.str,
                     "data": data_b.tolist()},
    }
    with open(os.path.join(path, "expected.json"), "w") as f:
        json.dump(expected, f)
    print(f"  nested_groups: root -> level1 -> level2 with arrays")


def generate_big_endian(base: str) -> None:
    path = os.path.join(base, "big_endian")
    data = np.array([1.1, 2.2, 3.3, 4.4, 5.5], dtype=">f8")
    z = zarr.open_array(path, mode="w", shape=data.shape, dtype=data.dtype,
                        chunks=(5,), compressor=None, zarr_format=2)
    z[:] = data
    save_expected(path, data)
    print(f"  big_endian: shape={data.shape}, dtype={data.dtype}")


def generate_f_order(base: str) -> None:
    path = os.path.join(base, "f_order")
    data = np.arange(12, dtype="<f4").reshape(3, 4)
    z = zarr.open_array(path, mode="w", shape=data.shape, dtype=data.dtype,
                        chunks=(3, 4), compressor=None, order="F",
                        zarr_format=2)
    z[:] = data
    save_expected(path, data)
    print(f"  f_order: shape={data.shape}, dtype={data.dtype}, order=F")


if __name__ == "__main__":
    base = os.path.dirname(os.path.abspath(__file__))
    print("Generating Zarr v2 test fixtures...")
    generate_simple_1d(base)
    generate_chunked_2d(base)
    generate_compressed_gzip(base)
    generate_nested_groups(base)
    generate_big_endian(base)
    generate_f_order(base)
    print("Done.")
