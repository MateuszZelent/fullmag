#!/usr/bin/env python3
"""Unit tests for cross-backend hysteresis metrics parity validation."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "verify_hysteresis_metrics_parity.py"


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload))


def run_validator(manifest: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(VALIDATOR), str(manifest)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def metrics_payload(*, h_c_plus: float = 12.0, m_r_plus: float = 0.72) -> dict:
    metrics = {
        "H_c_plus": h_c_plus,
        "H_c_minus": -11.0,
        "M_r_plus": m_r_plus,
        "M_r_minus": -0.68,
        "magnetization_average_weighting": "uniform_sample_average",
    }
    metrics["metric_statuses"] = {
        name: {"status": "available", "reason": "Fixture metric is available."}
        for name in ("H_c_plus", "H_c_minus", "M_r_plus", "M_r_minus")
    }
    return metrics


def write_parity_fixture(root: Path, *, candidate_h_c_plus: float = 12.4) -> Path:
    write_json(root / "fdm_cpu" / "hysteresis_metrics.json", metrics_payload())
    candidate = metrics_payload(h_c_plus=candidate_h_c_plus, m_r_plus=0.721)
    candidate["magnetization_average_weighting"] = "moment_weighted_fem_p1_lumped_ms_volume"
    write_json(root / "fem_cpu" / "hysteresis_metrics.json", candidate)
    manifest = root / "hysteresis_metrics_parity.json"
    write_json(
        manifest,
        {
            "schema_version": "hysteresis-metrics-parity/v1",
            "pairs": [
                {
                    "pair_id": "thinfilm_fdm_cpu_vs_fem_cpu",
                    "reference": {
                        "backend": "fdm",
                        "device": "cpu",
                        "precision": "double",
                        "metrics_path": "fdm_cpu/hysteresis_metrics.json",
                    },
                    "candidate": {
                        "backend": "fem",
                        "device": "cpu",
                        "precision": "double",
                        "metrics_path": "fem_cpu/hysteresis_metrics.json",
                    },
                    "metrics": [
                        {"name": "H_c_plus", "unit": "mT", "abs_tolerance": 1.0},
                        {"name": "H_c_minus", "unit": "mT", "abs_tolerance": 1.0},
                        {"name": "M_r_plus", "unit": "1", "abs_tolerance": 0.02},
                        {"name": "M_r_minus", "unit": "1", "abs_tolerance": 0.02},
                    ],
                }
            ],
        },
    )
    return manifest


def test_metrics_parity_accepts_metrics_within_tolerances(tmp_path: Path) -> None:
    manifest = write_parity_fixture(tmp_path)

    result = run_validator(manifest)

    assert result.returncode == 0, result.stderr + result.stdout
    assert "validated hysteresis metrics parity" in result.stdout
    assert "thinfilm_fdm_cpu_vs_fem_cpu" in result.stdout


def test_metrics_parity_rejects_candidate_outside_tolerance(tmp_path: Path) -> None:
    manifest = write_parity_fixture(tmp_path, candidate_h_c_plus=15.5)

    result = run_validator(manifest)

    assert result.returncode != 0
    details = result.stderr + result.stdout
    assert "H_c_plus" in details
    assert "fdm/cpu/double" in details
    assert "fem/cpu/double" in details


def test_metrics_parity_rejects_missing_metric_status(tmp_path: Path) -> None:
    manifest = write_parity_fixture(tmp_path)
    candidate = metrics_payload()
    del candidate["metric_statuses"]["M_r_plus"]
    write_json(tmp_path / "fem_cpu" / "hysteresis_metrics.json", candidate)

    result = run_validator(manifest)

    assert result.returncode != 0
    assert "metric_statuses.M_r_plus" in (result.stderr + result.stdout)


def test_metrics_parity_rejects_unavailable_metric_status(tmp_path: Path) -> None:
    manifest = write_parity_fixture(tmp_path)
    candidate = metrics_payload()
    candidate["metric_statuses"]["H_c_minus"] = {
        "status": "warning",
        "reason": "Loop is not closed.",
    }
    write_json(tmp_path / "fem_cpu" / "hysteresis_metrics.json", candidate)

    result = run_validator(manifest)

    assert result.returncode != 0
    assert "H_c_minus" in (result.stderr + result.stdout)


def test_metrics_parity_rejects_missing_metric_value(tmp_path: Path) -> None:
    manifest = write_parity_fixture(tmp_path)
    candidate = metrics_payload()
    del candidate["M_r_minus"]
    write_json(tmp_path / "fem_cpu" / "hysteresis_metrics.json", candidate)

    result = run_validator(manifest)

    assert result.returncode != 0
    assert "M_r_minus" in (result.stderr + result.stdout)


def test_metrics_parity_rejects_manifest_without_required_metric(
    tmp_path: Path,
) -> None:
    manifest = write_parity_fixture(tmp_path)
    payload = json.loads(manifest.read_text())
    payload["pairs"][0]["metrics"] = [
        metric
        for metric in payload["pairs"][0]["metrics"]
        if metric["name"] != "M_r_minus"
    ]
    write_json(manifest, payload)

    result = run_validator(manifest)

    assert result.returncode != 0
    assert "M_r_minus" in (result.stderr + result.stdout)


def test_metrics_parity_rejects_absolute_metrics_path(tmp_path: Path) -> None:
    manifest = write_parity_fixture(tmp_path)
    payload = json.loads(manifest.read_text())
    payload["pairs"][0]["candidate"]["metrics_path"] = str(
        tmp_path / "fem_cpu" / "hysteresis_metrics.json"
    )
    write_json(manifest, payload)

    result = run_validator(manifest)

    assert result.returncode != 0
    assert "must be relative" in (result.stderr + result.stdout)


def test_metrics_parity_rejects_metrics_path_outside_manifest_tree(
    tmp_path: Path,
) -> None:
    manifest_root = tmp_path / "manifest"
    manifest = write_parity_fixture(manifest_root)
    outside_metrics = tmp_path / "outside" / "hysteresis_metrics.json"
    write_json(outside_metrics, metrics_payload())
    payload = json.loads(manifest.read_text())
    payload["pairs"][0]["candidate"]["metrics_path"] = (
        "../outside/hysteresis_metrics.json"
    )
    write_json(manifest, payload)

    result = run_validator(manifest)

    assert result.returncode != 0
    assert "must stay under" in (result.stderr + result.stdout)
