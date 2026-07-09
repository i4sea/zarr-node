"""Generate Zarr v2 test fixtures for zarr-node.

Requires: pip install zarr numpy numcodecs
Run from repo root: python tests/fixtures/generate.py
"""

import json
import os
import numpy as np
import zarr
import numcodecs


def save_expected(path: str, data: np.ndarray, dtype_name: str | None = None) -> None:
    """Save expected values as JSON for test verification.

    Schema is shared by v2 and v3 fixtures: {shape, dtype, data}. For v3
    fixtures pass dtype_name (the v3 data_type name, e.g. "float32") so tests
    can assert the reader surfaces v3 names instead of numpy typestrs.
    """
    expected = {
        "shape": list(data.shape),
        "dtype": dtype_name if dtype_name is not None else data.dtype.str,
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


def generate_v2_filtered(base: str) -> None:
    """v2 array declaring a non-null `filters` entry (FR-009: filters are now
    applied on decode). Uses Zlib as the filter (bytes→bytes, registered in
    the reader) with no compressor, so decode succeeds only if the filter runs.
    """
    path = os.path.join(base, "v2_filtered")
    data = np.arange(300, dtype="<i4").reshape(15, 20)
    z = zarr.open_array(path, mode="w", shape=data.shape, dtype=data.dtype,
                        chunks=(5, 10), compressor=None,
                        filters=[numcodecs.Zlib(level=1)], zarr_format=2)
    z[:] = data
    save_expected(path, data)
    print(f"  v2_filtered: shape={data.shape}, dtype={data.dtype}, filters=[zlib]")


def generate_f_order(base: str) -> None:
    path = os.path.join(base, "f_order")
    data = np.arange(12, dtype="<f4").reshape(3, 4)
    z = zarr.open_array(path, mode="w", shape=data.shape, dtype=data.dtype,
                        chunks=(3, 4), compressor=None, order="F",
                        zarr_format=2)
    z[:] = data
    save_expected(path, data)
    print(f"  f_order: shape={data.shape}, dtype={data.dtype}, order=F")


# --- Zarr v3 fixtures (zarr_format=3, requires zarr-python >= 3) ---


def v3_dtype_name(dtype) -> str:
    """Map a numpy dtype to its Zarr v3 data_type name (e.g. <f4 -> float32)."""
    dt = np.dtype(dtype)
    if dt.kind == "b":
        return "bool"
    prefix = {"i": "int", "u": "uint", "f": "float"}[dt.kind]
    return f"{prefix}{dt.itemsize * 8}"


def write_v3_array(path: str, data: np.ndarray, chunks, **kwargs):
    """Write a v3 array (zarr.json + c/... chunk keys) and its expected.json.

    Extra kwargs go straight to zarr.create_array (compressors, serializer,
    filters, shards, fill_value, chunk_key_encoding, ...).
    """
    z = zarr.create_array(store=path, shape=data.shape, dtype=data.dtype,
                          chunks=chunks, zarr_format=3, overwrite=True,
                          **kwargs)
    z[:] = data
    save_expected(path, data, dtype_name=v3_dtype_name(data.dtype))
    return z


def generate_v3_simple_1d(base: str) -> None:
    path = os.path.join(base, "v3_simple_1d")
    data = np.arange(10, dtype="<f4")
    write_v3_array(path, data, chunks=(10,))
    print(f"  v3_simple_1d: shape={data.shape}, dtype={v3_dtype_name(data.dtype)}")


def generate_v3_chunked_2d(base: str) -> None:
    path = os.path.join(base, "v3_chunked_2d")
    data = np.arange(20000, dtype="<i4").reshape(100, 200)
    write_v3_array(path, data, chunks=(10, 20))
    print(f"  v3_chunked_2d: shape={data.shape}, dtype={v3_dtype_name(data.dtype)}")


def generate_v3_uncompressed_2d(base: str) -> None:
    path = os.path.join(base, "v3_uncompressed_2d")
    data = np.random.RandomState(7).standard_normal((20, 30)).astype("<f8")
    write_v3_array(path, data, chunks=(10, 10), compressors=None)
    print(f"  v3_uncompressed_2d: shape={data.shape}, dtype={v3_dtype_name(data.dtype)}")


def generate_v3_group(base: str) -> None:
    path = os.path.join(base, "v3_group")
    root = zarr.open_group(path, mode="w", zarr_format=3)
    root.attrs["description"] = "v3 test group"

    grp = root.create_group("sub")
    grp.attrs["depth"] = 1

    data_a = np.arange(12, dtype="<f4").reshape(3, 4)
    arr_a = root.create_array("data", shape=data_a.shape, dtype=data_a.dtype,
                              chunks=(3, 4))
    arr_a[:] = data_a

    data_b = np.array([10, 20, 30, 40], dtype="<i4")
    arr_b = grp.create_array("inner", shape=data_b.shape, dtype=data_b.dtype,
                             chunks=(4,))
    arr_b[:] = data_b

    expected = {
        "root_attrs": {"description": "v3 test group"},
        "sub_attrs": {"depth": 1},
        "data": {"shape": list(data_a.shape),
                 "dtype": v3_dtype_name(data_a.dtype),
                 "data": data_a.flatten().tolist()},
        "inner": {"shape": list(data_b.shape),
                  "dtype": v3_dtype_name(data_b.dtype),
                  "data": data_b.tolist()},
    }
    with open(os.path.join(path, "expected.json"), "w") as f:
        json.dump(expected, f)
    print("  v3_group: root -> {data, sub/inner}")


if __name__ == "__main__":
    base = os.path.dirname(os.path.abspath(__file__))
    print("Generating Zarr v2 test fixtures...")
    generate_simple_1d(base)
    generate_chunked_2d(base)
    generate_compressed_gzip(base)
    generate_nested_groups(base)
    generate_big_endian(base)
    generate_f_order(base)
    generate_v2_filtered(base)
    print("Generating Zarr v3 test fixtures...")
    generate_v3_simple_1d(base)
    generate_v3_chunked_2d(base)
    generate_v3_uncompressed_2d(base)
    generate_v3_group(base)
    print("Done.")
