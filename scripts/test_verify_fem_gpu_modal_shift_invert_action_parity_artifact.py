#!/usr/bin/env python3
"""Tests for true GPU modal shift-invert action parity artifact validation."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = (
    REPO_ROOT
    / "scripts"
    / "verify_fem_gpu_modal_shift_invert_action_parity_artifact.py"
)


def payload(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "schema_version": "gpu_modal_shift_invert_action_parity.v1",
        "lane": "gpu_poisson_airbox_k0",
        "execution_policy": "device",
        "memory_location": "device",
        "fallback_used": False,
        "gpu_modal_shift_invert_action_parity": {
            "status": "passed",
            "operator_family": "full_modal_shift_invert",
            "algebraic_action": "(A - sigma B)^-1 Bv",
            "rhs_family": "modal_mass_times_vector",
            "cpu_reference_schema_version": "poisson_airbox_modal_shift_invert_action.v1",
            "gpu_action_schema_version": "gpu_modal_shift_invert_action.v1",
            "full_modal_shift_invert_claim": True,
            "max_relative_action_error": 5.0e-10,
            "q_response_relative_l2_error": 4.0e-10,
            "shifted_system_relative_residual_cpu": 2.0e-11,
            "shifted_system_relative_residual_gpu": 3.0e-11,
            "per_iteration_h2d_count": 0,
            "per_iteration_d2h_count": 0,
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


def test_validator_accepts_true_modal_shift_invert_parity_artifact(
    tmp_path: Path,
) -> None:
    artifact = tmp_path / "gpu_modal_shift_invert_action_parity.v1.json"
    artifact.write_text(json.dumps(payload()), encoding="utf-8")

    result = run_validator(artifact)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_frequency_response_proxy(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_modal_shift_invert_action_parity.v1.json"
    bad = payload(
        gpu_modal_shift_invert_action_parity={
            "status": "passed",
            "operator_family": "frequency_response_shifted_linear_solve",
            "algebraic_action": "frequency_response_solve",
            "rhs_family": "dynamic_field_phasor",
            "cpu_reference_schema_version": "frequency_response_point.v1",
            "gpu_action_schema_version": "frequency_response_point.v1",
            "full_modal_shift_invert_claim": False,
            "max_relative_action_error": 0.0,
            "q_response_relative_l2_error": 0.0,
            "shifted_system_relative_residual_cpu": 0.0,
            "shifted_system_relative_residual_gpu": 0.0,
            "per_iteration_h2d_count": 0,
            "per_iteration_d2h_count": 0,
            "fallback_used": False,
        }
    )
    artifact.write_text(json.dumps(bad), encoding="utf-8")

    result = run_validator(artifact)

    assert result.returncode != 0
    assert "operator_family" in (result.stderr + result.stdout)


def test_validator_rejects_host_roundtrip_counts(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_modal_shift_invert_action_parity.v1.json"
    bad = payload(
        gpu_modal_shift_invert_action_parity={
            "status": "passed",
            "operator_family": "full_modal_shift_invert",
            "algebraic_action": "(A - sigma B)^-1 Bv",
            "rhs_family": "modal_mass_times_vector",
            "cpu_reference_schema_version": "poisson_airbox_modal_shift_invert_action.v1",
            "gpu_action_schema_version": "gpu_modal_shift_invert_action.v1",
            "full_modal_shift_invert_claim": True,
            "max_relative_action_error": 0.0,
            "q_response_relative_l2_error": 0.0,
            "shifted_system_relative_residual_cpu": 0.0,
            "shifted_system_relative_residual_gpu": 0.0,
            "per_iteration_h2d_count": 1,
            "per_iteration_d2h_count": 0,
            "fallback_used": False,
        }
    )
    artifact.write_text(json.dumps(bad), encoding="utf-8")

    result = run_validator(artifact)

    assert result.returncode != 0
    assert "per_iteration_h2d_count" in (result.stderr + result.stdout)


def test_validator_rejects_large_modal_action_error(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_modal_shift_invert_action_parity.v1.json"
    bad = payload(
        gpu_modal_shift_invert_action_parity={
            "status": "passed",
            "operator_family": "full_modal_shift_invert",
            "algebraic_action": "(A - sigma B)^-1 Bv",
            "rhs_family": "modal_mass_times_vector",
            "cpu_reference_schema_version": "poisson_airbox_modal_shift_invert_action.v1",
            "gpu_action_schema_version": "gpu_modal_shift_invert_action.v1",
            "full_modal_shift_invert_claim": True,
            "max_relative_action_error": 1.0e-3,
            "q_response_relative_l2_error": 0.0,
            "shifted_system_relative_residual_cpu": 0.0,
            "shifted_system_relative_residual_gpu": 0.0,
            "per_iteration_h2d_count": 0,
            "per_iteration_d2h_count": 0,
            "fallback_used": False,
        }
    )
    artifact.write_text(json.dumps(bad), encoding="utf-8")

    result = run_validator(artifact)

    assert result.returncode != 0
    assert "max_relative_action_error" in (result.stderr + result.stdout)
