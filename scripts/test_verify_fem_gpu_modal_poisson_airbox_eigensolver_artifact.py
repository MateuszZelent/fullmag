#!/usr/bin/env python3
"""Tests for GPU Poisson-airbox modal eigensolver artifact validation."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = (
    REPO_ROOT
    / "scripts"
    / "verify_fem_gpu_modal_poisson_airbox_eigensolver_artifact.py"
)


def payload(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "schema_version": "gpu_modal_poisson_airbox_eigensolver.v1",
        "status": "ok",
        "study_product": "modal_eigen",
        "lane": "gpu_poisson_airbox_k0",
        "execution_lane": "gpu_device_modal_eigen_dense_contract",
        "solver_adapter": "gpu_dense_poisson_airbox_modal_eigen_contract",
        "solver_family": "modal_eigen",
        "solver_library": "cuda_dense_inverse_iteration",
        "demag_kind": "periodic_airbox_k0",
        "gauge_policy": "mean_zero_augmented",
        "phasor_convention": "exp_plus_i_omega_t",
        "eigenvalue_convention": "lambda_imag_positive_frequency",
        "operator_family": "full_coupled_poisson_airbox_modal_pencil",
        "spectral_transform": "shift_invert",
        "frequency_response_proxy": False,
        "gpu_device_resident_modal_eigensolver": True,
        "cpu_fallback": "disabled",
        "fallback_used": False,
        "per_iteration_h2d_count": 0,
        "per_iteration_d2h_count": 0,
        "q_dof_count": 2,
        "phi_dof_count": 2,
        "augmented_dof_count": 5,
        "max_iterations": 24,
        "sigma": {"real": 0.0, "imag": 7.853981633974483e9},
        "eigenpair": {
            "eigenvalue_real": 5.2e-7,
            "eigenvalue_imag": 1.2641148128614887e10,
            "omega_rad_s": 1.2641148128614887e10,
            "frequency_hz": 2.0119012110259216e9,
        },
        "metrics": {
            "relative_reference_frequency_error": 1.0e-12,
            "full_descriptor_relative_residual": 2.0e-12,
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


def test_validator_accepts_gpu_modal_poisson_airbox_eigensolver_artifact(
    tmp_path: Path,
) -> None:
    artifact = tmp_path / "gpu_modal_poisson_airbox_eigensolver.v1.json"
    artifact.write_text(json.dumps(payload()), encoding="utf-8")

    result = run_validator(artifact)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_frequency_response_proxy(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_modal_poisson_airbox_eigensolver.v1.json"
    bad = payload(frequency_response_proxy=True)
    artifact.write_text(json.dumps(bad), encoding="utf-8")

    result = run_validator(artifact)

    assert result.returncode != 0
    assert "frequency_response_proxy" in (result.stderr + result.stdout)


def test_validator_rejects_cpu_fallback(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_modal_poisson_airbox_eigensolver.v1.json"
    bad = payload(cpu_fallback="enabled", fallback_used=True)
    artifact.write_text(json.dumps(bad), encoding="utf-8")

    result = run_validator(artifact)

    assert result.returncode != 0
    assert "cpu_fallback" in (result.stderr + result.stdout)


def test_validator_rejects_per_iteration_host_roundtrip(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_modal_poisson_airbox_eigensolver.v1.json"
    bad = payload(per_iteration_h2d_count=1)
    artifact.write_text(json.dumps(bad), encoding="utf-8")

    result = run_validator(artifact)

    assert result.returncode != 0
    assert "per_iteration_h2d_count" in (result.stderr + result.stdout)


def test_validator_rejects_large_reference_error(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_modal_poisson_airbox_eigensolver.v1.json"
    bad = payload(
        metrics={
            "relative_reference_frequency_error": 1.0e-2,
            "full_descriptor_relative_residual": 2.0e-12,
        }
    )
    artifact.write_text(json.dumps(bad), encoding="utf-8")

    result = run_validator(artifact)

    assert result.returncode != 0
    assert "relative_reference_frequency_error" in (result.stderr + result.stdout)


def test_validator_rejects_large_descriptor_residual(tmp_path: Path) -> None:
    artifact = tmp_path / "gpu_modal_poisson_airbox_eigensolver.v1.json"
    bad = payload(
        metrics={
            "relative_reference_frequency_error": 1.0e-12,
            "full_descriptor_relative_residual": 1.0e-2,
        }
    )
    artifact.write_text(json.dumps(bad), encoding="utf-8")

    result = run_validator(artifact)

    assert result.returncode != 0
    assert "full_descriptor_relative_residual" in (result.stderr + result.stdout)
