#!/usr/bin/env python3
"""Unit tests for the saturation-limit hysteresis artifact validator."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "verify_hysteresis_saturation_limit_artifacts.py"


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


def saturation_probe_point(index: int, field_value_mT: float) -> dict:
    return {
        "field_value_mT": field_value_mT,
        "m_parallel": 0.1 * (index + 1),
        "m_transverse": 0.2,
        "probe_index": index,
        "status": "converged",
    }


def measured_point(*, include_provenance: bool = True) -> dict:
    point = {
        "field_value_mT": 0.0,
        "m_avg": [0.0, 0.0, 0.0],
        "m_ip": 0.0,
        "m_oop": 0.0,
        "m_parallel": 0.0,
        "point_id": 0,
        "run_status": "Completed",
        "settle_status": "converged",
        "status": "Completed",
    }
    if include_provenance:
        point.update(
            {
                "field_display_unit": "mT",
                "field_orientation": {"kind": "preset", "preset_name": "in_plane_x"},
                "field_vector_A_per_m": [0.0, 0.0, 0.0],
                "measurement_axis": "field_axis",
            }
        )
    return point


def write_saturation_fixture(
    root: Path,
    *,
    metrics_status: str = "capped_by_limit",
    include_point_provenance: bool = True,
) -> None:
    write_json(
        root / "hysteresis_saturation.json",
        {
            "direction": 1,
            "max_probe_field_mT": 30.0,
            "points": [
                saturation_probe_point(0, 10.0),
                saturation_probe_point(1, 20.0),
                saturation_probe_point(2, 30.0),
            ],
            "preparation_field_mT": 30.0,
            "reason": "max_probe_field_mT reached before saturation thresholds",
            "status": "capped_by_limit",
            "susceptibility_threshold": 1e-12,
            "transverse_threshold": 1e-12,
        },
    )
    write_json(
        root / "hysteresis_metrics.json",
        {
            "saturation_preparation_field_mT": 30.0,
            "saturation_status": metrics_status,
        },
    )
    write_json(
        root / "hysteresis_points.json",
        [measured_point(include_provenance=include_point_provenance)],
    )


def test_saturation_validator_accepts_capped_limit_fixture(tmp_path: Path) -> None:
    write_saturation_fixture(tmp_path)

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout
    assert "validated hysteresis saturation limit" in result.stdout


def test_saturation_validator_rejects_metrics_status_mismatch(tmp_path: Path) -> None:
    write_saturation_fixture(tmp_path, metrics_status="saturated")

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "saturation_status" in (result.stderr + result.stdout)


def test_saturation_validator_rejects_measured_point_without_provenance(tmp_path: Path) -> None:
    write_saturation_fixture(tmp_path, include_point_provenance=False)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "field_vector_A_per_m" in (result.stderr + result.stdout)
