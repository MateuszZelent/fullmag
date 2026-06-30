#!/usr/bin/env python3
"""Focused tests for frozen periodic-antidot magnetic-submesh invariants."""

from __future__ import annotations

import json
from pathlib import Path
import tempfile

import numpy as np
import pytest

from fullmag.meshing._gmsh_types import MeshData
from fullmag.meshing.asset_pipeline import _frozen_magnetic_submesh_invariants

from prepare_fmr_frozen_magnetic_submesh import (
    assert_frozen_submesh_invariants_match_previous_report,
    main,
)


def _frozen_mesh() -> MeshData:
    return MeshData(
        nodes=np.asarray(
            [
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            dtype=np.float64,
        ),
        elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
        element_markers=np.asarray([1], dtype=np.int32),
        boundary_faces=np.asarray(
            [
                [0, 1, 2],
                [0, 1, 3],
                [0, 2, 3],
                [1, 2, 3],
            ],
            dtype=np.int32,
        ),
        boundary_markers=np.asarray([10, 10, 10, 10], dtype=np.int32),
        periodic_boundary_pairs=[
            {"pair_id": "x_faces", "marker_a": 21, "marker_b": 22},
        ],
        periodic_node_pairs=[
            {"pair_id": "x_faces", "node_a": 0, "node_b": 1},
        ],
    )


def test_prepare_script_rejects_existing_report_with_periodic_pair_drift() -> None:
    mesh = _frozen_mesh()
    invariants = _frozen_magnetic_submesh_invariants(
        mesh,
        [{"geometry_name": "periodic_film", "marker": 1}],
    )
    invariants["periodic_node_pair_count"] = 2
    invariants["periodic_node_pair_counts_by_id"] = {"x_faces": 2}

    with tempfile.TemporaryDirectory() as tmp_dir:
        report_path = Path(tmp_dir) / "frozen.npz.report.json"
        report_path.write_text(
            json.dumps(
                {
                    "frozen_magnetic_submesh_invariants": invariants,
                }
            ),
            encoding="utf-8",
        )

        with pytest.raises(
            RuntimeError,
            match="inconsistent frozen magnetic submesh.*periodic_node_pair_counts_by_id\\['x_faces'\\] expected 2, got 1",
        ):
            assert_frozen_submesh_invariants_match_previous_report(
                report_path,
                mesh,
                [{"geometry_name": "periodic_film", "marker": 1}],
            )


def test_prepare_script_cached_path_preserves_full_invariant_report(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mesh = _frozen_mesh()

    with tempfile.TemporaryDirectory() as tmp_dir:
        mesh_path = Path(tmp_dir) / "frozen.npz"
        report_path = Path(f"{mesh_path}.report.json")
        mesh.save(mesh_path)
        report_path.write_text(
            json.dumps(
                {
                    "status": "cached",
                    "mesh_source": str(mesh_path),
                    "region_markers": [
                        {"geometry_name": "periodic_film", "marker": 1},
                    ],
                    "baseline_build_report": {
                        "build_mode": "conformal_occ",
                        "degraded": False,
                    },
                }
            ),
            encoding="utf-8",
        )

        monkeypatch.setattr(
            "sys.argv",
            [
                "prepare_fmr_frozen_magnetic_submesh.py",
                "--output",
                str(mesh_path),
            ],
        )

        assert main() == 0

        report = json.loads(report_path.read_text(encoding="utf-8"))
        assert report["status"] == "cached"
        assert report["node_count"] == 4
        assert report["periodic_node_pair_count"] == 1
        assert report["periodic_node_pair_counts_by_id"] == {"x_faces": 1}
        assert report["baseline_build_report"] == {
            "build_mode": "conformal_occ",
            "degraded": False,
        }
        assert report["frozen_magnetic_submesh_invariants"]["node_count"] == 4
        assert report["frozen_magnetic_submesh_invariants"][
            "periodic_node_pair_counts_by_id"
        ] == {"x_faces": 1}
