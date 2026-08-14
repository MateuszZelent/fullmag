from __future__ import annotations

import ast
import contextlib
import io
import json
import math
from pathlib import Path

import pytest

from fullmag.runtime import helper as runtime_helper
from fullmag.runtime.loader import load_problem_from_script


SCENARIO_ROOT = Path(__file__).with_name("scenarios")
DYNAMICS_POLICIES = {
    "heun_fixed": ("heun", "fixed"),
    "rk23_fixed": ("rk23", "fixed"),
    "rk4_fixed": ("rk4", "fixed"),
    "rk45_fixed": ("rk45", "fixed"),
    "rk23_adaptive": ("rk23", "adaptive"),
    "rk45_adaptive": ("rk45", "adaptive"),
}
RELAXATION_POLICIES = {
    "relax_projected_gradient_bb": ("projected_gradient_bb", None, None, None),
    "relax_nonlinear_cg": ("nonlinear_cg", None, None, None),
    "relax_llg_heun_fixed_dt_1e14": ("llg_overdamped", "heun", "fixed", 1e-14),
    "relax_llg_rk23_fixed_dt_1e14": ("llg_overdamped", "rk23", "fixed", 1e-14),
    "relax_llg_rk4_fixed_dt_1e14": ("llg_overdamped", "rk4", "fixed", 1e-14),
    "relax_llg_rk45_fixed_dt_2e13": ("llg_overdamped", "rk45", "fixed", 2e-13),
    "relax_llg_rk45_fixed_dt_1e13": ("llg_overdamped", "rk45", "fixed", 1e-13),
    "relax_llg_rk45_fixed_dt_5e14": ("llg_overdamped", "rk45", "fixed", 5e-14),
    "relax_llg_rk45_fixed_dt_2e14": ("llg_overdamped", "rk45", "fixed", 2e-14),
    "relax_llg_rk45_fixed_dt_1e14": ("llg_overdamped", "rk45", "fixed", 1e-14),
    "relax_llg_rk23_adaptive": ("llg_overdamped", "rk23", "adaptive", None),
    "relax_llg_rk45_adaptive": ("llg_overdamped", "rk45", "adaptive", None),
}
FIELDS_T = {
    "case_a": (-24.6e-3, 4.3e-3, 0.0),
    "case_b": (-35.5e-3, -6.3e-3, 0.0),
}
DYNAMICS_SCENARIOS = {
    f"{case}_{policy}": SCENARIO_ROOT / f"{case}_{policy}.py"
    for case in FIELDS_T
    for policy in DYNAMICS_POLICIES
}
RELAXATION_SCENARIOS = {
    name: SCENARIO_ROOT / f"{name}.py" for name in RELAXATION_POLICIES
}
TOPOLOGY_SCENARIOS = {"mesh_single_prism_layer"}
AUDIT_SCENARIOS = {"root_cause_uniform_energy_audit"}
FDM_COUNTERPART_SCENARIOS = {
    "relax_projected_gradient_bb_fdm": SCENARIO_ROOT
    / "relax_projected_gradient_bb_fdm.py"
}
SCENARIOS = {**DYNAMICS_SCENARIOS, **RELAXATION_SCENARIOS}
DIRECT_SCENARIOS = {**SCENARIOS, **FDM_COUNTERPART_SCENARIOS}


def _export_run_config(
    path: Path,
    *,
    backend: str = "fem",
    skip_geometry_assets: bool = True,
) -> dict[str, object]:
    args = [
        "export-run-config",
        "--script",
        str(path),
        "--backend",
        backend,
        "--mode",
        "strict",
        "--precision",
        "double",
    ]
    if skip_geometry_assets:
        # Keep the default scenario checks fast; callers that qualify
        # full materialization explicitly opt into geometry assets.
        args.append("--skip-geometry-assets")
    stdout = io.StringIO()
    with contextlib.redirect_stdout(stdout):
        exit_code = runtime_helper.main(args)
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


def test_scenario_manifest_includes_dynamics_relaxation_and_topology_scripts() -> None:
    expected = {
        f"{scenario}.py"
        for scenario in {
            *SCENARIOS,
            *TOPOLOGY_SCENARIOS,
            *AUDIT_SCENARIOS,
            *FDM_COUNTERPART_SCENARIOS,
        }
    }
    actual = {
        path.name
        for path in SCENARIO_ROOT.glob("*.py")
        if path.name != "__init__.py"
    }
    assert actual == expected


@pytest.mark.parametrize("scenario,path", DIRECT_SCENARIOS.items())
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
    expected_solver_calls = 1 if scenario in DYNAMICS_SCENARIOS else 0
    assert len(solver_calls) == expected_solver_calls


def test_fdm_projected_gradient_bb_counterpart_exports_cpu_double_relaxation() -> None:
    payload = _export_run_config(
        FDM_COUNTERPART_SCENARIOS["relax_projected_gradient_bb_fdm"],
        backend="fdm",
    )
    assert [stage["entrypoint_kind"] for stage in payload["stages"]] == [
        "flat_relax",
        "flat_save_state",
    ]
    relax_stage, save_state_stage = payload["stages"]
    sampling = relax_stage["ir"]["study"]["sampling"]
    assert "table_autosave" not in sampling
    assert sampling["stage_autosave"]["table"]["every_steps"] == 10
    runtime = relax_stage["ir"]["problem_meta"]["runtime_metadata"][
        "runtime_selection"
    ]
    assert runtime["backend"] == "fdm"
    assert runtime["device"] == "cpu"
    assert runtime["execution_precision"] == "double"
    assert relax_stage["ir"]["study"]["stop"] == {
        "torque_tolerance_apm": pytest.approx(0.7957747154594766),
        "max_steps": 100_000,
    }
    assert save_state_stage["action"] == {
        "kind": "save_state",
        "artifact_name": "relaxed_m.zarr",
        "format": "zarr",
        "dataset": "m",
    }


def test_fdm_projected_gradient_bb_counterpart_materializes_grid_assets() -> None:
    payload = _export_run_config(
        FDM_COUNTERPART_SCENARIOS["relax_projected_gradient_bb_fdm"],
        backend="fdm",
        skip_geometry_assets=False,
    )

    assets = payload["shared_geometry_assets"]["fdm_grid_assets"]
    assert len(assets) == 1
    asset = assets[0]
    assert asset["cells"] == [128, 52, 30]
    assert asset["cell_size"] == pytest.approx(
        [6.25e-9, 6.25e-9, 3.0e-9], rel=1e-12
    )
    assert len(asset["active_mask"]) == 128 * 52 * 30
    assert sum(asset["active_mask"]) == 1600
    assert sum(asset["active_mask"]) * math.prod(asset["cell_size"]) == pytest.approx(
        500e-9 * 125e-9 * 3e-9, rel=1e-12
    )


@pytest.mark.parametrize("scenario,path", DYNAMICS_SCENARIOS.items())
def test_dynamics_scenario_uses_common_mumax_like_relaxation_and_named_run_solver(
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
    integrator, timestep_policy = DYNAMICS_POLICIES[policy]

    relax_ir = stages[0]["ir"]
    relax_study = relax_ir["study"]
    assert relax_study["kind"] == "relaxation"
    assert relax_study["algorithm"] == "llg_overdamped"
    relax_dynamics = relax_study["dynamics"]
    assert relax_dynamics["integrator"] == "rk23"
    assert relax_dynamics["fixed_timestep"] is None
    relax_adaptive = relax_dynamics["adaptive_timestep"]
    assert relax_adaptive["tolerance_mode"] == "max_error"
    assert relax_adaptive["atol"] == pytest.approx(1e-7)
    assert relax_adaptive["dt_initial"] == pytest.approx(1e-15)
    assert relax_adaptive["dt_min"] == pytest.approx(1e-17)
    assert relax_adaptive["dt_max"] == pytest.approx(1e-14)
    assert relax_ir["materials"][0]["damping"] == pytest.approx(1.0)
    assert _zeeman_fields(relax_ir) == []

    run_ir = stages[2]["ir"]
    run_study = run_ir["study"]
    assert run_study["kind"] == "time_evolution"
    assert run_study["dynamics"]["integrator"] == integrator
    assert run_ir["materials"][0]["damping"] == pytest.approx(0.02)
    assert _zeeman_fields(run_ir) == [pytest.approx(FIELDS_T[case])]
    assert stages[2]["default_until_seconds"] == pytest.approx(5e-9)

    if timestep_policy == "fixed":
        assert run_study["dynamics"]["fixed_timestep"] == pytest.approx(2e-13)
        assert "adaptive_timestep" not in run_study["dynamics"]
    else:
        dynamics = run_study["dynamics"]
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
    assert mesh["maximum_element_size"] == pytest.approx(3e-9)
    assert mesh.get("mesh_strategy") != "thin_film_tetrahedral"
    assert "through_thickness_elements" not in mesh


@pytest.mark.parametrize("scenario,path", RELAXATION_SCENARIOS.items())
def test_relaxation_scenario_exports_only_its_physically_applicable_policy(
    scenario: str,
    path: Path,
) -> None:
    payload = _export_run_config(path)
    expected_stage_kinds = ["flat_relax"]
    if scenario == "relax_projected_gradient_bb":
        expected_stage_kinds.append("flat_save_state")
    assert [stage["entrypoint_kind"] for stage in payload["stages"]] == expected_stage_kinds
    stage = payload["stages"][0]
    assert _active_stage_id(stage) == "relax"
    ir = stage["ir"]
    relaxation = ir["study"]
    assert ir["current_modules"] == []
    assert ir["spin_transport_modules"] == []
    assert ir.get("spin_torques", []) == []
    algorithm, integrator, timestep_policy, dt = RELAXATION_POLICIES[scenario]
    assert relaxation["kind"] == "relaxation"
    assert relaxation["algorithm"] == algorithm
    assert _zeeman_fields(ir) == []

    if algorithm != "llg_overdamped":
        assert "dynamics" not in relaxation
    elif timestep_policy == "fixed":
        dynamics = relaxation["dynamics"]
        assert dynamics["integrator"] == integrator
        assert dynamics["fixed_timestep"] == pytest.approx(dt)
        assert "adaptive_timestep" not in dynamics
    else:
        dynamics = relaxation["dynamics"]
        assert dynamics["integrator"] == integrator
        assert dynamics["fixed_timestep"] is None
        adaptive = dynamics["adaptive_timestep"]
        assert adaptive["tolerance_mode"] == "max_error"
        assert adaptive["atol"] == pytest.approx(1e-7)
        assert adaptive["dt_initial"] == pytest.approx(1e-15)
        assert adaptive["dt_min"] == pytest.approx(1e-17)
        assert adaptive["dt_max"] == pytest.approx(1e-14)

    expected_tolerance_apm = (
        0.004643265887234501
        if scenario == "relax_projected_gradient_bb"
        else 7.957747154594767
    )
    assert relaxation["stop"]["torque_tolerance_apm"] == pytest.approx(
        expected_tolerance_apm
    )
    expected_max_steps = 100_000 if scenario == "relax_projected_gradient_bb" else 50_000
    assert relaxation["stop"]["max_steps"] == expected_max_steps


def test_projected_gradient_bb_requests_only_final_m_state_save() -> None:
    scenario_path = RELAXATION_SCENARIOS["relax_projected_gradient_bb"]
    payload = _export_run_config(scenario_path)

    assert [stage["entrypoint_kind"] for stage in payload["stages"]] == [
        "flat_relax",
        "flat_save_state",
    ]
    relax_stage, save_state_stage = payload["stages"]
    relax_autosave = relax_stage["ir"]["study"]["sampling"]["stage_autosave"]
    assert relax_autosave["fields"] == []
    assert save_state_stage["ir"]["study"]["kind"] == "relaxation"
    assert save_state_stage["action"] == {
        "kind": "save_state",
        "artifact_name": "relaxed_m.zarr",
        "format": "zarr",
        "dataset": "m",
    }


def test_projected_gradient_scenario_requests_one_exact_uniform_prism_layer() -> None:
    scenario_path = RELAXATION_SCENARIOS["relax_projected_gradient_bb"]
    payload = _export_run_config(scenario_path)
    stage, save_state_stage = payload["stages"]
    [mesh] = stage["ir"]["problem_meta"]["runtime_metadata"]["mesh_workflow"][
        "per_geometry"
    ]

    assert mesh["topology"] == "prismatic"
    assert mesh["element_family"] == "prism"
    assert mesh["mesh_strategy"] == "swept_prism"
    assert mesh["through_thickness_elements"] == 1
    assert mesh["exact_layer_count"] is True
    assert mesh["transition_policy"] == "pyramid_to_tetrahedra"
    assert mesh["minimum_element_size"] == pytest.approx(3e-9)
    assert mesh["maximum_element_size"] == pytest.approx(3e-9)
    assert "edge_hmax" not in mesh
    assert "edge_thickness" not in mesh
    assert "edge_transition_distance" not in mesh
    assert "corner_hmax" not in mesh
    assert "corner_extent" not in mesh
    assert "corner_transition_distance" not in mesh

    loaded = load_problem_from_script(scenario_path, lightweight_assets=True)
    loaded_stage, loaded_save_state = loaded.stages
    assert loaded_stage.autosave is not None
    assert loaded_stage.autosave.table is not None
    assert loaded_stage.autosave.table.to_ir() == {
        "kind": "table_autosave",
        "table_id": "default",
        "every_steps": 10,
        "quantities": [
            "step",
            "mx",
            "my",
            "mz",
            "e_ex",
            "e_demag",
            "e_total",
            "max_torque_T",
        ],
    }
    assert loaded_stage.autosave.fields == ()
    assert loaded_save_state.entrypoint_kind == "flat_save_state"
    assert loaded_save_state.action == {
        "kind": "save_state",
        "artifact_name": "relaxed_m.zarr",
        "format": "zarr",
        "dataset": "m",
    }
