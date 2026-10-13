"""Preserve nonzero-k authoring options through canonical stage materialization."""
import ast
import pytest
from fullmag.runtime.script_builder import _render_scene_stage_bootstrap


def test_eigen_capture_preserves_solver_controls_and_separate_floquet_kind():
    source = "\n".join(_render_scene_stage_bootstrap({
        "kind": "eigenmodes", "stage_id": "de", "eigen_count": 2,
        "eigen_solver_rtol": 1e-9,
        "eigen_solver_max_outer_iterations": 120,
        "eigen_solver_max_linear_iterations": 80,
        "eigen_k_vector": "0, 10000000, 0",
        "eigen_spin_wave_bc": "floquet",
        "eigen_spin_wave_bc_config": {"pair_ids": ["pair-y"]},
    }, index=0, solver=None))
    calls = [node for node in ast.walk(ast.parse(source)) if isinstance(node, ast.Call)
             and isinstance(node.func, ast.Attribute) and node.func.attr == "eigenmodes_stage"]
    assert len(calls) == 1
    options = {keyword.arg: keyword.value for keyword in calls[0].keywords}
    assert ast.literal_eval(options["solver_rtol"]) == 1e-9
    assert ast.literal_eval(options["solver_max_outer_iterations"]) == 120
    assert ast.literal_eval(options["solver_max_linear_iterations"]) == 80
    assert ast.literal_eval(options["k_vector"]) == (0.0, 10000000.0, 0.0)
    bc = options["bc"]
    assert isinstance(bc, ast.Call) and isinstance(bc.func, ast.Attribute)
    assert bc.func.attr == "FloquetBC"
    assert ast.literal_eval(bc.args[0]) == ["pair-y"]


@pytest.mark.parametrize("field,value", [
    ("eigen_count", 0), ("eigen_count", -1),
    ("eigen_target_frequency", float("nan")),
    ("eigen_k_vector", "0, bad, 0"),
    ("eigen_solver_max_linear_iterations", 0),
])
def test_invalid_authored_values_are_not_replaced_with_defaults(field, value):
    with pytest.raises(ValueError):
        _render_scene_stage_bootstrap({"kind": "eigenmodes", field: value}, index=0, solver=None)


def test_conflicting_k_vector_and_path_are_rejected_before_rendering():
    with pytest.raises(ValueError, match="both eigen_k_path and eigen_k_vector"):
        _render_scene_stage_bootstrap({
            "kind": "eigenmodes", "eigen_k_vector": [0, 1e6, 0], "eigen_k_path": "nonempty",
        }, index=0, solver=None)


@pytest.mark.parametrize("device", ["cpu", "gpu", "auto"])
def test_profile_controls_parallel_lane_instead_of_inactive_legacy_fields(tmp_path, device):
    from fullmag.model.execution_profile import ExecutionProfile, ExecutionOverrides
    from fullmag.runtime.loader import load_problem_from_script
    from fullmag.runtime.script_builder import render_loaded_problem_as_script
    profile = ExecutionProfile("modal", "1", defaults=ExecutionOverrides(backend="fem", device=device))
    script = tmp_path / "declared_modal.py"
    script.write_text(
        "import fullmag as fm\n"
        "study = fm.study('modal')\n"
        f"study.execution_profile(fm.ExecutionProfile.from_ir({profile.to_ir()!r}))\n"
        "study.parallel_execution(mode='adaptive')\n"
        "film = study.geometry(fm.Box(40e-9, 40e-9, 10e-9, name='film'), name='film')\n"
        "film.Ms = 800000\nfilm.Aex = 13e-12\nfilm.m = fm.texture.uniform(1, 0, 0)\n",
        encoding="utf-8",
    )
    if device != "cpu":
        with pytest.raises(
            ValueError,
            match=r"adaptive mode requires requested_backend='fem' and requested_device='cpu'",
        ):
            load_problem_from_script(script, lightweight_assets=True)
        return
    loaded = load_problem_from_script(script, lightweight_assets=True)
    assert loaded.problem.runtime.parallel_execution.mode == "adaptive"
    assert loaded.problem.runtime.backend_target.value == "fem"
    assert loaded.problem.runtime.device_target.value == "cpu"
    assert loaded.problem.runtime_metadata["execution_profile"] == profile.to_ir()
    source = render_loaded_problem_as_script(loaded)
    assert "study.execution_profile(" in source and "parallel_execution(" in source
    assert "study.engine(" not in source


def test_declared_parallel_lane_replays_step_and_rejects_submit_conflicts():
    from fullmag.model.execution_profile import (
        ExecutionProfile, ExecutionOverrides, ExecutionRequestLayer, _parallel_execution_lane,
    )
    profile = ExecutionProfile("modal", "1", defaults=ExecutionOverrides(backend="fem", device="cpu"))
    step = ExecutionRequestLayer("step", "step:1", ExecutionOverrides(device="gpu"))
    source = {"execution_profile": profile.to_ir(), "execution_layers": [step.to_ir()]}
    assert _parallel_execution_lane(source, "fdm", "cpu") == ("fem", "gpu")
    submit = ExecutionRequestLayer("submit", "submit:1", ExecutionOverrides(device="cpu"))
    source["execution_layers"].append(submit.to_ir())
    with pytest.raises(ValueError, match="execution_intent_conflict"):
        _parallel_execution_lane(source, "auto", "auto")
