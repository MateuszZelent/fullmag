#!/usr/bin/env python3
"""Tests for GPU Schur-apply parity artifact validation."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "verify_fem_gpu_schur_apply_parity_artifact.py"


def payload(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "schema_version": "gpu_schur_apply_parity.v1",
        "lane": "gpu_poisson_airbox_k0",
        "execution_policy": "device",
        "memory_location": "device",
        "fallback_used": False,
        "gpu_schur_apply_parity": {
            "status": "passed",
            "fallback_used": False,
            "probe_available": True,
            "vector_set": "deterministic_frequency_response_probe",
            "max_relative_schur_apply_error": 5.0e-10,
            "complex_operator_relative_l2_error": 5.0e-10,
            "real_stiffness_relative_l2_error": 4.0e-10,
            "imag_stiffness_relative_l2_error": 4.0e-10,
            "real_mass_relative_l2_error": 0.0,
            "imag_mass_relative_l2_error": 0.0,
            "demag_tangent_relative_l2_error": 5.0e-10,
        },
    }
    base.update(overrides)
    return base


def run_validator(path: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(VALIDATOR), str(path)],
        cwd=REPO_ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def test_validator_accepts_gpu_schur_apply_parity_artifact(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_schur_apply_parity.v1.json"
    artifact.write_text(json.dumps(payload()), encoding="utf-8")

    result = run_validator(artifact)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_host_memory_location(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_schur_apply_parity.v1.json"
    artifact.write_text(json.dumps(payload(memory_location="host")), encoding="utf-8")

    result = run_validator(artifact)

    assert result.returncode != 0
    assert "memory_location" in (result.stderr + result.stdout)


def test_validator_rejects_large_schur_apply_error(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_schur_apply_parity.v1.json"
    bad = payload(
        gpu_schur_apply_parity={
            "status": "passed",
            "fallback_used": False,
            "probe_available": True,
            "vector_set": "deterministic_frequency_response_probe",
            "max_relative_schur_apply_error": 1.0e-3,
            "complex_operator_relative_l2_error": 1.0e-3,
            "real_stiffness_relative_l2_error": 0.0,
            "imag_stiffness_relative_l2_error": 0.0,
            "real_mass_relative_l2_error": 0.0,
            "imag_mass_relative_l2_error": 0.0,
            "demag_tangent_relative_l2_error": 0.0,
        }
    )
    artifact.write_text(json.dumps(bad), encoding="utf-8")

    result = run_validator(artifact)

    assert result.returncode != 0
    assert "max_relative_schur_apply_error" in (result.stderr + result.stdout)


def test_validator_rejects_missing_probe(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_schur_apply_parity.v1.json"
    bad = payload(
        gpu_schur_apply_parity={
            "status": "passed",
            "fallback_used": False,
            "probe_available": False,
            "vector_set": "deterministic_frequency_response_probe",
            "max_relative_schur_apply_error": 0.0,
            "complex_operator_relative_l2_error": 0.0,
            "real_stiffness_relative_l2_error": 0.0,
            "imag_stiffness_relative_l2_error": 0.0,
            "real_mass_relative_l2_error": 0.0,
            "imag_mass_relative_l2_error": 0.0,
            "demag_tangent_relative_l2_error": 0.0,
        }
    )
    artifact.write_text(json.dumps(bad), encoding="utf-8")

    result = run_validator(artifact)

    assert result.returncode != 0
    assert "probe_available" in (result.stderr + result.stdout)
