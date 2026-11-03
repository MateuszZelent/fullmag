from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from tests.standard_problems.bimeron.goebel_2019.compare_fem_fdm import (
    compare_bundles,
)


def _write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")


def _make_bundle(
    root: Path,
    backend: str,
    *,
    truncate_mesh: bool = False,
    hold_time_s: float = 100e-12,
) -> Path:
    grid_layout = {
        "backend": "fdm",
        "grid_cells": [3, 3, 1],
        "cell_size": [1e-9, 1e-9, 0.5e-9],
        "origin_m": [-1.5e-9, -1.5e-9, -0.25e-9],
        "active_cell_count": 9,
        "active_mask": None,
    }
    fem_layout = {"backend": "fem", "field_semantics": {"active_node_mask": [True] * 8 + [False]}}
    half_x = 0.5e-9 if truncate_mesh else 1.5e-9
    nodes = [
        [x, y, z]
        for z in (-0.25e-9, 0.25e-9)
        for y in (-1.5e-9, 1.5e-9)
        for x in (-half_x, half_x)
    ]
    tetrahedra = [
        [0, 1, 3, 7], [0, 3, 2, 7], [0, 2, 6, 7],
        [0, 6, 4, 7], [0, 4, 5, 7], [0, 5, 1, 7],
        [1, 3, 8, 7],
    ]
    air_node = [half_x + 1e-9, -1.5e-9, -0.25e-9]
    fem_plan = {
        "fe_order": 1,
        "mesh": {
            "nodes": [*nodes, air_node],
            "cells": {
                "types": ["tet4"] * 7,
                "offsets": list(range(0, 29, 4)),
                "nodes": [node for tet in tetrahedra for node in tet],
                "mesh_parts": ["magnetic"] * 6 + ["transition_air"],
                "global_ordinals": list(range(7)),
            },
            "facets": {"types": [], "roles": [], "offsets": [0], "nodes": []},
            "element_markers": [7] * 6 + [0],
            "boundary_markers": [],
        },
        "material": {"saturation_magnetisation": 0.58e6},
        "demag_realization": "poisson_robin",
    }

    def vector(x: float, y: float) -> list[float]:
        return [0.48, 0.36 * y / 1.5e-9, 0.8 * x / half_x]

    fdm_values = np.asarray(
        [vector(x, y) for y in (-1e-9, 0.0, 1e-9) for x in (-1e-9, 0.0, 1e-9)]
    )
    fdm_values /= np.linalg.norm(fdm_values, axis=1)[:, None]
    values = fdm_values.tolist() if backend == "fdm" else [
        vector(x, y) for x, y, _ in nodes
    ] + [[0.0, 0.0, 0.0]]
    layout = grid_layout if backend == "fdm" else fem_layout
    engine = "cuda_fdm" if backend == "fdm" else "fem_cpu_native"
    for directory, stage_id, start_s, end_s in (
        ("stage_00_flat_relax", "relax", 0.0, 20e-12),
        ("stage_02_flat_run", "hold", 20e-12, hold_time_s),
    ):
        stage = root / "stages" / directory
        stage.mkdir(parents=True)
        plan = {**(fem_plan if backend == "fem" else {}),
                "time_stage": {"active_stage_id": stage_id, "start_time_s": start_s}}
        _write_json(stage / "metadata.json", {
            "status": "completed",
            "pbc": {
                "axes": ["periodic", "open", "open"],
                "demag": "periodic_airbox_k0" if backend == "fem" else "truncated_images",
            },
            "execution_plan": {"backend_plan": plan},
            "execution_provenance": {"execution_engine": engine},
        })
        snapshot_end_s = end_s + start_s if backend == "fem" else end_s
        for name, step, time_s in (("m_initial.json", 0, 0.0), ("m_final.json", 8, snapshot_end_s)):
            _write_json(stage / name, {"layout": layout, "step": step, "time": time_s,
                                      "observable": "m", "values": values})
    return root


def test_compares_both_stages_using_the_fdm_midplane(tmp_path: Path) -> None:
    result = compare_bundles(
        fem_bundle=_make_bundle(tmp_path / "fem", "fem"),
        fdm_bundle=_make_bundle(tmp_path / "fdm", "fdm"),
    )

    assert result["grid"]["midplane_z_m"] == 0.0
    for stage in result["stages"].values():
        assert stage["sampling"]["valid_voxel_count"] == 9
        assert stage["sampling"]["raw_norm_min"] == pytest.approx(0.48)
        assert stage["sampling"]["magnetic_markers"] == [7]
        assert stage["fem"]["metrics"]["core_separation_m"] == pytest.approx(1e-9)
        assert stage["delta_fem_minus_fdm"]["core_separation_m"] == pytest.approx(0.0)
        assert stage["delta_fem_minus_fdm"]["topological_charge"] == pytest.approx(0.0)
    assert result["stages"]["held"]["fem"]["stage_local_duration_s"] == pytest.approx(100e-12)
    assert result["stages"]["held"]["fem"]["global_end_s"] == pytest.approx(120e-12)


def test_rejects_partial_magnetic_coverage(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="coverage"):
        compare_bundles(
            fem_bundle=_make_bundle(tmp_path / "fem", "fem", truncate_mesh=True),
            fdm_bundle=_make_bundle(tmp_path / "fdm", "fdm"),
        )


def test_rejects_mismatched_physical_time(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="physical timing"):
        compare_bundles(
            fem_bundle=_make_bundle(tmp_path / "fem", "fem", hold_time_s=80e-12),
            fdm_bundle=_make_bundle(tmp_path / "fdm", "fdm"),
        )
