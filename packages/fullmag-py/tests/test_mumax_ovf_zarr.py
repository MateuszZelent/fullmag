from __future__ import annotations

import importlib.util
from pathlib import Path
import struct

import numpy as np
import pytest


def _converter_module():
    path = Path(__file__).parents[3] / "scripts" / "convert_mumax_ovf_to_zarr.py"
    spec = importlib.util.spec_from_file_location("convert_mumax_ovf_to_zarr", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_mumax_ovf2_binary4_conversion_preserves_tzyxc(tmp_path: Path) -> None:
    zarr = pytest.importorskip("zarr")
    converter = _converter_module()
    source = tmp_path / "m000000.ovf"
    target = tmp_path / "m.zarr"
    nx, ny, nz = 3, 2, 1
    values = np.zeros((nz, ny, nx, 3), dtype=np.float32)
    values[..., 0] = 0.9
    values[:, :, :, 1] = np.arange(nx, dtype=np.float32)[None, None, :] / 12.0
    header = "\n".join(
        [
            "# OOMMF OVF 2.0",
            "# Begin: Segment",
            "# Begin: Header",
            "# meshtype: rectangular",
            f"# xnodes: {nx}",
            f"# ynodes: {ny}",
            f"# znodes: {nz}",
            "# xstepsize: 2e-9",
            "# ystepsize: 3e-9",
            "# zstepsize: 4e-9",
            "# xmin: -3e-9",
            "# xmax: 3e-9",
            "# ymin: -3e-9",
            "# ymax: 3e-9",
            "# zmin: -2e-9",
            "# zmax: 2e-9",
            "# End: Header",
            "# End: Segment",
            "# Begin: Data Binary 4",
        ]
    ).encode("ascii") + b"\n"
    source.write_bytes(header + struct.pack("<f", 1234567.0) + values.tobytes())

    converter.convert(source, target)

    root = zarr.open(str(target), mode="r")
    assert root["m"].shape == (1, nz, ny, nx, 3)
    np.testing.assert_allclose(root["m"][0], values)
    assert root.attrs["axis_order"] == "tzyxc"
    assert root.attrs["component_order"] == ["x", "y", "z"]
    assert root.attrs["Nx"] == nx
    assert root.attrs["Ny"] == ny
    assert root.attrs["Nz"] == nz
    np.testing.assert_allclose(root.attrs["bounds_min_xyz"], [-3e-9, -3e-9, -2e-9])
    np.testing.assert_allclose(root.attrs["bounds_max_xyz"], [3e-9, 3e-9, 2e-9])
