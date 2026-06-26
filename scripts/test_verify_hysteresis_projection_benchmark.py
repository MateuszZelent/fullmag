#!/usr/bin/env python3
"""Unit tests for hysteresis projection benchmark validation."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "verify_hysteresis_projection_benchmark.py"


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


def point(field_value_mT: float, m_avg: list[float], m_parallel: float) -> dict:
    return {
        "field_value_mT": field_value_mT,
        "m_avg": m_avg,
        "m_ip": (m_avg[0] * m_avg[0] + m_avg[1] * m_avg[1]) ** 0.5,
        "m_oop": m_avg[2],
        "m_parallel": m_parallel,
        "point_id": 0,
        "status": "Completed",
    }


def publication_metrics() -> dict:
    metrics = {
        "H_c_plus": 10.0,
        "H_c_minus": -10.0,
        "H_c": 10.0,
        "M_r_plus": 0.2,
        "M_r_minus": -0.2,
        "loop_area": 1.0,
    }
    metrics["metric_statuses"] = {
        key: {"status": "available", "reason": "Metric value is available."}
        for key in metrics
    }
    return metrics


def write_projection_fixture(
    root: Path,
    *,
    ip_status: str = "computed_active_stage",
    ip_resource_ref: str = "/v2/sessions/current/analysis/hysteresis-family/stage-0/variants/ip_x/points",
    ip_m_parallel: float = 0.6,
    ip_m_avg: list[float] | None = None,
    include_metrics: bool = True,
    single_point: bool = False,
) -> None:
    variants = [
        {
            "data_status": ip_status,
            "measurement_axis": "field_axis",
            "orientation": {"kind": "preset", "preset_name": "in_plane_x"},
            "point_count": 1 if single_point else 5,
            "points_path": "hysteresis_points.json",
            "metrics_path": "hysteresis_metrics.json",
            "points_resource_ref": ip_resource_ref,
            "variant_id": "ip_x",
        },
        {
            "data_status": "computed_variant_run",
            "measurement_axis": "field_axis",
            "orientation": {"kind": "preset", "preset_name": "oop_positive"},
            "point_count": 1 if single_point else 5,
            "points_path": "hysteresis_angular_family/oop/hysteresis_points.json",
            "metrics_path": "hysteresis_angular_family/oop/hysteresis_metrics.json",
            "points_resource_ref": "/v2/sessions/current/analysis/hysteresis-family/stage-0/variants/oop/points",
            "variant_id": "oop",
        },
        {
            "data_status": "computed_variant_run",
            "measurement_axis": "field_axis",
            "orientation": {"kind": "sample", "theta": 45.0, "phi": 30.0},
            "point_count": 1 if single_point else 5,
            "points_path": "hysteresis_angular_family/custom_theta45_phi30/hysteresis_points.json",
            "metrics_path": "hysteresis_angular_family/custom_theta45_phi30/hysteresis_metrics.json",
            "points_resource_ref": "/v2/sessions/current/analysis/hysteresis-family/stage-0/variants/custom_theta45_phi30/points",
            "variant_id": "custom_theta45_phi30",
        },
    ]
    write_json(
        root / "hysteresis_angular_family.json",
        {
            "active_variant_id": "ip_x",
            "family_id": "projection_fixture",
            "variants": variants,
        },
    )
    fields = [50.0] if single_point else [50.0, 0.0, -50.0, 0.0, 50.0]
    write_json(
        root / "hysteresis_points.json",
        [
            point(
                field,
                ip_m_avg if ip_m_avg is not None else [ip_m_parallel, 0.0, 0.0],
                ip_m_parallel,
            )
            for field in fields
        ],
    )
    write_json(
        root / "hysteresis_angular_family/oop/hysteresis_points.json",
        [point(field, [0.0, 0.0, 0.7], 0.7) for field in fields],
    )
    axis_x = 0.6123724356957946
    axis_y = 0.35355339059327373
    axis_z = 0.7071067811865476
    m_avg = [0.2, 0.3, 0.4]
    write_json(
        root / "hysteresis_angular_family/custom_theta45_phi30/hysteresis_points.json",
        [
            point(field, m_avg, m_avg[0] * axis_x + m_avg[1] * axis_y + m_avg[2] * axis_z)
            for field in fields
        ],
    )
    if include_metrics:
        metrics = publication_metrics()
        write_json(root / "hysteresis_metrics.json", metrics)
        write_json(root / "hysteresis_angular_family/oop/hysteresis_metrics.json", metrics)
        write_json(
            root / "hysteresis_angular_family/custom_theta45_phi30/hysteresis_metrics.json",
            metrics,
        )


def test_projection_validator_accepts_public_computed_variants(tmp_path: Path) -> None:
    write_projection_fixture(tmp_path)

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout
    assert "validated hysteresis projection benchmark" in result.stdout


def test_projection_validator_rejects_pending_required_variant(tmp_path: Path) -> None:
    write_projection_fixture(tmp_path, ip_status="pending_run")

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "computed" in (result.stderr + result.stdout)


def test_projection_validator_rejects_private_points_resource_ref(tmp_path: Path) -> None:
    write_projection_fixture(
        tmp_path,
        ip_resource_ref="hysteresis_angular_family/ip_x/hysteresis_points.json",
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "points_resource_ref" in (result.stderr + result.stdout)


def test_projection_validator_rejects_parallel_projection_mismatch(tmp_path: Path) -> None:
    write_projection_fixture(tmp_path, ip_m_avg=[0.6, 0.0, 0.0], ip_m_parallel=-0.2)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "m_parallel" in (result.stderr + result.stdout)


def test_projection_validator_rejects_single_point_placeholder(tmp_path: Path) -> None:
    write_projection_fixture(tmp_path, single_point=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "full loop" in (result.stderr + result.stdout)


def test_projection_validator_rejects_missing_publication_metrics(tmp_path: Path) -> None:
    write_projection_fixture(tmp_path, include_metrics=False)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "metrics" in (result.stderr + result.stdout)


def test_projection_validator_rejects_metrics_without_statuses(tmp_path: Path) -> None:
    write_projection_fixture(tmp_path)
    metrics = publication_metrics()
    metrics.pop("metric_statuses")
    write_json(tmp_path / "hysteresis_metrics.json", metrics)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "metric_statuses" in (result.stderr + result.stdout)


def test_projection_validator_rejects_unavailable_publication_metric_status(
    tmp_path: Path,
) -> None:
    write_projection_fixture(tmp_path)
    metrics = publication_metrics()
    metrics["metric_statuses"]["H_c_plus"] = {
        "status": "unavailable",
        "reason": "No positive coercive crossing.",
    }
    write_json(tmp_path / "hysteresis_metrics.json", metrics)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "H_c_plus" in (result.stderr + result.stdout)
