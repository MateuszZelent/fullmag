#!/usr/bin/env python3
"""Convert one MuMax3 OVF2 Binary4 magnetization frame to MMPP Zarr."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
from typing import Mapping

import numpy as np
import zarr


_OVF_BINARY4_MARKER = b"# Begin: Data Binary 4\n"
_OVF_CONTROL_NUMBER = 1234567.0


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _header_values(raw_header: bytes) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in raw_header.decode("ascii", "strict").splitlines():
        if not line.startswith("#") or ":" not in line:
            continue
        key, value = line[1:].split(":", 1)
        values[key.strip().lower()] = value.strip()
    return values


def _required_float(values: Mapping[str, str], key: str) -> float:
    try:
        result = float(values[key])
    except (KeyError, ValueError) as exc:
        raise ValueError(f"OVF2 header is missing finite {key}") from exc
    if not np.isfinite(result):
        raise ValueError(f"OVF2 header {key} is not finite")
    return result


def _read_ovf2_binary4(source: Path) -> tuple[np.ndarray, dict[str, object]]:
    raw = source.read_bytes()
    marker_offset = raw.find(_OVF_BINARY4_MARKER)
    if marker_offset < 0:
        raise ValueError("expected an OVF2 Binary4 magnetization frame")
    header = _header_values(raw[:marker_offset])
    try:
        nx, ny, nz = (int(header[f"{axis}nodes"]) for axis in "xyz")
    except (KeyError, ValueError) as exc:
        raise ValueError("OVF2 header must declare xnodes, ynodes, and znodes") from exc
    if min(nx, ny, nz) <= 0:
        raise ValueError("OVF2 node counts must be positive")
    steps = tuple(_required_float(header, f"{axis}stepsize") for axis in "xyz")
    bounds_min = tuple(_required_float(header, f"{axis}min") for axis in "xyz")
    bounds_max = tuple(_required_float(header, f"{axis}max") for axis in "xyz")
    if any(step <= 0.0 for step in steps) or any(
        upper <= lower for lower, upper in zip(bounds_min, bounds_max)
    ):
        raise ValueError("OVF2 cell sizes and bounds must be positive")

    payload = raw[marker_offset + len(_OVF_BINARY4_MARKER) :]
    value_count = nx * ny * nz * 3
    expected_bytes = 4 + value_count * 4
    if len(payload) < expected_bytes:
        raise ValueError("truncated OVF2 Binary4 payload")
    control = np.frombuffer(payload[:4], dtype="<f4")[0]
    byte_order = "<"
    if not np.isclose(control, _OVF_CONTROL_NUMBER, rtol=0.0, atol=0.5):
        control = np.frombuffer(payload[:4], dtype=">f4")[0]
        byte_order = ">"
    if not np.isclose(control, _OVF_CONTROL_NUMBER, rtol=0.0, atol=0.5):
        raise ValueError(f"unexpected OVF2 byte-order check value {control!r}")
    frame = np.frombuffer(
        payload[4:expected_bytes],
        dtype=f"{byte_order}f4",
    ).reshape(nz, ny, nx, 3)
    if not np.all(np.isfinite(frame)):
        raise ValueError("MuMax3 magnetization contains non-finite values")
    if np.max(np.linalg.norm(frame, axis=-1)) > 1.0 + 1.0e-5:
        raise ValueError("MuMax3 frame is not reduced magnetization")
    extents = tuple(bounds_max[index] - bounds_min[index] for index in range(3))
    # MuMax3's rectangular OVF coordinates commonly run from zero to the
    # extent, while Fullmag's canonical geometry is centered at the origin.
    # Publish the recentered physical bounds and retain the raw OVF bounds as
    # provenance instead of silently comparing translated textures.
    metadata: dict[str, object] = {
        "Nx": nx,
        "Ny": ny,
        "Nz": nz,
        "Tx": extents[0],
        "Ty": extents[1],
        "Tz": extents[2],
        "cell_size_xyz": list(steps),
        "bounds_min_xyz": [-0.5 * extent for extent in extents],
        "bounds_max_xyz": [0.5 * extent for extent in extents],
        "origin_xyz": [0.0, 0.0, 0.0],
        "source_bounds_min_xyz": list(bounds_min),
        "source_bounds_max_xyz": list(bounds_max),
        "coordinate_transform": "recenter_ovf_bounds_at_origin",
    }
    return frame, metadata


def convert(source: str | Path, target: str | Path) -> Path:
    """Convert one final MuMax3 ``save(m)`` OVF to a single-frame Zarr store."""

    source_path = Path(source)
    target_path = Path(target)
    frame, metadata = _read_ovf2_binary4(source_path)
    target_path.parent.mkdir(parents=True, exist_ok=True)
    root = zarr.open_group(str(target_path), mode="w")
    root.attrs.update(
        {
            **metadata,
            "solver": "mumax3",
            "axis_order": "tzyxc",
            "component_order": ["x", "y", "z"],
            "t": [0.0],
            "source_ovf": str(source_path),
            "source_ovf_sha256": _sha256(source_path),
            "value_units": "reduced magnetization",
        }
    )
    root.create_dataset(
        "m",
        data=frame[np.newaxis, ...],
        shape=(1, *frame.shape),
        chunks=(1, 1, frame.shape[1], frame.shape[2], 3),
    )
    return target_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Convert one MuMax3 OVF2 Binary4 save(m) frame to MMPP Zarr."
    )
    parser.add_argument("source", type=Path, help="MuMax3 .ovf written by save(m)")
    parser.add_argument("target", type=Path, help="destination .zarr directory")
    args = parser.parse_args(argv)
    convert(args.source, args.target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
