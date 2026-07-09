#!/usr/bin/env python3
"""Tests for GPU shifted-solve action parity artifact validation."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "verify_fem_gpu_shifted_solve_action_parity_artifact.py"


def payload(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "schema_version": "gpu_shifted_solve_action_parity.v1",
        "lane": "gpu_poisson_airbox_k0",
        "execution_policy": "device",
        "memory_location": "device",
        "fallback_used": False,
        "gpu_shifted_solve_action_parity": {
            "status": "passed",
            "operator_family": "frequency_response_shifted_linear_solve",
            "rhs_family": "dynamic_field_phasor",
            "full_modal_shift_invert_claim": False,
            "max_relative_action_error": 5.0e-10,
            "magnetization_response_relative_l2_error": 5.0e-10,
            "component_amplitude_relative_l2_error": 4.0e-10,
            "component_phase_max_abs_error_rad": 3.0e-10,
            "fallback_used": False,
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


def test_validator_accepts_gpu_shifted_solve_action_parity_artifact(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_shifted_solve_action_parity.v1.json"
    artifact.write_text(json.dumps(payload()), encoding="utf-8")

    result = run_validator(artifact)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_modal_shift_invert_claim(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_shifted_solve_action_parity.v1.json"
    bad = payload(
        gpu_shifted_solve_action_parity={
            "status": "passed",
            "operator_family": "frequency_response_shifted_linear_solve",
            "rhs_family": "dynamic_field_phasor",
            "full_modal_shift_invert_claim": True,
            "max_relative_action_error": 0.0,
            "magnetization_response_relative_l2_error": 0.0,
            "component_amplitude_relative_l2_error": 0.0,
            "component_phase_max_abs_error_rad": 0.0,
            "fallback_used": False,
        }
    )
    artifact.write_text(json.dumps(bad), encoding="utf-8")

    result = run_validator(artifact)

    assert result.returncode != 0
    assert "full_modal_shift_invert_claim" in (result.stderr + result.stdout)


def test_validator_rejects_large_action_error(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_shifted_solve_action_parity.v1.json"
    bad = payload(
        gpu_shifted_solve_action_parity={
            "status": "passed",
            "operator_family": "frequency_response_shifted_linear_solve",
            "rhs_family": "dynamic_field_phasor",
            "full_modal_shift_invert_claim": False,
            "max_relative_action_error": 1.0e-3,
            "magnetization_response_relative_l2_error": 1.0e-3,
            "component_amplitude_relative_l2_error": 0.0,
            "component_phase_max_abs_error_rad": 0.0,
            "fallback_used": False,
        }
    )
    artifact.write_text(json.dumps(bad), encoding="utf-8")

    result = run_validator(artifact)

    assert result.returncode != 0
    assert "max_relative_action_error" in (result.stderr + result.stdout)


def test_validator_rejects_host_execution_policy(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_shifted_solve_action_parity.v1.json"
    artifact.write_text(json.dumps(payload(execution_policy="host")), encoding="utf-8")

    result = run_validator(artifact)

    assert result.returncode != 0
    assert "execution_policy" in (result.stderr + result.stdout)
