#!/usr/bin/env python3
"""Static checks for periodic-antidot FEM relaxation managed runtime targets."""

from __future__ import annotations

import re
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
JUSTFILE = REPO_ROOT / "justfile"


def target_block(name: str) -> str:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    match = re.search(rf"^{re.escape(name)}(?:\s[^\n:]*)?:", justfile, flags=re.MULTILINE)
    assert match is not None
    target_start = match.start()
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


def test_periodic_antidot_relaxation_runtime_target_can_require_static_comparison_reports() -> None:
    target = target_block("verify-fem-periodic-antidot-relaxation-runtime")

    assert '-e FULLMAG_PBC_RELAX_Z_PADDING_REPORT="${FULLMAG_PBC_RELAX_Z_PADDING_REPORT:-}"' in target
    assert "--require-z-padding-report" in target
    assert '-e FULLMAG_PBC_RELAX_SUPERCELL_REPORT="${FULLMAG_PBC_RELAX_SUPERCELL_REPORT:-}"' in target
    assert "--require-supercell-report" in target


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


def test_periodic_antidot_relaxation_gpu_runtime_target_can_require_static_comparison_reports() -> None:
    target = target_block("verify-fem-periodic-antidot-relaxation-gpu-runtime")

    assert '-e FULLMAG_PBC_RELAX_Z_PADDING_REPORT="${FULLMAG_PBC_RELAX_Z_PADDING_REPORT:-}"' in target
    assert "--require-z-padding-report" in target
    assert '-e FULLMAG_PBC_RELAX_SUPERCELL_REPORT="${FULLMAG_PBC_RELAX_SUPERCELL_REPORT:-}"' in target
    assert "--require-supercell-report" in target


def test_static_pbc_demag_equilibrium_runtime_target_runs_cpu_and_gpu_gates() -> None:
    target = target_block("verify-fem-static-pbc-demag-equilibrium-runtime")

    assert 'test -n "${FULLMAG_PBC_RELAX_Z_PADDING_REPORT:-}"' in target
    assert 'test -n "${FULLMAG_PBC_RELAX_SUPERCELL_REPORT:-}"' in target
    assert "just verify-fem-periodic-antidot-relaxation-runtime" in target
    assert "just verify-fem-periodic-antidot-relaxation-gpu-runtime" in target


def test_static_pbc_demag_z_padding_runtime_target_runs_candidate_and_reference() -> None:
    target = target_block("verify-fem-static-pbc-demag-z-padding-runtime")

    assert "just ensure-managed-fem-runtime" in target
    assert "set -euo pipefail" in target
    assert "FULLMAG_FEM_EXECUTION=cpu" in target
    assert "FULLMAG_RELAX_DEVICE=cpu" in target
    assert "examples/fem_periodic_antidot_relax_exchange_coupled.py" in target
    assert "examples/fem_periodic_antidot_relax_exchange_coupled_z_padding_reference.py" in target
    assert ".fullmag/reports/fem-static-pbc-demag-z-padding-runtime/candidate/artifacts" in target
    assert ".fullmag/reports/fem-static-pbc-demag-z-padding-runtime/reference/artifacts" in target
    assert "just verify-fem-static-pbc-demag-z-padding-artifacts" in target
    assert ".fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/reports/z_padding_validation.v1.json" in target


def test_static_pbc_demag_supercell_runtime_target_runs_unit_supercell_and_report_writer() -> None:
    target = target_block("verify-fem-static-pbc-demag-supercell-runtime")

    assert "just prepare-fem-static-pbc-demag-supercell-runtime-artifacts" in target
    assert "FULLMAG_PBC_RELAX_SUPERCELL_MAGNETIC_NODE_INDICES" in target
    assert "FULLMAG_PBC_RELAX_SUPERCELL_FIELD_CELL_INDICES" in target
    assert "FULLMAG_PBC_RELAX_SUPERCELL_CENTRAL_CELL_DEMAG_ENERGY_J" in target
    assert "FULLMAG_PBC_RELAX_SUPERCELL_CENTRAL_CELL_TORQUE_APM" in target
    assert "just write-fem-static-pbc-demag-supercell-central-cell-artifact" in target
    assert "just verify-fem-static-pbc-demag-supercell-artifacts" in target
    assert ".fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/reports/supercell_validation.v1.json" in target


def test_static_pbc_demag_supercell_prepare_target_runs_unit_and_supercell_without_extraction_inputs() -> None:
    target = target_block("prepare-fem-static-pbc-demag-supercell-runtime-artifacts")

    assert "just ensure-managed-fem-runtime" in target
    assert "set -euo pipefail" in target
    assert "FULLMAG_FEM_EXECUTION=cpu" in target
    assert "FULLMAG_RELAX_DEVICE=cpu" in target
    assert "examples/fem_periodic_antidot_relax_exchange_coupled.py" in target
    assert "examples/fem_periodic_antidot_relax_exchange_coupled_supercell_3x3.py" in target
    assert ".fullmag/reports/fem-static-pbc-demag-supercell-runtime/unit/artifacts" in target
    assert ".fullmag/reports/fem-static-pbc-demag-supercell-runtime/supercell/artifacts" in target
    assert "FULLMAG_PBC_RELAX_SUPERCELL_MAGNETIC_NODE_INDICES" not in target
    assert "write-fem-static-pbc-demag-supercell-central-cell-artifact" not in target
    assert "verify-fem-static-pbc-demag-supercell-artifacts" not in target


def test_static_pbc_demag_supercell_runtime_target_rejects_missing_inputs_before_runtime_rebuild() -> None:
    target = target_block("verify-fem-static-pbc-demag-supercell-runtime")

    assert target.index('test -n "${FULLMAG_PBC_RELAX_SUPERCELL_MAGNETIC_NODE_INDICES:-}"') < target.index(
        "just prepare-fem-static-pbc-demag-supercell-runtime-artifacts"
    )
    assert target.index('test -n "${FULLMAG_PBC_RELAX_SUPERCELL_FIELD_CELL_INDICES:-}"') < target.index(
        "just prepare-fem-static-pbc-demag-supercell-runtime-artifacts"
    )
    assert target.index('test -n "${FULLMAG_PBC_RELAX_SUPERCELL_CENTRAL_CELL_DEMAG_ENERGY_J:-}"') < target.index(
        "just prepare-fem-static-pbc-demag-supercell-runtime-artifacts"
    )
    assert target.index('test -n "${FULLMAG_PBC_RELAX_SUPERCELL_CENTRAL_CELL_TORQUE_APM:-}"') < target.index(
        "just prepare-fem-static-pbc-demag-supercell-runtime-artifacts"
    )


def test_static_pbc_demag_report_targets_call_static_artifact_comparator() -> None:
    z_padding_target = target_block("verify-fem-static-pbc-demag-z-padding-artifacts")
    supercell_target = target_block("verify-fem-static-pbc-demag-supercell-artifacts")

    assert "scripts/compare_fem_static_pbc_equilibrium_artifacts.py z-padding" in z_padding_target
    assert "--reference" in z_padding_target
    assert "--candidate" in z_padding_target
    assert "--report" in z_padding_target
    assert "scripts/compare_fem_static_pbc_equilibrium_artifacts.py supercell" in supercell_target
    assert "--unit-cell" in supercell_target
    assert "--supercell" in supercell_target
    assert "--repeat-x" in supercell_target
    assert "--repeat-y" in supercell_target


def test_static_pbc_demag_supercell_central_cell_target_writes_extraction_artifact() -> None:
    target = target_block("write-fem-static-pbc-demag-supercell-central-cell-artifact")

    assert "scripts/write_fem_static_pbc_supercell_central_cell_artifact.py" in target
    assert "--repeat-x" in target
    assert "--repeat-y" in target
    assert "--magnetic-node-indices" in target
    assert "--field-cell-indices" in target
    assert "--central-cell-demag-energy-j" in target
    assert "--central-cell-torque-apm" in target
