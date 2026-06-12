#!/usr/bin/env python3
"""Validate hysteresis magnetization playback artifacts."""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path


def load_json(path: Path):
    return json.loads(path.read_text())


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit(
            "usage: scripts/verify_hysteresis_playback_artifacts.py <artifact-dir>"
        )

    root = Path(sys.argv[1])
    points_path = root / "hysteresis_points.json"
    zarr_root = root / "hysteresis.zarr"
    field_root = zarr_root / "fields" / "m"
    samples_path = field_root / "samples.csv"
    zarray_path = field_root / ".zarray"
    zattrs_path = field_root / ".zattrs"

    required = [
        points_path,
        zarr_root / ".zgroup",
        zarr_root / ".zattrs",
        zarray_path,
        zattrs_path,
        samples_path,
    ]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise SystemExit(
            "missing required hysteresis playback artifacts:\n" + "\n".join(missing)
        )

    points = load_json(points_path)
    if not isinstance(points, list) or not points:
        raise SystemExit("hysteresis_points.json must contain a non-empty point list")

    snapshot_points = [point for point in points if point.get("snapshot_id")]
    if not snapshot_points:
        raise SystemExit("no hysteresis points contain snapshot_id values")

    zattrs = load_json(zattrs_path)
    zarray = load_json(zarray_path)

    expected_axes = ["point", "component", "spatial_sample"]
    if zattrs.get("axes") != expected_axes:
        raise SystemExit(
            f"invalid Zarr axes: got {zattrs.get('axes')!r}, expected {expected_axes!r}"
        )
    if zattrs.get("quantity_id") != "m":
        raise SystemExit(f"invalid Zarr quantity_id: {zattrs.get('quantity_id')!r}")
    if zattrs.get("storage_layout") != "soa_component_major":
        raise SystemExit(
            f"invalid Zarr storage_layout: {zattrs.get('storage_layout')!r}"
        )

    shape = zarray.get("shape")
    chunks = zarray.get("chunks")
    if not (
        isinstance(shape, list)
        and len(shape) == 3
        and isinstance(chunks, list)
        and len(chunks) == 3
    ):
        raise SystemExit(f"invalid Zarr shape/chunks metadata: {shape!r} {chunks!r}")
    if shape[1] != 3 or chunks[0] != 1 or chunks[1] != 3:
        raise SystemExit(f"unexpected Zarr vector layout: shape={shape!r} chunks={chunks!r}")
    if zarray.get("dtype") != "<f8":
        raise SystemExit(f"unexpected Zarr dtype: {zarray.get('dtype')!r}")

    with samples_path.open(newline="") as handle:
        samples = list(csv.DictReader(handle))
    if len(samples) != len(snapshot_points):
        raise SystemExit(
            f"sample count mismatch: samples.csv has {len(samples)}, "
            f"hysteresis_points.json has {len(snapshot_points)} snapshot points"
        )
    if shape[0] != len(samples):
        raise SystemExit(
            f"Zarr point axis mismatch: shape[0]={shape[0]}, samples={len(samples)}"
        )

    rows_by_snapshot = {row.get("snapshot_id"): row for row in samples}
    missing_rows = [
        point["snapshot_id"]
        for point in snapshot_points
        if point.get("snapshot_id") not in rows_by_snapshot
    ]
    if missing_rows:
        raise SystemExit(
            "missing Zarr sample rows for snapshot ids:\n" + "\n".join(missing_rows)
        )

    for point in snapshot_points:
        snapshot_id = point["snapshot_id"]
        row = rows_by_snapshot[snapshot_id]
        chunk_key = row.get("chunk_key")
        chunk_path = field_root / str(chunk_key)
        if not chunk_path.is_file():
            raise SystemExit(f"missing Zarr chunk for {snapshot_id}: {chunk_path}")
        cell_count = int(row.get("cell_count", "0"))
        expected_bytes = cell_count * 3 * 8
        actual_bytes = chunk_path.stat().st_size
        if actual_bytes != expected_bytes:
            raise SystemExit(
                f"invalid chunk size for {snapshot_id}: got {actual_bytes}, "
                f"expected {expected_bytes}"
            )
        fallback = root / "hysteresis_snapshots" / snapshot_id / "m.json"
        if not fallback.is_file():
            raise SystemExit(f"missing compatibility m.json fallback: {fallback}")

    print(
        f"validated hysteresis playback: points={len(points)} "
        f"snapshots={len(snapshot_points)} cell_count={shape[2]} container=zarr"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
