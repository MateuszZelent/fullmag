#!/usr/bin/env python3
"""Unit tests for the macrospin Stoner-Wohlfarth artifact validator."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "verify_hysteresis_fdm_macrospin_sw_artifacts.py"


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


def point(index: int, field_value_mT: float, m_parallel: float) -> dict:
    return {
        "field_value_mT": field_value_mT,
        "m_avg": [m_parallel, 0.0, 0.0],
        "m_parallel": m_parallel,
        "point_id": index,
        "status": "Completed",
    }


def loop_points(crossing_mT: float) -> list[dict]:
    high = max(20.0, crossing_mT + 15.0)
    low = max(5.0, crossing_mT - 5.0)
    values = [
        (high, 1.0),
        (crossing_mT + 5.0, 1.0),
        (crossing_mT + 2.0, 0.4),
        (crossing_mT - 2.0, -0.4),
        (-low, -1.0),
        (-crossing_mT, -1.0),
        (0.0, -0.8),
        (high, 1.0),
    ]
    return [point(index, field, m_parallel) for index, (field, m_parallel) in enumerate(values)]


def write_macrospin_fixture(
    root: Path,
    *,
    easy_orientation: dict | None = None,
    theta_orientation: dict | None = None,
    theta_status: str = "computed_variant_run",
    theta_resource_ref: str = "/v2/sessions/current/analysis/hysteresis-family/stage-0/variants/theta45/points",
    theta_points: list[dict] | None = None,
) -> None:
    variants = [
        {
            "data_status": "computed_active_stage",
            "point_count": 8,
            "points_path": "hysteresis_points.json",
            "points_resource_ref": "/v2/sessions/current/analysis/hysteresis-family/stage-0/variants/easy_axis/points",
            "variant_id": "easy_axis",
            "orientation": easy_orientation,
        },
        {
            "data_status": theta_status,
            "point_count": 8,
            "points_path": "hysteresis_angular_family/theta45/hysteresis_points.json",
            "points_resource_ref": theta_resource_ref,
            "variant_id": "theta45",
            "orientation": theta_orientation,
        },
    ]
    write_json(
        root / "hysteresis_angular_family.json",
        {
            "active_variant_id": "easy_axis",
            "family_id": "macrospin_sw",
            "variants": variants,
        },
    )
    write_json(root / "hysteresis_points.json", loop_points(14.0))
    write_json(
        root / "hysteresis_angular_family/theta45/hysteresis_points.json",
        theta_points if theta_points is not None else loop_points(8.0),
    )


def test_macrospin_validator_accepts_public_computed_variants(tmp_path: Path) -> None:
    write_macrospin_fixture(
        tmp_path,
        easy_orientation={"kind": "sample", "theta": 30.0, "phi": 0.0},
        theta_orientation={"kind": "sample", "theta": 45.0, "phi": 0.0},
    )

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout
    assert "validated FDM macrospin Stoner-Wohlfarth trend" in result.stdout


def test_macrospin_validator_rejects_missing_variant_orientation(tmp_path: Path) -> None:
    write_macrospin_fixture(tmp_path)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "orientation" in (result.stderr + result.stdout)


def test_macrospin_validator_rejects_collinear_easy_axis_without_perturbation_policy(
    tmp_path: Path,
) -> None:
    write_macrospin_fixture(
        tmp_path,
        easy_orientation={"kind": "sample", "theta": 0.0, "phi": 0.0},
        theta_orientation={"kind": "sample", "theta": 45.0, "phi": 0.0},
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "near-easy" in (result.stderr + result.stdout)


def test_macrospin_validator_rejects_pending_required_variant(tmp_path: Path) -> None:
    write_macrospin_fixture(
        tmp_path,
        easy_orientation={"kind": "sample", "theta": 30.0, "phi": 0.0},
        theta_orientation={"kind": "sample", "theta": 45.0, "phi": 0.0},
        theta_status="pending_run",
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "computed" in (result.stderr + result.stdout)


def test_macrospin_validator_rejects_private_points_resource_ref(tmp_path: Path) -> None:
    write_macrospin_fixture(
        tmp_path,
        easy_orientation={"kind": "sample", "theta": 30.0, "phi": 0.0},
        theta_orientation={"kind": "sample", "theta": 45.0, "phi": 0.0},
        theta_resource_ref="hysteresis_angular_family/theta45/hysteresis_points.json",
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "points_resource_ref" in (result.stderr + result.stdout)


def test_macrospin_validator_rejects_missing_coercive_crossing(tmp_path: Path) -> None:
    write_macrospin_fixture(
        tmp_path,
        easy_orientation={"kind": "sample", "theta": 30.0, "phi": 0.0},
        theta_orientation={"kind": "sample", "theta": 45.0, "phi": 0.0},
        theta_points=[point(index, float(index), 1.0) for index in range(8)],
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "never reaches negative magnetization" in (result.stderr + result.stdout)


def test_macrospin_validator_rejects_failed_angular_trend(tmp_path: Path) -> None:
    write_macrospin_fixture(
        tmp_path,
        easy_orientation={"kind": "sample", "theta": 30.0, "phi": 0.0},
        theta_orientation={"kind": "sample", "theta": 45.0, "phi": 0.0},
        theta_points=loop_points(14.0),
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "angular trend failed" in (result.stderr + result.stdout)
