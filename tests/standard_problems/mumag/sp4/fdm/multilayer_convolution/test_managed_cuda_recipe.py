"""Contract for the managed native CUDA D-07 runtime gate."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from fullmag.runtime.loader import load_problem_from_script


REPOSITORY_ROOT = Path(__file__).resolve().parents[6]
SCENARIO = Path(__file__).with_name("scenario_l3_cuda_v2_small.py")


def test_cuda_v2_scenario_forces_identity_grid_with_distinct_materials() -> None:
    loaded = load_problem_from_script(SCENARIO, lightweight_assets=True)
    ir = loaded.problem.to_ir()
    hints = ir["backend_policy"]["discretization_hints"]["fdm"]

    assert hints["demag"] == {
        "strategy": "multilayer_convolution",
        "mode": "three_d",
        "common_cells": [8, 4, 2],
    }
    saturation_values = {
        material["saturation_magnetisation"] for material in ir["materials"]
    }
    assert saturation_values == {7.8e5, 8.0e5, 8.2e5}


@pytest.mark.parametrize("lane", ["cuda-fp64", "cuda-fp32"])
def test_managed_cuda_recipe_runs_real_device_and_fail_closed_verifier(
    lane: str,
) -> None:
    result = subprocess.run(
        ["just", "--dry-run", "verify-fdm-multilayer-cuda-runtime", lane],
        cwd=REPOSITORY_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    rendered = result.stdout + result.stderr
    assert "docker compose --profile fem-gpu run --rm --no-deps" in rendered
    assert "nvidia-smi -L" in rendered
    assert "scenario_l3_cuda_v2_small.py" in rendered
    assert "verify_fdm_multilayer_cuda_parity.py" in rendered
    assert "d07_telemetry_not_qualified" in rendered
    assert "cpu_cuda_parity_not_qualified" in rendered
    assert ".build_identity.source_snapshot_sha256" in rendered
    assert "managed_runtime_source_snapshot_mismatch" in rendered
    assert "source_drift_after_runtime" in rendered
    assert "input_hash_drift_after_runtime" in rendered
    assert "source_hash_drift_after_runtime" in rendered
    assert "managed_runtime_manifest_drift_after_runtime" in rendered
    manifest_guard = rendered.index("managed_runtime_manifest_drift_after_runtime")
    verified_write = rendered.index(r'\"status\":\"verified\"')
    assert manifest_guard < verified_write
