from pathlib import Path

import fullmag as fm


REPO_ROOT = Path(__file__).resolve().parents[3]
SP5_SCRIPT = REPO_ROOT / "examples/mumax_standard_problem_5_fem.py"


def test_sp5_fem_script_preserves_shared_domain_and_canonical_stt() -> None:
    loaded = fm.load_problem_from_script(SP5_SCRIPT, lightweight_assets=True)

    assert [stage.entrypoint_kind for stage in loaded.stages] == [
        "flat_relax",
        "flat_run",
    ]

    relax_ir = loaded.stages[0].problem.to_ir()
    run_ir = loaded.stages[1].problem.to_ir()

    assert relax_ir["backend_policy"]["requested_backend"] == "fem"
    assert relax_ir["backend_policy"]["execution_precision"] == "double"
    hints = relax_ir["backend_policy"]["discretization_hints"]
    assert hints["fdm"] is None
    assert hints["fem"]["order"] == 1
    assert hints["fem"]["hmax"] == 8e-9
    assert relax_ir["energy_terms"] == [
        {"kind": "exchange"},
        {"kind": "demag", "realization": "poisson_robin"},
    ]

    magnet = relax_ir["magnets"][0]
    assert magnet["region"] == "plate"
    assert magnet["material"] == "mat_plate"
    assert magnet["initial_magnetization"]["preset_kind"] == "vortex"
    assert magnet["initial_magnetization"]["preset_params"] == {
        "circulation": 1,
        "core_polarity": 1,
        "plane": "xy",
    }

    torque = run_ir["spin_torque_modules"][0]
    assert torque["formula_version"] == "zhang_li.fullmag.v1"
    assert torque["operator_version"] == "zl_central_reference_v1"
    assert torque["current_density"] == [1e12, 0.0, 0.0]
    assert torque["degree"] == 1.0
    assert torque["beta"] == 0.05
    assert loaded.stages[1].default_until_seconds == 1e-9
