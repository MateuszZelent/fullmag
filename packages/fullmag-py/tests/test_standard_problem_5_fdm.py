from pathlib import Path

import fullmag as fm


REPO_ROOT = Path(__file__).resolve().parents[3]
SP5_SCRIPT = REPO_ROOT / "examples/mumax_standard_problem_5_fdm.py"


def test_sp5_script_preserves_mumax_geometry_and_zl_parameters() -> None:
    loaded = fm.load_problem_from_script(SP5_SCRIPT, lightweight_assets=True)

    assert [stage.entrypoint_kind for stage in loaded.stages] == [
        "flat_relax",
        "flat_run",
    ]
    relax_problem = loaded.stages[0].problem
    run_problem = loaded.stages[1].problem

    magnet = relax_problem.magnets[0]
    assert magnet.geometry.size == (100e-9, 100e-9, 10e-9)
    assert magnet.material.Ms == 800e3
    assert magnet.material.A == 13e-12
    assert magnet.material.alpha == 1.0
    assert magnet.m0.to_ir()["kind"] == "preset_texture"
    assert magnet.m0.to_ir()["preset_kind"] == "vortex"
    assert magnet.m0.to_ir()["preset_params"] == {
        "circulation": 1,
        "core_polarity": 1,
        "plane": "xy",
    }
    assert relax_problem.spin_torques == ()
    assert run_problem.magnets[0].material.alpha == 0.1

    torque = run_problem.spin_torques[0].to_ir_module()
    assert torque == {
        "kind": "zhang_li",
        "schema_version": "zhang_li_torque.v1",
        "id": "sp5_zhang_li",
        "target": {"object_id": "plate"},
        "formula_version": "zhang_li.mumax3.v1",
        "operator_version": "zl_mumax3_central_v1",
        "lande_g": 2.0,
        "degree": 1.0,
        "beta": 0.05,
        "current_density": [1e12, 0.0, 0.0],
    }
    assert loaded.stages[1].default_until_seconds == 1e-9
