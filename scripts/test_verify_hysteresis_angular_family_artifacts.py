#!/usr/bin/env python3
"""Unit tests for the generic angular-family hysteresis artifact validator."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "verify_hysteresis_angular_family_artifacts.py"


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


def points() -> list[dict]:
    return [
        {"field_value_mT": 50.0, "m_avg": [1.0, 0.0, 0.0], "m_parallel": 1.0},
        {"field_value_mT": 0.0, "m_avg": [0.2, 0.0, 0.0], "m_parallel": 0.2},
        {"field_value_mT": -50.0, "m_avg": [-1.0, 0.0, 0.0], "m_parallel": -1.0},
    ]


def write_family_fixture(
    root: Path,
    *,
    active_resource_ref: str = "/v2/sessions/current/analysis/hysteresis-family/stage-0/variants/ip_x/points",
    computed_resource_ref: str = "/v2/sessions/current/analysis/hysteresis-family/stage-0/variants/oop/points",
) -> None:
    write_json(root / "hysteresis_points.json", points())
    write_json(root / "hysteresis_metrics.json", {"H_c": 1.0})
    write_json(root / "hysteresis_angular_family/oop/hysteresis_points.json", points())
    write_json(root / "hysteresis_angular_family/oop/hysteresis_metrics.json", {"H_c": 2.0})
    write_json(
        root / "hysteresis_angular_family.json",
        {
            "active_variant_id": "ip_x",
            "family_id": "waveguide_ip_oop_family",
            "variants": [
                {
                    "variant_id": "ip_x",
                    "data_status": "computed_active_stage",
                    "point_count": 3,
                    "points_resource_ref": active_resource_ref,
                    "points_path": "hysteresis_points.json",
                    "metrics_path": "hysteresis_metrics.json",
                },
                {
                    "variant_id": "oop",
                    "data_status": "computed_variant_run",
                    "point_count": 3,
                    "points_resource_ref": computed_resource_ref,
                    "points_path": "hysteresis_angular_family/oop/hysteresis_points.json",
                    "metrics_path": "hysteresis_angular_family/oop/hysteresis_metrics.json",
                },
            ],
        },
    )


def test_angular_family_validator_accepts_public_resource_refs(tmp_path: Path) -> None:
    write_family_fixture(tmp_path)

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout
    assert "validated hysteresis angular family" in result.stdout


def test_angular_family_validator_rejects_private_points_resource_ref(tmp_path: Path) -> None:
    write_family_fixture(
        tmp_path,
        computed_resource_ref="hysteresis_angular_family/oop/hysteresis_points.json",
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "points_resource_ref" in (result.stderr + result.stdout)


def test_angular_family_validator_rejects_missing_points_resource_ref(tmp_path: Path) -> None:
    write_family_fixture(tmp_path, active_resource_ref="")

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "points_resource_ref" in (result.stderr + result.stdout)
