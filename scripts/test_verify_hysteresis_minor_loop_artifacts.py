#!/usr/bin/env python3
"""Unit tests for the minor-loop hysteresis artifact validator."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "verify_hysteresis_minor_loop_artifacts.py"


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload))


def run_validator(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(VALIDATOR), str(root)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def hysteresis_point(
    point_id: int,
    field_value_mT: float,
    *,
    minor_loop_id: str | None = None,
    protocol_role: str = "major_descending",
    include_provenance: bool = True,
    include_snapshot: bool = False,
) -> dict:
    point = {
        "field_value_mT": field_value_mT,
        "m_avg": [0.1 * point_id, 0.0, 0.0],
        "m_ip": 0.1 * point_id,
        "m_oop": 0.0,
        "m_parallel": 0.1 * point_id,
        "point_id": point_id,
        "protocol_role": protocol_role,
        "run_status": "Completed",
        "settle_status": "converged",
        "status": "Completed",
    }
    if minor_loop_id is not None:
        point["minor_loop_id"] = minor_loop_id
    if include_provenance:
        point.update(
            {
                "field_display_unit": "mT",
                "field_orientation": {"kind": "preset", "preset_name": "in_plane_x"},
                "field_vector_A_per_m": [field_value_mT * 795.7747154594767, 0.0, 0.0],
                "measurement_axis": "field_axis",
            }
        )
    if include_snapshot:
        snapshot_id = f"hysteresis_minor_loop_001_return_{point_id:03}"
        point.update(
            {
                "snapshot_id": snapshot_id,
                "snapshot_json_artifact_ref": f"hysteresis_snapshots/{snapshot_id}/m.json",
                "snapshot_resource_ref": (
                    "/v2/sessions/current/data/fields/m/samples/vector"
                    f"?component=full&scope_kind=full&snapshot_id={snapshot_id}"
                ),
                "snapshot_storage_format": "zarr_v2_json_fallback",
                "snapshot_vector_resource_ref": (
                    "/v2/sessions/current/data/fields/m/samples/vector"
                    f"?component=full&scope_kind=full&snapshot_id={snapshot_id}"
                ),
                "snapshot_zarr_store_ref": "hysteresis.zarr",
            }
        )
    return point


def write_minor_loop_fixture(
    root: Path,
    *,
    include_loop_point_provenance: bool = True,
    include_return_snapshot: bool = True,
    contaminate_major_points: bool = False,
) -> None:
    loop_id = "minor_loop_001"
    major_points = [
        hysteresis_point(0, 50.0),
        hysteresis_point(1, 0.0),
        hysteresis_point(2, -50.0),
    ]
    if contaminate_major_points:
        major_points[1]["minor_loop_id"] = loop_id
        major_points[1]["protocol_role"] = "minor"
    write_json(root / "hysteresis_points.json", major_points)
    write_json(
        root / "hysteresis_minor_loops.json",
        [
            {
                "closure_error_m_parallel": 0.2,
                "closure_status": "returned",
                "loop_id": loop_id,
                "minor_loop_area": 3.0,
                "parent_branch_id": "descending",
                "points": [
                    hysteresis_point(
                        0,
                        50.0,
                        minor_loop_id=loop_id,
                        protocol_role="minor",
                        include_provenance=include_loop_point_provenance,
                    ),
                    hysteresis_point(
                        1,
                        -25.0,
                        minor_loop_id=loop_id,
                        protocol_role="minor",
                        include_provenance=include_loop_point_provenance,
                        include_snapshot=include_return_snapshot,
                    ),
                ],
                "policy": "branch_only",
                "recoil_susceptibility": 0.1,
                "return_field_mT": -25.0,
                "return_point_id": 1,
                "reversal_field_mT": 50.0,
                "reversal_point_id": 0,
                "settle_trace": [{"field_value_mT": -25.0, "status": "converged"}],
            }
        ],
    )


def test_minor_loop_validator_accepts_branch_only_fixture(tmp_path: Path) -> None:
    write_minor_loop_fixture(tmp_path)

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout
    assert "validated hysteresis minor loop" in result.stdout


def test_minor_loop_validator_rejects_minor_points_in_major_artifact(tmp_path: Path) -> None:
    write_minor_loop_fixture(tmp_path, contaminate_major_points=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "major-loop point" in (result.stderr + result.stdout)


def test_minor_loop_validator_rejects_branch_point_without_provenance(tmp_path: Path) -> None:
    write_minor_loop_fixture(tmp_path, include_loop_point_provenance=False)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "field_vector_A_per_m" in (result.stderr + result.stdout)


def test_minor_loop_validator_rejects_return_point_without_snapshot(tmp_path: Path) -> None:
    write_minor_loop_fixture(tmp_path, include_return_snapshot=False)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "snapshot_id" in (result.stderr + result.stdout)
