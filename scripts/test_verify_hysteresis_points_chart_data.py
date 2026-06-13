#!/usr/bin/env python3
"""Unit tests for hysteresis point chart-data validation."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "verify_hysteresis_points_chart_data.py"


def write_points(root: Path, points: list[dict]) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "hysteresis_points.json").write_text(json.dumps(points))


def run_validator(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(VALIDATOR), str(root)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def valid_point(**overrides) -> dict:
    point = {
        "point_id": 0,
        "field_value_mT": 25.0,
        "field_orientation": {"kind": "preset", "preset_name": "in_plane_x"},
        "measurement_axis": "field_axis",
        "m_avg": [0.6, 0.8, 0.0],
        "m_parallel": 0.6,
        "m_oop": 0.0,
        "m_ip": 1.0,
        "status": "Completed",
    }
    point.update(overrides)
    return point


def test_validator_accepts_points_with_consistent_chart_components(tmp_path: Path) -> None:
    write_points(tmp_path, [valid_point()])

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout
    assert "validated hysteresis chart points" in result.stdout


def test_validator_rejects_missing_component_average(tmp_path: Path) -> None:
    point = valid_point()
    point.pop("m_avg")
    write_points(tmp_path, [point])

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "m_avg" in (result.stderr + result.stdout)


def test_validator_rejects_parallel_projection_mismatch(tmp_path: Path) -> None:
    write_points(tmp_path, [valid_point(m_parallel=-0.2)])

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "m_parallel" in (result.stderr + result.stdout)


def test_validator_accepts_custom_measurement_axis(tmp_path: Path) -> None:
    write_points(
        tmp_path,
        [
            valid_point(
                measurement_axis={"kind": "custom", "vector": [0.0, 1.0, 0.0]},
                m_parallel=0.8,
            )
        ],
    )

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_degenerate_multi_point_chart_series(tmp_path: Path) -> None:
    write_points(
        tmp_path,
        [
            valid_point(point_id=0, field_value_mT=25.0),
            valid_point(point_id=1, field_value_mT=25.0),
        ],
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "field_value_mT" in (result.stderr + result.stdout)
