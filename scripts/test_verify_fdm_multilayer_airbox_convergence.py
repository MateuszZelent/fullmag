from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from verify_fdm_multilayer_airbox_convergence import (
    AirboxConvergenceError,
    compare_airbox_carriers,
)


BUILD_IDENTITY = {
    "built_at_utc": "2026-08-14T00:00:00Z",
    "git_commit": "d" * 40,
    "worktree_state": "dirty",
    "source_snapshot_sha256": "e" * 64,
}


def _write_carrier(root: Path, *, cells: tuple[int, int, int], origin_z: float, values: list[list[float]]) -> Path:
    root.mkdir()
    grid = {
        "cells": list(cells),
        "origin_m": [-0.5e-9, -0.5e-9, origin_z],
        "cell_size_m": [1e-9, 1e-9, 1e-9],
    }
    field = {
        "schema_version": "fdm_multilayer_observation_field.v1",
        "observable": "H_demag",
        "quantity_id": "H_demag",
        "unit": "A/m",
        "scope_kind": "airbox",
        "build_identity": BUILD_IDENTITY,
        "grid": grid,
        "values": values,
    }
    field_path = root / "H_demag.samples.v1.json"
    field_bytes = json.dumps(field, indent=2).encode()
    field_path.write_bytes(field_bytes)
    manifest = {
        "schema_version": "fdm_multilayer_observation.v1",
        "scope_kind": "airbox",
        "quantity_id": "H_demag",
        "unit": "A/m",
        "source_policy": "target_only",
        "target_only": True,
        "grid": grid,
        "padding_cells_above_below": [2, 2],
        "carrier_fingerprint": "f" * 64,
        "source_grid_fingerprints": ["s" * 64],
        "source_common_grid": {"cells": [1, 1, 1], "cell_size_m": [1e-9] * 3, "origin_m": [0.0] * 3},
        "source_runtime_identity": {
            "execution_engine": "cpu_reference_multilayer",
            "precision": "double",
            "demag_operator_kind": "multilayer_convolution",
            "fft_backend": "rust_cpu_fft",
            "run_status": "completed",
            "build_identity": BUILD_IDENTITY,
        },
        "build_identity": BUILD_IDENTITY,
        "field_artifact": field_path.name,
        "field_artifact_sha256": hashlib.sha256(field_bytes).hexdigest(),
        "sample_count": len(values),
        "published_quantities": ["H_demag"],
        "unavailable_quantities": {"H_eff": "fdm_multilayer_airbox_h_eff_unavailable.v1"},
    }
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return root


def test_wider_airbox_compares_all_baseline_centres(tmp_path: Path) -> None:
    baseline = _write_carrier(
        tmp_path / "baseline",
        cells=(1, 1, 2),
        origin_z=-1.5e-9,
        values=[[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]],
    )
    candidate = _write_carrier(
        tmp_path / "candidate",
        cells=(1, 1, 3),
        origin_z=-2.5e-9,
        values=[[0.0, 0.0, 0.0], [1.0, 2.0, 3.0], [4.0, 5.0, 6.0]],
    )
    report = compare_airbox_carriers(baseline, candidate)
    assert report["qualification_status"] == "qualified"
    assert report["common_cell_centres"] == 2
    assert report["candidate_cells"] == [1, 1, 3]


def test_same_mesh_is_not_a_convergence_sweep(tmp_path: Path) -> None:
    values = [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]]
    baseline = _write_carrier(tmp_path / "baseline", cells=(1, 1, 2), origin_z=-1.5e-9, values=values)
    candidate = _write_carrier(tmp_path / "candidate", cells=(1, 1, 2), origin_z=-1.5e-9, values=values)
    with pytest.raises(AirboxConvergenceError, match="candidate_airbox_mesh_not_changed"):
        compare_airbox_carriers(baseline, candidate)
