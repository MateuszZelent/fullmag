from __future__ import annotations

import ast
import contextlib
import io
import json
import math
from pathlib import Path

import pytest

from fullmag.runtime import helper as runtime_helper


SCENARIO_ROOT = Path(__file__).with_name("scenarios")
POLICIES = {
    "heun_fixed": ("heun", "fixed"),
    "rk23_fixed": ("rk23", "fixed"),
    "rk4_fixed": ("rk4", "fixed"),
    "rk45_fixed": ("rk45", "fixed"),
    "rk23_adaptive": ("rk23", "adaptive"),
    "rk45_adaptive": ("rk45", "adaptive"),
}
FIELDS_T = {
    "case_a": (-24.6e-3, 4.3e-3, 0.0),
    "case_b": (-35.5e-3, -6.3e-3, 0.0),
}
SCENARIOS = {
    f"{case}_{policy}": SCENARIO_ROOT / f"{case}_{policy}.py"
    for case in FIELDS_T
    for policy in POLICIES
}


def _export_run_config(path: Path) -> dict[str, object]:
    stdout = io.StringIO()
    with contextlib.redirect_stdout(stdout):
        exit_code = runtime_helper.main(
            [
                "export-run-config",
                "--script",
                str(path),
                "--backend",
                "fem",
                "--mode",
                "strict",
                "--precision",
                "double",
                "--skip-geometry-assets",
            ]
        )
    assert exit_code == 0
    return json.loads(stdout.getvalue())


def _zeeman_fields(ir: dict[str, object]) -> list[tuple[float, float, float]]:
    return [
        tuple(float(component) for component in term["B"])
        for term in ir["energy_terms"]
        if term["kind"] == "zeeman"
    ]


def _active_stage_id(stage: dict[str, object]) -> str:
    return stage["ir"]["problem_meta"]["runtime_metadata"]["active_stage_id"]


def test_scenario_manifest_has_one_plain_script_per_case_and_rk_policy() -> None:
    expected = {f"{scenario}.py" for scenario in SCENARIOS}
    actual = {
        path.name
        for path in SCENARIO_ROOT.glob("*.py")
        if path.name != "__init__.py"
    }
    assert actual == expected


@pytest.mark.parametrize("scenario,path", SCENARIOS.items())
def test_scenario_is_direct_user_python_without_hidden_parameter_builder(
    scenario: str,
    path: Path,
) -> None:
    source = path.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(path))

    for forbidden in (
        "os.environ",
        "os.getenv",
        "SP4RunRequest",
        "build_study",
        "tests.standard_problems",
    ):
        assert forbidden not in source, f"{scenario} hides configuration in {forbidden}"

    assert not any(
        isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
        for node in tree.body
    )
    imported_modules = {
        alias.name
        for node in tree.body
        if isinstance(node, ast.Import)
        for alias in node.names
    }
    assert imported_modules == {"fullmag"}
    solver_calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "study"
        and node.func.attr == "solver"
    ]
    assert len(solver_calls) == 1, f"{scenario} must declare study.solver exactly once"


@pytest.mark.parametrize("scenario,path", SCENARIOS.items())
def test_scenario_exports_relax_autosave_and_reversal_through_public_ir(
    scenario: str,
    path: Path,
) -> None:
    payload = _export_run_config(path)
    stages = payload["stages"]
    assert [stage["entrypoint_kind"] for stage in stages] == [
        "flat_relax",
        "flat_autosave",
        "flat_run",
    ]
    assert [_active_stage_id(stage) for stage in stages] == [
        "relax",
        "autosave-m",
        "reversal",
    ]

    case = "case_a" if scenario.startswith("case_a_") else "case_b"
    policy = scenario.removeprefix(f"{case}_")
    integrator, timestep_policy = POLICIES[policy]

    relax_ir = stages[0]["ir"]
    relax_study = relax_ir["study"]
    assert relax_study["kind"] == "relaxation"
    assert relax_study["algorithm"] == "llg_overdamped"
    assert relax_study["dynamics"]["integrator"] == integrator
    assert _zeeman_fields(relax_ir) == []

    run_ir = stages[2]["ir"]
    run_study = run_ir["study"]
    assert run_study["kind"] == "time_evolution"
    assert run_study["dynamics"]["integrator"] == integrator
    assert _zeeman_fields(run_ir) == [pytest.approx(FIELDS_T[case])]
    assert stages[2]["default_until_seconds"] == pytest.approx(5e-9)

    if timestep_policy == "fixed":
        assert relax_study["dynamics"]["fixed_timestep"] == pytest.approx(2e-13)
        assert run_study["dynamics"]["fixed_timestep"] == pytest.approx(2e-13)
        assert "adaptive_timestep" not in relax_study["dynamics"]
        assert "adaptive_timestep" not in run_study["dynamics"]
    else:
        for dynamics in (relax_study["dynamics"], run_study["dynamics"]):
            assert dynamics["fixed_timestep"] is None
            adaptive = dynamics["adaptive_timestep"]
            assert adaptive["tolerance_mode"] == "max_error"
            assert adaptive["atol"] == pytest.approx(1e-7)
            assert adaptive["dt_initial"] == pytest.approx(1e-15)
            assert adaptive["dt_min"] == pytest.approx(1e-17)
            assert adaptive["dt_max"] == pytest.approx(2e-13)

    expected_table_columns = [
        "step",
        "t",
        "dt",
        "mx",
        "my",
        "mz",
        "e_ex",
        "e_demag",
        "e_ext",
        "e_total",
        "max_torque_T",
    ]
    assert relax_study["sampling"]["table_autosave"] == {
        "kind": "table_autosave",
        "table_id": "default",
        "quantities": expected_table_columns,
        "sample_period_s": pytest.approx(1e-12),
    }
    assert run_study["sampling"]["table_autosave"] == {
        "kind": "table_autosave",
        "table_id": "default",
        "quantities": expected_table_columns,
        "sample_period_s": pytest.approx(1e-12),
    }
    assert stages[1]["action"]["kind"] == "autosave"
    assert stages[1]["action"]["quantity"] == "m"
    assert any(
        output["kind"] == "field"
        and output["name"] == "m"
        and math.isclose(output["every_seconds"], 1e-12)
        for output in run_study["sampling"]["outputs"]
    )

    fem = run_ir["backend_policy"]["discretization_hints"]["fem"]
    assert fem["order"] == 1
    runtime = run_ir["problem_meta"]["runtime_metadata"]["runtime_selection"]
    assert runtime["backend"] == "fem"
    assert runtime["device"] == "auto"
    assert runtime["execution_mode"] == "strict"
    assert runtime["execution_precision"] == "double"

    magnet = run_ir["magnets"][0]
    initial = magnet["initial_magnetization"]["value"]
    assert initial == pytest.approx((1.0, 0.1, 0.0))
    mesh_workflow = run_ir["problem_meta"]["runtime_metadata"]["mesh_workflow"]
    assert mesh_workflow["build_requested"] is True
    assert mesh_workflow["build_target"] == "domain"
    [mesh] = mesh_workflow["per_geometry"]
    assert mesh["order"] == 1
    assert mesh["mesh_strategy"] == "thin_film_tetrahedral"
    assert mesh["through_thickness_elements"] == 3
