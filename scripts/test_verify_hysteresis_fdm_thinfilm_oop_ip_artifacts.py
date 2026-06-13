#!/usr/bin/env python3
"""Unit tests for the FDM thin-film OOP/IP artifact validator."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "verify_hysteresis_fdm_thinfilm_oop_ip_artifacts.py"


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


def thinfilm_points(high_field_projection: float) -> list[dict]:
    values = [
        (300.0, high_field_projection),
        (0.0, 0.0),
        (-300.0, -high_field_projection),
        (0.0, 0.0),
        (300.0, high_field_projection),
    ]
    return [point(index, field, m_parallel) for index, (field, m_parallel) in enumerate(values)]


def write_thinfilm_fixture(
    root: Path,
    *,
    oop_status: str = "computed_variant_run",
    oop_resource_ref: str = "/v2/sessions/current/analysis/hysteresis-family/stage-0/variants/oop/points",
    oop_points: list[dict] | None = None,
) -> None:
    variants = [
        {
            "data_status": "computed_active_stage",
            "point_count": 5,
            "points_path": "hysteresis_points.json",
            "points_resource_ref": "/v2/sessions/current/analysis/hysteresis-family/stage-0/variants/ip_near_x/points",
            "variant_id": "ip_near_x",
        },
        {
            "data_status": oop_status,
            "point_count": 5,
            "points_path": "hysteresis_angular_family/oop/hysteresis_points.json",
            "points_resource_ref": oop_resource_ref,
            "variant_id": "oop",
        },
    ]
    write_json(
        root / "hysteresis_angular_family.json",
        {
            "active_variant_id": "ip_near_x",
            "family_id": "thinfilm_oop_ip",
            "variants": variants,
        },
    )
    write_json(root / "hysteresis_points.json", thinfilm_points(1.0))
    write_json(
        root / "hysteresis_angular_family/oop/hysteresis_points.json",
        oop_points if oop_points is not None else thinfilm_points(0.55),
    )


def test_thinfilm_validator_accepts_public_computed_variants(tmp_path: Path) -> None:
    write_thinfilm_fixture(tmp_path)

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout
    assert "validated FDM thin-film OOP/IP hysteresis fixture" in result.stdout


def test_thinfilm_validator_rejects_pending_required_variant(tmp_path: Path) -> None:
    write_thinfilm_fixture(tmp_path, oop_status="pending_run")

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "computed" in (result.stderr + result.stdout)


def test_thinfilm_validator_rejects_private_points_resource_ref(tmp_path: Path) -> None:
    write_thinfilm_fixture(
        tmp_path,
        oop_resource_ref="hysteresis_angular_family/oop/hysteresis_points.json",
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "points_resource_ref" in (result.stderr + result.stdout)


def test_thinfilm_validator_rejects_weak_in_plane_response(tmp_path: Path) -> None:
    write_thinfilm_fixture(tmp_path)
    write_json(tmp_path / "hysteresis_points.json", thinfilm_points(0.2))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "in-plane branch does not align" in (result.stderr + result.stdout)


def test_thinfilm_validator_rejects_missing_demag_contrast(tmp_path: Path) -> None:
    write_thinfilm_fixture(tmp_path, oop_points=thinfilm_points(0.95))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "demag contrast failed" in (result.stderr + result.stdout)
