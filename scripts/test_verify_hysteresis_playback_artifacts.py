#!/usr/bin/env python3
"""Unit tests for hysteresis playback artifact validation."""

from __future__ import annotations

import json
import math
import struct
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "verify_hysteresis_playback_artifacts.py"


def write_playback_fixture(
    root: Path,
    *,
    chunk_values: list[float],
    average_weights: list[float] | None = None,
    m_avg: list[float] | None = None,
    zarr_average_weighting: str = "uniform_sample_average",
    snapshot_vector_resource_ref: str | None = None,
) -> None:
    field_root = root / "hysteresis.zarr" / "fields" / "m"
    field_root.mkdir(parents=True)
    (root / "hysteresis_snapshots" / "hysteresis_point_001").mkdir(parents=True)

    snapshot_id = "hysteresis_point_001"
    if snapshot_vector_resource_ref is None:
        snapshot_vector_resource_ref = (
            "/v2/sessions/current/data/fields/m/samples/vector"
            f"?component=full&scope_kind=full&snapshot_id={snapshot_id}&stage_id=stage-000"
        )
    if m_avg is None:
        m_avg = [0.5, 0.5, 0.0]
    expected_m_ip = math.sqrt(m_avg[0] * m_avg[0] + m_avg[1] * m_avg[1])

    (root / "hysteresis_points.json").write_text(
        json.dumps(
            [
                {
                    "point_id": 0,
                    "field_value_mT": 25.0,
                    "m_parallel": 0.5,
                    "m_oop": 0.0,
                    "m_ip": expected_m_ip,
                    "m_avg": m_avg,
                    "status": "Completed",
                    "run_status": "Completed",
                    "settle_status": "converged",
                    "has_non_converged_steps": False,
                    "warning_count": 0,
                    "snapshot_id": snapshot_id,
                    "branch_id": "descending",
                    "protocol_role": "major_descending",
                    "snapshot_storage_format": "zarr_v2_json_fallback",
                    "snapshot_json_artifact_ref": f"hysteresis_snapshots/{snapshot_id}/m.json",
                    "snapshot_zarr_store_ref": "hysteresis.zarr",
                    "snapshot_resource_ref": (
                        "/v2/sessions/current/data/fields/m/samples/vector"
                        f"?component=full&scope_kind=full&snapshot_id={snapshot_id}&stage_id=stage-000"
                    ),
                    "snapshot_vector_resource_ref": snapshot_vector_resource_ref,
                    "field_vector_A_per_m": [19894.367886486918, 0.0, 0.0],
                    "field_orientation": {
                        "kind": "preset",
                        "preset_name": "in_plane_x",
                    },
                    "measurement_axis": "field_axis",
                }
            ]
        )
    )
    (root / "hysteresis.zarr" / ".zgroup").write_text(json.dumps({"zarr_format": 2}))
    root_zattrs = {
        "fullmag_kind": "hysteresis_field_sequence",
        "schema_version": 1,
        "preferred_container": "zarr",
        "quantity_ids": ["m"],
        "point_index_file": "points.csv",
        "magnetization_average_weighting": zarr_average_weighting,
        "magnetization_storage_policy": "every_step",
    }
    field_zattrs = {
        "quantity_id": "m",
        "unit": "1",
        "axes": ["point", "component", "spatial_sample"],
        "component_order": ["x", "y", "z"],
        "storage_layout": "soa_component_major",
        "sample_index_file": "samples.csv",
        "cell_count": 2,
        "magnetization_average_weighting": zarr_average_weighting,
        "magnetization_storage_policy": "every_step",
    }
    if average_weights is not None:
        root_zattrs["average_weights_ref"] = "fields/m/average_weights"
        field_zattrs["average_weights_ref"] = "average_weights"
    (root / "hysteresis.zarr" / ".zattrs").write_text(json.dumps(root_zattrs))
    (field_root / ".zattrs").write_text(json.dumps(field_zattrs))
    if average_weights is not None:
        weights_root = field_root / "average_weights"
        weights_root.mkdir()
        (weights_root / ".zarray").write_text(
            json.dumps(
                {
                    "zarr_format": 2,
                    "shape": [2],
                    "chunks": [2],
                    "dtype": "<f8",
                    "compressor": None,
                    "fill_value": 0.0,
                    "order": "C",
                    "filters": None,
                    "dimension_separator": ".",
                }
            )
        )
        (weights_root / ".zattrs").write_text(
            json.dumps(
                {
                    "quantity_id": "magnetization_average_weight",
                    "unit": "A/m*m^3",
                    "axis": "spatial_sample",
                    "storage_layout": "sample_weight",
                    "sample_count": 2,
                }
            )
        )
        (weights_root / "0").write_bytes(
            b"".join(struct.pack("<d", value) for value in average_weights)
        )
    (field_root / ".zarray").write_text(
        json.dumps(
            {
                "zarr_format": 2,
                "shape": [1, 3, 2],
                "chunks": [1, 3, 2],
                "dtype": "<f8",
                "compressor": None,
                "fill_value": 0.0,
                "order": "C",
                "filters": None,
                "dimension_separator": ".",
            }
        )
    )
    (field_root / "samples.csv").write_text(
        "\n".join(
            [
                "sample_index,snapshot_id,point_id,field_value_mT,quantity_id,chunk_key,grid_x,grid_y,cell_count,grid_z,component_count,dtype,branch_id,protocol_role,mesh_identity,field_revision",
                "0,hysteresis_point_001,0,25.0,m,0.0.0,2,1,2,1,3,<f8,descending,major_descending,grid:2x1x1;cells:2,1",
            ]
        )
        + "\n"
    )
    (root / "hysteresis.zarr" / "points.csv").write_text(
        "\n".join(
            [
                "sample_index,snapshot_id,point_id,field_value_mT,quantity_id,chunk_key,grid_x,grid_y,cell_count,grid_z,component_count,dtype,branch_id,protocol_role,mesh_identity,field_revision",
                "0,hysteresis_point_001,0,25.0,m,fields/m/0.0.0,2,1,2,1,3,<f8,descending,major_descending,grid:2x1x1;cells:2,1",
            ]
        )
        + "\n"
    )
    (field_root / "0.0.0").write_bytes(
        b"".join(struct.pack("<d", value) for value in chunk_values)
    )
    (root / "hysteresis_snapshots" / "hysteresis_point_001" / "m.json").write_text(
        json.dumps(
            {
                "quantity_id": "m",
                "snapshot_id": "hysteresis_point_001",
                "point_id": 0,
                "field_value_mT": 25.0,
                "layout": {"grid_cells": [2, 1, 1]},
                "values": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            }
        )
    )
    (root / "hysteresis_settle_trace.json").write_text(
        json.dumps(
            [
                {
                    "point_id": 0,
                    "field_value_mT": 25.0,
                    "step_index": 0,
                    "algorithm_id": "settle_step_000_minimize",
                    "method": "projected_gradient_bb",
                    "status": "converged",
                    "fallback_reason": None,
                    "retry_attempt": 0,
                    "resolved_timestep_s": 1e-13,
                    "torque": 1.0e-4,
                    "energy": 1.0e-18,
                }
            ]
        )
    )


def add_minor_loop_snapshot_without_zarr_row(root: Path) -> None:
    snapshot_id = "hysteresis_minor_loop_001_reversal_001"
    snapshot_dir = root / "hysteresis_snapshots" / snapshot_id
    snapshot_dir.mkdir(parents=True)
    minor_point = {
        "point_id": 0,
        "field_value_mT": 50.0,
        "m_parallel": 0.5,
        "m_oop": 0.0,
        "m_ip": math.sqrt(0.5),
        "m_avg": [0.5, 0.5, 0.0],
        "status": "Completed",
        "run_status": "Completed",
        "settle_status": "converged",
        "has_non_converged_steps": False,
        "warning_count": 0,
        "snapshot_id": snapshot_id,
        "branch_id": "descending",
        "protocol_role": "minor",
        "snapshot_storage_format": "zarr_v2_json_fallback",
        "snapshot_json_artifact_ref": f"hysteresis_snapshots/{snapshot_id}/m.json",
        "snapshot_zarr_store_ref": "hysteresis.zarr",
        "snapshot_resource_ref": (
            "/v2/sessions/current/data/fields/m/samples/vector"
            f"?component=full&scope_kind=full&snapshot_id={snapshot_id}&stage_id=stage-000"
        ),
        "snapshot_vector_resource_ref": (
            "/v2/sessions/current/data/fields/m/samples/vector"
            f"?component=full&scope_kind=full&snapshot_id={snapshot_id}&stage_id=stage-000"
        ),
        "field_vector_A_per_m": [39788.735772973836, 0.0, 0.0],
        "field_orientation": {
            "kind": "preset",
            "preset_name": "in_plane_x",
        },
        "measurement_axis": "field_axis",
    }
    (root / "hysteresis_minor_loops.json").write_text(
        json.dumps(
            [
                {
                    "loop_id": "minor_loop_001",
                    "reversal_field_mT": 50.0,
                    "return_field_mT": -25.0,
                    "policy": "branch_only",
                    "settle_trace": [
                        {
                            "point_id": 0,
                            "field_value_mT": 50.0,
                            "step_index": 0,
                            "algorithm_id": "settle_step_000_minimize",
                            "method": "projected_gradient_bb",
                            "status": "converged",
                            "fallback_reason": None,
                            "retry_attempt": 0,
                            "resolved_timestep_s": 1e-13,
                            "torque": 1.0e-4,
                            "energy": 1.0e-18,
                        }
                    ],
                    "points": [minor_point],
                }
            ]
        )
    )
    (snapshot_dir / "m.json").write_text(
        json.dumps(
            {
                "quantity_id": "m",
                "snapshot_id": snapshot_id,
                "point_id": 0,
                "field_value_mT": 50.0,
                "layout": {"grid_cells": [2, 1, 1]},
                "values": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            }
        )
    )


def test_validator_rejects_zarr_chunk_that_disagrees_with_json_fallback(tmp_path: Path) -> None:
    write_playback_fixture(tmp_path, chunk_values=[1.0, 0.0, 0.0, 0.0, 0.0, 1.0])

    result = subprocess.run(
        [sys.executable, str(VALIDATOR), str(tmp_path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode != 0
    assert "Zarr chunk does not match JSON fallback" in (result.stderr + result.stdout)


def test_validator_accepts_zarr_chunk_that_matches_json_fallback(tmp_path: Path) -> None:
    write_playback_fixture(tmp_path, chunk_values=[1.0, 0.0, 0.0, 1.0, 0.0, 0.0])

    result = subprocess.run(
        [sys.executable, str(VALIDATOR), str(tmp_path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_missing_root_points_index(tmp_path: Path) -> None:
    write_playback_fixture(tmp_path, chunk_values=[1.0, 0.0, 0.0, 1.0, 0.0, 0.0])
    (tmp_path / "hysteresis.zarr" / "points.csv").unlink()

    result = subprocess.run(
        [sys.executable, str(VALIDATOR), str(tmp_path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode != 0
    assert "points.csv" in (result.stderr + result.stdout)


def test_validator_rejects_root_points_index_chunk_mismatch(tmp_path: Path) -> None:
    write_playback_fixture(tmp_path, chunk_values=[1.0, 0.0, 0.0, 1.0, 0.0, 0.0])
    points_index_path = tmp_path / "hysteresis.zarr" / "points.csv"
    points_index_path.write_text(
        points_index_path.read_text().replace("fields/m/0.0.0", "fields/m/wrong")
    )

    result = subprocess.run(
        [sys.executable, str(VALIDATOR), str(tmp_path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode != 0
    assert "points.csv chunk_key mismatch" in (result.stderr + result.stdout)


def test_validator_rejects_playback_history_without_snapshot_for_every_point(
    tmp_path: Path,
) -> None:
    write_playback_fixture(tmp_path, chunk_values=[1.0, 0.0, 0.0, 1.0, 0.0, 0.0])
    points_path = tmp_path / "hysteresis_points.json"
    points = json.loads(points_path.read_text())
    points.append(
        {
            "point_id": 1,
            "field_value_mT": 0.0,
            "m_parallel": 0.25,
            "m_oop": 0.0,
            "m_ip": 0.25,
            "m_avg": [0.25, 0.0, 0.0],
            "status": "Completed",
            "run_status": "Completed",
            "settle_status": "converged",
            "has_non_converged_steps": False,
            "warning_count": 0,
            "field_vector_A_per_m": [0.0, 0.0, 0.0],
            "field_orientation": {
                "kind": "preset",
                "preset_name": "in_plane_x",
            },
            "measurement_axis": "field_axis",
        }
    )
    points_path.write_text(json.dumps(points))

    result = subprocess.run(
        [sys.executable, str(VALIDATOR), str(tmp_path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode != 0
    assert "playback requires snapshot_id for every hysteresis point" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_minor_loop_snapshot_without_zarr_sample(
    tmp_path: Path,
) -> None:
    write_playback_fixture(tmp_path, chunk_values=[1.0, 0.0, 0.0, 1.0, 0.0, 0.0])
    add_minor_loop_snapshot_without_zarr_row(tmp_path)

    result = subprocess.run(
        [sys.executable, str(VALIDATOR), str(tmp_path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode != 0
    assert "minor-loop" in (result.stderr + result.stdout)
    assert "snapshot" in (result.stderr + result.stdout)


def test_validator_rejects_snapshot_point_without_settle_trace(tmp_path: Path) -> None:
    write_playback_fixture(tmp_path, chunk_values=[1.0, 0.0, 0.0, 1.0, 0.0, 0.0])
    (tmp_path / "hysteresis_settle_trace.json").write_text(json.dumps([]))

    result = subprocess.run(
        [sys.executable, str(VALIDATOR), str(tmp_path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode != 0
    assert "settle_trace" in (result.stderr + result.stdout)


def test_validator_rejects_noncanonical_snapshot_vector_ref(tmp_path: Path) -> None:
    write_playback_fixture(
        tmp_path,
        chunk_values=[1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        snapshot_vector_resource_ref=(
            "/v2/sessions/current/data/fields/m/samples/vector"
            "?snapshot_id=hysteresis_point_001"
        ),
    )

    result = subprocess.run(
        [sys.executable, str(VALIDATOR), str(tmp_path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode != 0
    assert "snapshot_vector_resource_ref" in (result.stderr + result.stdout)


def test_validator_rejects_sample_index_without_playback_metadata(tmp_path: Path) -> None:
    write_playback_fixture(tmp_path, chunk_values=[1.0, 0.0, 0.0, 1.0, 0.0, 0.0])
    samples_path = tmp_path / "hysteresis.zarr" / "fields" / "m" / "samples.csv"
    samples_path.write_text(
        "\n".join(
            [
                "sample_index,snapshot_id,point_id,field_value_mT,quantity_id,chunk_key,grid_x,grid_y,cell_count,grid_z,component_count,dtype",
                "0,hysteresis_point_001,0,25.0,m,0.0.0,2,1,2,1,3,<f8",
            ]
        )
        + "\n"
    )

    result = subprocess.run(
        [sys.executable, str(VALIDATOR), str(tmp_path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode != 0
    assert "missing required hysteresis playback columns" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_sample_index_for_non_m_quantity(tmp_path: Path) -> None:
    write_playback_fixture(tmp_path, chunk_values=[1.0, 0.0, 0.0, 1.0, 0.0, 0.0])
    samples_path = tmp_path / "hysteresis.zarr" / "fields" / "m" / "samples.csv"
    points_path = tmp_path / "hysteresis.zarr" / "points.csv"
    for path in (samples_path, points_path):
        path.write_text(path.read_text().replace(",m,", ",H_eff,"))

    result = subprocess.run(
        [sys.executable, str(VALIDATOR), str(tmp_path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode != 0
    assert "quantity_id" in (result.stderr + result.stdout)


def test_validator_rejects_point_average_that_disagrees_with_zarr_snapshot(
    tmp_path: Path,
) -> None:
    write_playback_fixture(
        tmp_path,
        chunk_values=[1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        m_avg=[0.5, 0.0, 0.0],
    )

    result = subprocess.run(
        [sys.executable, str(VALIDATOR), str(tmp_path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode != 0
    assert "m_avg" in (result.stderr + result.stdout)


def test_validator_rejects_projection_components_that_disagree_with_point_average(
    tmp_path: Path,
) -> None:
    write_playback_fixture(
        tmp_path,
        chunk_values=[1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
    )
    points_path = tmp_path / "hysteresis_points.json"
    points = json.loads(points_path.read_text())
    points[0]["m_parallel"] = -0.25
    points_path.write_text(json.dumps(points))

    result = subprocess.run(
        [sys.executable, str(VALIDATOR), str(tmp_path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode != 0
    assert "m_parallel does not match m_avg/projection" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_zarr_average_weighting_that_disagrees_with_metrics(
    tmp_path: Path,
) -> None:
    write_playback_fixture(
        tmp_path,
        chunk_values=[1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        zarr_average_weighting="moment_weighted_fem_p1_lumped_ms_volume",
    )
    (tmp_path / "hysteresis_metrics.json").write_text(
        json.dumps({"magnetization_average_weighting": "uniform_sample_average"})
    )

    result = subprocess.run(
        [sys.executable, str(VALIDATOR), str(tmp_path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode != 0
    assert "magnetization_average_weighting" in (result.stderr + result.stdout)


def test_validator_rejects_zarr_without_storage_policy(tmp_path: Path) -> None:
    write_playback_fixture(tmp_path, chunk_values=[1.0, 0.0, 0.0, 1.0, 0.0, 0.0])
    root_attrs_path = tmp_path / "hysteresis.zarr" / ".zattrs"
    root_attrs = json.loads(root_attrs_path.read_text())
    root_attrs.pop("magnetization_storage_policy")
    root_attrs_path.write_text(json.dumps(root_attrs))

    result = subprocess.run(
        [sys.executable, str(VALIDATOR), str(tmp_path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode != 0
    assert "magnetization_storage_policy" in (result.stderr + result.stdout)


def test_validator_rejects_zarr_without_required_root_manifest(tmp_path: Path) -> None:
    write_playback_fixture(tmp_path, chunk_values=[1.0, 0.0, 0.0, 1.0, 0.0, 0.0])
    root_attrs_path = tmp_path / "hysteresis.zarr" / ".zattrs"
    root_attrs = json.loads(root_attrs_path.read_text())
    root_attrs.pop("preferred_container")
    root_attrs_path.write_text(json.dumps(root_attrs))

    result = subprocess.run(
        [sys.executable, str(VALIDATOR), str(tmp_path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode != 0
    assert "preferred_container" in (result.stderr + result.stdout)


def test_validator_rejects_weighted_average_that_disagrees_with_zarr_weights(
    tmp_path: Path,
) -> None:
    write_playback_fixture(
        tmp_path,
        average_weights=[2.0, 6.0],
        chunk_values=[1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        m_avg=[0.5, 0.5, 0.0],
        zarr_average_weighting="moment_weighted_fem_p1_lumped_ms_volume",
    )
    (tmp_path / "hysteresis_metrics.json").write_text(
        json.dumps(
            {
                "magnetization_average_weighting": (
                    "moment_weighted_fem_p1_lumped_ms_volume"
                )
            }
        )
    )

    result = subprocess.run(
        [sys.executable, str(VALIDATOR), str(tmp_path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode != 0
    assert "m_avg" in (result.stderr + result.stdout)
