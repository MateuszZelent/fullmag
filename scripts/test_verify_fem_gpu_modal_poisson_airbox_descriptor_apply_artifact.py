#!/usr/bin/env python3
"""Tests for GPU Poisson-airbox modal descriptor-apply artifact validation."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = (
    REPO_ROOT
    / "scripts"
    / "verify_fem_gpu_modal_poisson_airbox_descriptor_apply_artifact.py"
)


def payload(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "schema_version": "gpu_modal_poisson_airbox_descriptor_apply.v1",
        "status": "ok",
        "study_product": "modal_eigen",
        "lane": "gpu_poisson_airbox_k0",
        "execution_lane": "gpu_device_modal_descriptor_apply_contract",
        "solver_family": "modal_eigen",
        "operator_family": "full_coupled_poisson_airbox_modal_pencil",
        "algebraic_action": "A*x",
        "matrix_format": "csr_device_apply",
        "demag_kind": "periodic_airbox_k0",
        "gauge_policy": "mean_zero_augmented",
        "phasor_convention": "exp_plus_i_omega_t",
        "eigenvalue_convention": "lambda_imag_positive_frequency",
        "frequency_response_proxy": False,
        "gpu_device_resident_operator_apply": True,
        "cpu_fallback": "disabled",
        "fallback_used": False,
        "setup_h2d_count": 14,
        "result_d2h_count": 1,
        "per_iteration_h2d_count": 0,
        "per_iteration_d2h_count": 0,
        "q_dof_count": 2,
        "phi_dof_count": 2,
        "augmented_dof_count": 5,
        "metrics": {
            "input_l2_norm": 1.2,
            "output_l2_norm": 2.4,
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


def test_validator_accepts_gpu_modal_descriptor_apply_artifact(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_modal_poisson_airbox_descriptor_apply.v1.json"
    artifact.write_text(json.dumps(payload()), encoding="utf-8")

    result = run_validator(artifact)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_frequency_response_proxy(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_modal_poisson_airbox_descriptor_apply.v1.json"
    artifact.write_text(json.dumps(payload(frequency_response_proxy=True)), encoding="utf-8")

    result = run_validator(artifact)

    assert result.returncode != 0
    assert "frequency_response_proxy" in (result.stderr + result.stdout)


def test_validator_rejects_dense_matrix_format(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_modal_poisson_airbox_descriptor_apply.v1.json"
    artifact.write_text(json.dumps(payload(matrix_format="dense_host_apply")), encoding="utf-8")

    result = run_validator(artifact)

    assert result.returncode != 0
    assert "matrix_format" in (result.stderr + result.stdout)


def test_validator_rejects_cpu_fallback(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_modal_poisson_airbox_descriptor_apply.v1.json"
    artifact.write_text(json.dumps(payload(cpu_fallback="enabled", fallback_used=True)), encoding="utf-8")

    result = run_validator(artifact)

    assert result.returncode != 0
    assert "cpu_fallback" in (result.stderr + result.stdout)


def test_validator_rejects_per_iteration_host_roundtrip(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_modal_poisson_airbox_descriptor_apply.v1.json"
    artifact.write_text(json.dumps(payload(per_iteration_d2h_count=1)), encoding="utf-8")

    result = run_validator(artifact)

    assert result.returncode != 0
    assert "per_iteration_d2h_count" in (result.stderr + result.stdout)


def test_validator_rejects_bad_augmented_dimension(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_modal_poisson_airbox_descriptor_apply.v1.json"
    artifact.write_text(json.dumps(payload(augmented_dof_count=4)), encoding="utf-8")

    result = run_validator(artifact)

    assert result.returncode != 0
    assert "augmented_dof_count" in (result.stderr + result.stdout)
