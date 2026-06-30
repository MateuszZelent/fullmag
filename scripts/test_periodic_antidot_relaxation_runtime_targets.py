#!/usr/bin/env python3
"""Static checks for periodic-antidot FEM relaxation managed runtime targets."""

from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
JUSTFILE = REPO_ROOT / "justfile"


def target_block(name: str) -> str:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    target_start = justfile.find(f"{name}:")
    assert target_start != -1
    next_target = justfile.find("\n\n", target_start + 1)
    return justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]


def test_periodic_antidot_relaxation_runtime_target_runs_both_pbc_scenarios() -> None:
    target = target_block("verify-fem-periodic-antidot-relaxation-runtime")

    assert "just ensure-managed-fem-runtime" in target
    assert "examples/fem_periodic_antidot_relax_exchange_coupled.py" in target
    assert "examples/fem_periodic_antidot_relax_air_gap.py" in target
    assert "scripts/validate_fem_periodic_antidot_relaxation_artifacts.py" in target
    assert "set -euo pipefail" in target
    assert "for scenario_script in" in target
    assert 'scenario="${scenario_script%%:*}"' in target
    assert 'script="${scenario_script#*:}"' in target
    assert '--scenario "$scenario"' in target
    assert "FULLMAG_PBC_RELAX_SCENARIO" not in target
    assert "FULLMAG_PBC_RELAX_FAST_RUNTIME_MESH" not in target
    assert "FULLMAG_PBC_RELAX_MAX_STEPS" not in target
    assert ".fullmag/reports/fem-periodic-antidot-relaxation-runtime" in target


def test_periodic_antidot_relaxation_gpu_runtime_target_runs_both_pbc_scenarios() -> None:
    target = target_block("verify-fem-periodic-antidot-relaxation-gpu-runtime")

    assert "just ensure-managed-fem-runtime" in target
    assert "examples/fem_periodic_antidot_relax_exchange_coupled.py" in target
    assert "examples/fem_periodic_antidot_relax_air_gap.py" in target
    assert "scripts/validate_fem_periodic_antidot_relaxation_artifacts.py" in target
    assert "set -euo pipefail" in target
    assert "FULLMAG_FEM_EXECUTION=gpu" in target
    assert "FULLMAG_RELAX_DEVICE=gpu" in target
    assert "FULLMAG_FEM_MFEM_DEVICE=cuda" in target
    assert "FULLMAG_FEM_GPU_DEMAG_MODE=device_hypre_poisson" in target
    assert "--engine gpu" in target
    assert "for scenario_script in" in target
    assert ".fullmag/reports/fem-periodic-antidot-relaxation-gpu-runtime" in target
