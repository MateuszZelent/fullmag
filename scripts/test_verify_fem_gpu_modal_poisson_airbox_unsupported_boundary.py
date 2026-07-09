#!/usr/bin/env python3
"""Tests for GPU modal Poisson-airbox unsupported-boundary validation."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "verify_fem_gpu_modal_poisson_airbox_unsupported_boundary.py"


def write_boundary(path: Path, **overrides: object) -> None:
    payload: dict[str, object] = {
        "schema_version": "gpu_modal_poisson_airbox_unsupported_boundary.v1",
        "lane": "gpu_modal_poisson_airbox_k0",
        "case_id": "K0-3",
        "demag_kind": "periodic_airbox_k0",
        "requested_device": "gpu",
        "gpu_device_resident_modal_eigensolver": False,
        "cpu_fallback": "disabled",
        "status": "unsupported_until_pa_g_parity_runtime",
        "required_diagnostic_fragments": [
            "GPU modal K0/Kittel with demag",
            "CPU fallback",
            "disabled",
        ],
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


def test_validator_accepts_gpu_modal_poisson_airbox_unsupported_boundary(
    tmp_path: Path,
) -> None:
    boundary = tmp_path / "unsupported_boundary.v1.json"
    write_boundary(boundary)

    result = run_validator(boundary)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_device_resident_gpu_modal_claim(
    tmp_path: Path,
) -> None:
    boundary = tmp_path / "unsupported_boundary.v1.json"
    write_boundary(boundary, gpu_device_resident_modal_eigensolver=True)

    result = run_validator(boundary)

    assert result.returncode != 0
    assert "gpu_device_resident_modal_eigensolver" in (result.stderr + result.stdout)

