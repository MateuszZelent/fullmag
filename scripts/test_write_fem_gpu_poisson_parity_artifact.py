#!/usr/bin/env python3
"""Tests for writing GPU Poisson parity artifacts from CPU/GPU response bundles."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
WRITER = REPO_ROOT / "scripts" / "write_fem_gpu_poisson_parity_artifact.py"
VALIDATOR = REPO_ROOT / "scripts" / "verify_fem_gpu_poisson_parity_artifact.py"


def write_response_bundle(
    root: Path,
    *,
    lane: str,
    delta_phi: list[list[float]] | None = None,
    h_demag: list[list[float]] | None = None,
    uses_gpu_poisson: bool = False,
    hypre_execution_policy: str = "host",
    demag_provider_residency: str = "cpu",
    validation_fallback_used: bool = False,
) -> None:
    diagnostics = root / "response" / "diagnostics"
    frequency_points = root / "response" / "frequency_points"
    diagnostics.mkdir(parents=True)
    frequency_points.mkdir(parents=True)

    if delta_phi is None:
        delta_phi = [[1.0, 0.0], [0.0, 2.0]]
    if h_demag is None:
        h_demag = [[3.0, 0.0], [0.0, 4.0]]

    solver = {
        "resolved_execution_lane": f"production_{lane}",
        "uses_gpu_poisson": uses_gpu_poisson,
        "hypre_execution_policy": hypre_execution_policy,
        "demag_provider_residency": demag_provider_residency,
        "validation_fallback_used": validation_fallback_used,
    }
    (diagnostics / "solver.v1.json").write_text(json.dumps(solver), encoding="utf-8")

    point = {
        "demag_contribution": {
            "status": "solved",
            "delta_phi_complex": delta_phi,
            "h_demag_complex": h_demag,
        }
    }
    (frequency_points / "frequency_0000.json").write_text(
        json.dumps(point),
        encoding="utf-8",
    )


def run_writer(cpu: Path, gpu: Path, output: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(WRITER), str(cpu), str(gpu), str(output)],
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


def test_writer_emits_valid_gpu_poisson_parity_artifact(tmp_path: Path) -> None:
    cpu = tmp_path / "cpu"
    gpu = tmp_path / "gpu"
    output = tmp_path / "gpu_poisson_parity.v1.json"
    write_response_bundle(cpu, lane="cpu")
    write_response_bundle(
        gpu,
        lane="gpu",
        delta_phi=[[1.0 + 1.0e-8, 0.0], [0.0, 2.0]],
        h_demag=[[3.0, 0.0], [0.0, 4.0 + 1.0e-8]],
        uses_gpu_poisson=True,
        hypre_execution_policy="device",
        demag_provider_residency="gpu",
    )

    result = run_writer(cpu, gpu, output)

    assert result.returncode == 0, result.stderr + result.stdout
    assert run_validator(output).returncode == 0
    payload = json.loads(output.read_text(encoding="utf-8"))
    assert payload["gpu_poisson_parity"]["status"] == "passed"
    assert payload["gpu_poisson_parity"]["max_relative_phi_error"] <= 1.0e-6
    assert payload["gpu_poisson_parity"]["max_relative_field_error"] <= 1.0e-6


def test_writer_rejects_gpu_bundle_without_device_poisson(tmp_path: Path) -> None:
    cpu = tmp_path / "cpu"
    gpu = tmp_path / "gpu"
    output = tmp_path / "gpu_poisson_parity.v1.json"
    write_response_bundle(cpu, lane="cpu")
    write_response_bundle(gpu, lane="gpu", uses_gpu_poisson=False)

    result = run_writer(cpu, gpu, output)

    assert result.returncode != 0
    assert "uses_gpu_poisson" in (result.stderr + result.stdout)
    assert not output.exists()


def test_writer_rejects_large_delta_phi_mismatch(tmp_path: Path) -> None:
    cpu = tmp_path / "cpu"
    gpu = tmp_path / "gpu"
    output = tmp_path / "gpu_poisson_parity.v1.json"
    write_response_bundle(cpu, lane="cpu")
    write_response_bundle(
        gpu,
        lane="gpu",
        delta_phi=[[1.1, 0.0], [0.0, 2.0]],
        uses_gpu_poisson=True,
        hypre_execution_policy="device",
        demag_provider_residency="gpu",
    )

    result = run_writer(cpu, gpu, output)

    assert result.returncode != 0
    assert "max_relative_phi_error" in (result.stderr + result.stdout)
    assert not output.exists()
