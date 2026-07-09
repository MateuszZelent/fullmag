#!/usr/bin/env python3
"""Tests for writing GPU Schur-apply parity artifacts from diagnostics."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
WRITER = REPO_ROOT / "scripts" / "write_fem_gpu_schur_apply_parity_artifact.py"
VALIDATOR = REPO_ROOT / "scripts" / "verify_fem_gpu_schur_apply_parity_artifact.py"


def write_gpu_bundle(
    root: Path,
    *,
    uses_gpu_poisson: bool = True,
    hypre_execution_policy: str = "device",
    demag_provider_residency: str = "gpu",
    validation_fallback_used: bool = False,
    probe_available: bool = True,
    complex_operator_error: float = 5.0e-10,
) -> None:
    diagnostics = root / "response" / "diagnostics"
    diagnostics.mkdir(parents=True)
    solver = {
        "uses_gpu_poisson": uses_gpu_poisson,
        "hypre_execution_policy": hypre_execution_policy,
        "demag_provider_residency": demag_provider_residency,
        "validation_fallback_used": validation_fallback_used,
        "gpu_operator_parity_probe_available": probe_available,
        "dynamic_demag_operator_source": "matrix_free_mfem_demag_phi_consistency_schur_provider",
        "dynamic_demag_matrix_form": "schur_phi_consistency_provider",
        "gpu_reduced_complex_operator_parity_relative_l2_error": complex_operator_error,
        "gpu_reduced_complex_real_stiffness_parity_relative_l2_error": 4.0e-10,
        "gpu_reduced_complex_imag_stiffness_parity_relative_l2_error": 4.0e-10,
        "gpu_reduced_complex_real_mass_parity_relative_l2_error": 0.0,
        "gpu_reduced_complex_imag_mass_parity_relative_l2_error": 0.0,
        "gpu_reduced_complex_real_demag_tangent_parity_relative_l2_error": 5.0e-10,
        "gpu_reduced_split_vs_gmres_formula_relative_l2_error": 4.0e-10,
        "gpu_reduced_gmres_formula_operator_parity_relative_l2_error": 4.0e-10,
    }
    (diagnostics / "solver.v1.json").write_text(json.dumps(solver), encoding="utf-8")


def run_writer(gpu: Path, output: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(WRITER), str(gpu), str(output)],
        cwd=REPO_ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def run_validator(path: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(VALIDATOR), str(path)],
        cwd=REPO_ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def test_writer_emits_valid_gpu_schur_apply_parity_artifact(tmp_path: Path) -> None:
    gpu = tmp_path / "gpu"
    output = tmp_path / "gpu_schur_apply_parity.v1.json"
    write_gpu_bundle(gpu)

    result = run_writer(gpu, output)

    assert result.returncode == 0, result.stderr + result.stdout
    assert run_validator(output).returncode == 0
    payload = json.loads(output.read_text(encoding="utf-8"))
    parity = payload["gpu_schur_apply_parity"]
    assert parity["status"] == "passed"
    assert parity["max_relative_schur_apply_error"] <= 1.0e-6


def test_writer_rejects_gpu_bundle_without_device_poisson(tmp_path: Path) -> None:
    gpu = tmp_path / "gpu"
    output = tmp_path / "gpu_schur_apply_parity.v1.json"
    write_gpu_bundle(gpu, uses_gpu_poisson=False)

    result = run_writer(gpu, output)

    assert result.returncode != 0
    assert "uses_gpu_poisson" in (result.stderr + result.stdout)
    assert not output.exists()


def test_writer_rejects_large_operator_mismatch(tmp_path: Path) -> None:
    gpu = tmp_path / "gpu"
    output = tmp_path / "gpu_schur_apply_parity.v1.json"
    write_gpu_bundle(gpu, complex_operator_error=1.0e-3)

    result = run_writer(gpu, output)

    assert result.returncode != 0
    assert "gpu_reduced_complex_operator_parity_relative_l2_error" in (
        result.stderr + result.stdout
    )
    assert not output.exists()
