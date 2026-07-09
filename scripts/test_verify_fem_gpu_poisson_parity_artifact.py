#!/usr/bin/env python3
"""Tests for GPU Poisson parity artifact validation."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "verify_fem_gpu_poisson_parity_artifact.py"


def write_artifact(path: Path, **overrides: object) -> None:
    payload: dict[str, object] = {
        "schema_version": "gpu_poisson_parity.v1",
        "lane": "gpu_poisson_airbox_k0",
        "execution_policy": "device",
        "memory_location": "device",
        "fallback_used": False,
        "gpu_poisson_parity": {
            "status": "passed",
            "max_relative_phi_error": 1.0e-8,
            "max_relative_field_error": 2.0e-8,
            "h2d_count": 0,
            "d2h_count": 0,
            "fallback_used": False,
        },
    }
    payload.update(overrides)
    path.write_text(json.dumps(payload), encoding="utf-8")


def run_validator(path: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(VALIDATOR), str(path)],
        cwd=REPO_ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def test_validator_accepts_gpu_poisson_parity_artifact(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_poisson_parity.v1.json"
    write_artifact(artifact)

    result = run_validator(artifact)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_host_execution_policy(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_poisson_parity.v1.json"
    write_artifact(artifact, execution_policy="host")

    result = run_validator(artifact)

    assert result.returncode != 0
    assert "execution_policy" in (result.stderr + result.stdout)


def test_validator_rejects_fallback_claim(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_poisson_parity.v1.json"
    write_artifact(
        artifact,
        gpu_poisson_parity={
            "status": "passed",
            "max_relative_phi_error": 1.0e-8,
            "max_relative_field_error": 2.0e-8,
            "h2d_count": 0,
            "d2h_count": 0,
            "fallback_used": True,
        },
    )

    result = run_validator(artifact)

    assert result.returncode != 0
    assert "fallback_used" in (result.stderr + result.stdout)


def test_validator_rejects_large_phi_error(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_poisson_parity.v1.json"
    write_artifact(
        artifact,
        gpu_poisson_parity={
            "status": "passed",
            "max_relative_phi_error": 1.0e-3,
            "max_relative_field_error": 2.0e-8,
            "h2d_count": 0,
            "d2h_count": 0,
            "fallback_used": False,
        },
    )

    result = run_validator(artifact)

    assert result.returncode != 0
    assert "max_relative_phi_error" in (result.stderr + result.stdout)
