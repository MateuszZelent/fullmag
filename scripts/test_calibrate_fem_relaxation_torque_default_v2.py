from __future__ import annotations

import importlib.util
from itertools import product
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parent / "analysis" / "calibrate_fem_relaxation_torque_default.py"


def load_module():
    spec = importlib.util.spec_from_file_location("relax_torque_calibration_v2", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def suite() -> dict[str, object]:
    return {
        "schema": "fullmag.relaxation_torque_calibration_suite.v2",
        "runtime_manifest_sha256": "runtime-v2",
        "source_snapshot_sha256": "source-v2",
        "problem_ir_sha256": "problem-v2",
        "meshes": [
            {"id": "coarse", "solver_mesh_signature": "mesh-coarse"},
            {"id": "medium", "solver_mesh_signature": "mesh-medium"},
            {"id": "fine", "solver_mesh_signature": "mesh-fine"},
        ],
        "algorithms": ["projected_gradient_bb", "nonlinear_cg", "llg_overdamped"],
        "scenarios": [
            {"id": "exchange_only", "initial_state_identity": "uniform_x"},
            {"id": "exchange_demag", "initial_state_identity": "uniform_x"},
            {
                "id": "exchange_demag_uniaxial",
                "initial_state_identity": "uniform_x",
            },
            {
                "id": "box500_airbox_exchange_demag_multidomain",
                "initial_state_identity": "explicit_multidomain_v1",
            },
        ],
        "backends": ["fem_cpu", "fem_gpu"],
        "repeats": 3,
        "step_budgets": [128, 256, 512],
        "llg_timestep_policies": ["fixed", "adaptive"],
    }


def rows_for_suite(*, algorithm: str = "", include_all: bool = True) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    algorithms = [algorithm] if algorithm else suite()["algorithms"]
    scenarios = suite()["scenarios"]
    for algo, scenario, mesh, backend, repeat, steps, llg_policy in product(
        algorithms,
        scenarios,
        suite()["meshes"],
        suite()["backends"],
        range(3),
        suite()["step_budgets"],
        suite()["llg_timestep_policies"],
    ):
        scenario_id = scenario["id"]
        is_llg = algo == "llg_overdamped"
        rows.append(
            {
                "status": "ok",
                "runtime_manifest_sha256": "runtime-v2",
                "source_snapshot_sha256": "source-v2",
                "problem_ir_sha256": "problem-v2",
                "backend": backend,
                "relaxation_algorithm": algo,
                "algorithm": algo,
                "scenario": scenario_id,
                "initial_state_identity": scenario["initial_state_identity"],
                "solver_mesh_signature": mesh["solver_mesh_signature"],
                "integrator": "rk23" if is_llg else "none",
                "timestep_policy": llg_policy if is_llg else "budget",
                "repeat_index": str(repeat),
                "steps": str(steps),
                "step_budget": str(steps),
                "final_torque_apm": str(
                    4.0 if steps == 512 else 100.0 if steps == 128 else 4.2
                ),
                "final_e_total_j": str(-1.0e-18 - (steps / 1.0e24)),
                "norm_defect": "1e-12",
                "stop_reason": "max_steps",
                "converged": "false",
                "case_timeout_s": "900",
            }
        )
    return rows


def test_v2_requires_complete_algorithm_mesh_backend_repeat_and_scenario_matrix() -> None:
    module = load_module()
    errors = module.validate_calibration_suite(suite(), rows_for_suite())
    assert errors == []

    incomplete = suite()
    incomplete["algorithms"] = ["llg_overdamped"]
    incomplete["meshes"] = incomplete["meshes"][:2]
    incomplete["backends"] = ["fem_cpu"]
    incomplete["repeats"] = 1
    incomplete["scenarios"] = incomplete["scenarios"][:2]
    errors = module.validate_calibration_suite(incomplete, rows_for_suite(algorithm="llg_overdamped"))
    assert any("algorithm" in error for error in errors)
    assert any("mesh" in error for error in errors)
    assert any("backend" in error for error in errors)
    assert any("repeat" in error for error in errors)
    assert any("scenario" in error for error in errors)


def test_v2_rejects_mixed_runtime_or_undocumented_timeout() -> None:
    module = load_module()
    rows = rows_for_suite()
    rows[0]["runtime_manifest_sha256"] = "different-runtime"
    rows[1]["stop_reason"] = "timeout"
    errors = module.validate_calibration_suite(suite(), rows)
    assert any("runtime" in error for error in errors)
    assert any("timeout" in error for error in errors)


def test_v2_case_key_keeps_algorithm_and_initial_state_distinct() -> None:
    module = load_module()
    first = rows_for_suite()[0]
    second = dict(first, algorithm="nonlinear_cg", relaxation_algorithm="nonlinear_cg")
    third = dict(first, initial_state_identity="explicit_multidomain_v1")
    assert module.calibration_case_key(first) != module.calibration_case_key(second)
    assert module.calibration_case_key(first) != module.calibration_case_key(third)


def test_v2_produces_universal_decision_only_after_plateau_and_energy_checks() -> None:
    module = load_module()
    result = module.analyze_rows_v2(rows_for_suite(), suite=suite())
    assert result["schema"] == "fullmag.relaxation_torque_calibration.v2"
    assert result["decision"] == "universal_qualified"
    assert result["recommended_torque_tolerance_apm"] is not None
    assert set(result["algorithm_recommendations"]) == {
        "projected_gradient_bb",
        "nonlinear_cg",
        "llg_overdamped",
    }

    rows = rows_for_suite()
    for row in rows:
        if row["algorithm"] == "nonlinear_cg" and row["steps"] == "512":
            row["final_e_total_j"] = "-1e-12"
    result = module.analyze_rows_v2(rows, suite=suite())
    assert result["decision"] == "no_qualified_default"
    assert any("energy" in failure for failure in result["failures"])


def test_v2_never_returns_default_for_missing_algorithm_envelope() -> None:
    module = load_module()
    rows = rows_for_suite(algorithm="projected_gradient_bb")
    result = module.analyze_rows_v2(rows, suite=suite())
    assert result["decision"] == "no_qualified_default"
    assert result["recommended_torque_tolerance_apm"] is None
    assert result["algorithm_recommendations"] == {}


def test_legacy_v1_analyzer_is_not_the_cli_schema() -> None:
    module = load_module()
    result = module.analyze_rows_v2(rows_for_suite(), suite=suite())
    assert result["schema"] != "fullmag.relaxation-torque-calibration.v1"


def test_v2_recipe_mounts_runtime_and_uses_full_matrix_defaults() -> None:
    justfile = (SCRIPT.parents[2] / "justfile").read_text(encoding="utf-8")
    assert "calibrate-fem-relaxation-torque-default-v2:" in justfile
    recipe = justfile.split("calibrate-fem-relaxation-torque-default-v2:", 1)[1]
    assert "-v \"$runtime_root:/workspace/.fullmag/runtime:ro\"" in recipe
    assert "FULLMAG_FEM_RUNTIME_ROOT=/workspace/.fullmag/runtime" in recipe
    assert "projected_gradient_bb,nonlinear_cg,llg_overdamped" in recipe
    assert "box500_airbox_exchange_demag_multidomain" in recipe
    assert "--repeat \"$repeat_count\"" in recipe
    assert "--capture-final-magnetization" in recipe
    assert "relaxation_torque_calibration_suite_v2.json" in recipe
