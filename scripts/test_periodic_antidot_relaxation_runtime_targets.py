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
    assert (
        '-e FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT='
        '"${FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT:-}"'
    ) in target
    assert "--require-repeated-state-supercell-report" in target
    assert 'if [ "$scenario" = exchange_coupled ] && [ -n "${FULLMAG_PBC_RELAX_Z_PADDING_REPORT:-}" ]; then' in target
    assert 'if [ "$scenario" = exchange_coupled ] && [ -n "${FULLMAG_PBC_RELAX_SUPERCELL_REPORT:-}" ]; then' in target
    assert (
        'if [ "$scenario" = exchange_coupled ] && '
        '[ -n "${FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT:-}" ]; then'
    ) in target


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
    assert (
        '-e FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT='
        '"${FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT:-}"'
    ) in target
    assert "--require-repeated-state-supercell-report" in target
    assert 'if [ "$scenario" = exchange_coupled ] && [ -n "${FULLMAG_PBC_RELAX_Z_PADDING_REPORT:-}" ]; then' in target
    assert 'if [ "$scenario" = exchange_coupled ] && [ -n "${FULLMAG_PBC_RELAX_SUPERCELL_REPORT:-}" ]; then' in target
    assert (
        'if [ "$scenario" = exchange_coupled ] && '
        '[ -n "${FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT:-}" ]; then'
    ) in target


def test_static_pbc_demag_equilibrium_runtime_target_runs_cpu_and_gpu_gates() -> None:
    target = target_block("verify-fem-static-pbc-demag-equilibrium-runtime")

    assert 'test -n "${FULLMAG_PBC_RELAX_Z_PADDING_REPORT:-}"' in target
    assert 'FULLMAG_PBC_RELAX_SUPERCELL_REPORT or FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT' in target
    assert 'FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT' in target
    assert "just verify-fem-periodic-antidot-relaxation-runtime" in target
    assert "just verify-fem-periodic-antidot-relaxation-gpu-runtime" in target


def test_static_pbc_demag_uniform_slab_runtime_target_runs_cpu_and_gpu_controls() -> None:
    target = target_block("verify-fem-static-pbc-demag-uniform-slab-runtime")

    assert "just ensure-managed-fem-runtime" in target
    assert "examples/fem_periodic_uniform_slab_relax_exchange_coupled.py" in target
    assert ".fullmag/reports/fem-static-pbc-demag-uniform-slab-runtime/cpu/artifacts" in target
    assert ".fullmag/reports/fem-static-pbc-demag-uniform-slab-runtime/gpu/artifacts" in target
    assert "FULLMAG_FEM_EXECUTION=cpu" in target
    assert "FULLMAG_RELAX_DEVICE=cpu" in target
    assert "FULLMAG_FEM_EXECUTION=gpu" in target
    assert "FULLMAG_RELAX_DEVICE=gpu" in target
    assert "FULLMAG_FEM_GPU_DEMAG_MODE=device_hypre_poisson" in target
    assert "--scenario uniform_slab --engine cpu" in target
    assert "--scenario uniform_slab --engine gpu" in target
    assert "scripts/validate_fem_periodic_antidot_relaxation_artifacts.py" in target


def test_static_pbc_demag_equilibrium_repeated_state_target_generates_all_reports() -> None:
    target = target_block("verify-fem-static-pbc-demag-equilibrium-repeated-state-runtime")

    assert "just verify-fem-static-pbc-demag-z-padding-runtime" in target
    assert "just prepare-fem-static-pbc-demag-supercell-runtime-artifacts" in target
    assert "just write-fem-static-pbc-demag-supercell-diagnostic-report" in target
    assert "just verify-fem-static-pbc-demag-supercell-repeated-state-runtime-from-prepared" in target
    assert (
        "FULLMAG_PBC_RELAX_Z_PADDING_REPORT=.fullmag/reports/"
        "fem-static-pbc-demag-equilibrium-runtime/reports/z_padding_validation.v1.json"
    ) in target
    assert (
        "FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT=.fullmag/reports/"
        "fem-static-pbc-demag-supercell-repeated-state-runtime/reports/supercell_validation.v1.json"
    ) in target
    assert "just verify-fem-static-pbc-demag-equilibrium-runtime" in target


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
    assert "FULLMAG_PBC_RELAX_SUPERCELL_MAGNETIC_NODE_INDICES" not in target
    assert "FULLMAG_PBC_RELAX_SUPERCELL_FIELD_CELL_INDICES" not in target
    assert "FULLMAG_PBC_RELAX_SUPERCELL_CENTRAL_CELL_DEMAG_ENERGY_J" not in target
    assert "FULLMAG_PBC_RELAX_SUPERCELL_CENTRAL_CELL_TORQUE_APM" not in target
    assert "just write-fem-static-pbc-demag-supercell-central-cell-artifact-auto" in target
    assert "just verify-fem-static-pbc-demag-supercell-artifacts" in target
    assert ".fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/reports/supercell_validation.v1.json" in target


def test_static_pbc_demag_supercell_prepare_target_runs_unit_and_supercell_without_extraction_inputs() -> None:
    target = target_block("prepare-fem-static-pbc-demag-supercell-runtime-artifacts")

    assert "just ensure-managed-fem-runtime" in target
    assert "set -euo pipefail" in target
    assert "FULLMAG_FEM_EXECUTION=cpu" in target
    assert "FULLMAG_RELAX_DEVICE=cpu" in target
    assert 'FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}"' in target
    assert "examples/fem_periodic_antidot_relax_exchange_coupled.py" in target
    assert "examples/fem_periodic_antidot_relax_exchange_coupled_supercell_3x3.py" in target
    assert ".fullmag/reports/fem-static-pbc-demag-supercell-runtime/unit/artifacts" in target
    assert ".fullmag/reports/fem-static-pbc-demag-supercell-runtime/supercell/artifacts" in target
    assert "scripts/validate_fem_periodic_antidot_relaxation_artifacts.py" in target
    assert ".fullmag/reports/fem-static-pbc-demag-supercell-runtime/unit/runtime.log" in target
    assert ".fullmag/reports/fem-static-pbc-demag-supercell-runtime/supercell/runtime.log" in target
    assert "--supercell-repeat 3 3" in target
    assert "FULLMAG_PBC_RELAX_SUPERCELL_MAGNETIC_NODE_INDICES" not in target
    assert "write-fem-static-pbc-demag-supercell-central-cell-artifact" not in target
    assert "verify-fem-static-pbc-demag-supercell-artifacts" not in target


def test_static_pbc_demag_supercell_runtime_target_uses_auto_scalar_extraction() -> None:
    target = target_block("verify-fem-static-pbc-demag-supercell-runtime")

    assert "write-fem-static-pbc-demag-supercell-central-cell-artifact-auto" in target


def test_static_pbc_demag_supercell_diagnostic_report_target_allows_failed_status() -> None:
    target = target_block("write-fem-static-pbc-demag-supercell-diagnostic-report")

    assert "scripts/compare_fem_static_pbc_equilibrium_artifacts.py --allow-failed-status supercell" in target


def test_static_pbc_demag_supercell_interpolated_diagnostic_report_is_opt_in() -> None:
    target = target_block("write-fem-static-pbc-demag-supercell-interpolated-diagnostic-report")

    assert "scripts/compare_fem_static_pbc_equilibrium_artifacts.py --allow-failed-status supercell" in target
    assert "--include-interpolated-comparison" in target
    assert "supercell_interpolated_validation.v1.json" in target
    assert "verify-fem-static-pbc-demag-equilibrium-runtime" not in target


def test_static_pbc_demag_repeated_state_target_splits_prepared_artifacts() -> None:
    standalone = target_block("verify-fem-static-pbc-demag-supercell-repeated-state-runtime")
    prepared = target_block("verify-fem-static-pbc-demag-supercell-repeated-state-runtime-from-prepared")

    assert "just prepare-fem-static-pbc-demag-supercell-runtime-artifacts" in standalone
    assert "just verify-fem-static-pbc-demag-supercell-repeated-state-runtime-from-prepared" in standalone
    assert "just prepare-fem-static-pbc-demag-supercell-runtime-artifacts" not in prepared
    assert "just write-fem-static-pbc-demag-repeated-unit-initial-state" in prepared
    assert "central_cell_demag_energy_j" not in prepared
    assert "central_cell_torque_apm" not in prepared


def test_static_pbc_demag_repeated_unit_initial_state_target_writes_sampled_state() -> None:
    target = target_block("write-fem-static-pbc-demag-repeated-unit-initial-state")

    assert "scripts/write_fem_static_pbc_repeated_unit_initial_state.py" in target
    assert "--unit-cell" in target
    assert "--supercell" in target
    assert "--repeat-x" in target
    assert "--repeat-y" in target
    assert "--output" in target
    assert "--report" in target
    assert "--max-nearest-distance-m" in target


def test_static_pbc_demag_tiled_supercell_fixture_target_is_diagnostic() -> None:
    writer = target_block("write-fem-static-pbc-demag-tiled-supercell-fixture")
    verifier = target_block("verify-fem-static-pbc-demag-tiled-supercell-fixture")

    assert "scripts/write_fem_static_pbc_tiled_supercell_artifact.py" in writer
    assert "--unit-cell" in writer
    assert "--output" in writer
    assert "--repeat-x" in writer
    assert "--repeat-y" in writer
    assert "just write-fem-static-pbc-demag-tiled-supercell-fixture" in verifier
    assert "just verify-fem-static-pbc-demag-supercell-artifacts" in verifier
    assert "verify-fem-static-pbc-demag-equilibrium-runtime" not in verifier
    assert "ensure-managed-fem-runtime" not in verifier


def test_static_pbc_demag_supercell_repeated_state_runtime_uses_headless_initial_state_override() -> None:
    target = target_block("verify-fem-static-pbc-demag-supercell-repeated-state-runtime-from-prepared")

    assert "just prepare-fem-static-pbc-demag-supercell-runtime-artifacts" not in target
    assert 'FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}"' in target
    assert "just write-fem-static-pbc-demag-repeated-unit-initial-state" in target
    assert '"${FULLMAG_PBC_RELAX_REPEATED_STATE_MAX_NEAREST_DISTANCE_M:-1e-12}"' in target
    assert '"${FULLMAG_PBC_RELAX_REPEATED_STATE_MAX_NEAREST_DISTANCE_M:-1e-8}"' not in target
    assert "examples/fem_periodic_antidot_relax_exchange_coupled_supercell_3x3.py" in target
    assert "--initial-magnetization-state" in target
    assert ".fullmag/reports/fem-static-pbc-demag-supercell-repeated-state-runtime/supercell/artifacts" in target
    assert "scripts/validate_fem_periodic_antidot_relaxation_artifacts.py" in target
    assert "--supercell-repeat 3 3" in target
    assert "--require-initial-magnetization-state-override" in target
    assert "just write-fem-static-pbc-demag-supercell-central-cell-artifact-auto" in target
    assert "just verify-fem-static-pbc-demag-supercell-artifacts" in target
    assert ".fullmag/reports/fem-static-pbc-demag-supercell-repeated-state-runtime/reports/supercell_validation.v1.json" in target


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
    auto_target = target_block("write-fem-static-pbc-demag-supercell-central-cell-artifact-auto")

    assert "scripts/write_fem_static_pbc_supercell_central_cell_artifact.py" in target
    assert "--repeat-x" in target
    assert "--repeat-y" in target
    assert "--magnetic-node-indices" in target
    assert "--field-cell-indices" in target
    assert "--central-cell-demag-energy-j" in target
    assert "--central-cell-torque-apm" in target
    assert "--auto-central-cell-indices" in auto_target
    assert "--auto-central-cell-scalars" in auto_target
    assert "--magnetic-node-indices" not in auto_target
    assert "--field-cell-indices" not in auto_target
    assert "--central-cell-demag-energy-j" not in auto_target
    assert "--central-cell-torque-apm" not in auto_target


def test_static_pbc_demag_supercell_examples_export_h_eff_for_auto_torque() -> None:
    unit = (REPO_ROOT / "examples/fem_periodic_antidot_relax_exchange_coupled.py").read_text(encoding="utf-8")
    supercell = (REPO_ROOT / "examples/fem_periodic_antidot_relax_exchange_coupled_supercell_3x3.py").read_text(
        encoding="utf-8"
    )

    assert 'study.save("H_eff", every=10e-12)' in unit
    assert 'study.save("H_eff", every=10e-12)' in supercell
