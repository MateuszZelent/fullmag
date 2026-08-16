from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path

import fullmag as fm
from fullmag.runtime import helper as runtime_helper


REPO_ROOT = Path(__file__).resolve().parents[4]
SCENARIO = REPO_ROOT / "examples" / "fdm_gpu_solved_current_skyrmion_racetrack.py"


def _load_scenario():
    return fm.load_problem_from_script(SCENARIO, lightweight_assets=True)


def _terminal_currents(problem: fm.Problem) -> dict[str, float]:
    charge = problem.current_modules[0]
    return {
        boundary.id: boundary.outward_current_density_Apm2
        for boundary in charge.boundaries
        if isinstance(boundary, fm.NormalCurrentElectrode)
    }


def test_public_stage_first_racetrack_declares_zero_current_relaxation_and_six_solved_drives() -> None:
    loaded = _load_scenario()

    relax = next(stage for stage in loaded.stages if stage.stage_id == "relax_zero_current")
    assert relax.entrypoint_kind == "flat_relax"
    assert _terminal_currents(relax.problem) == {
        "terminal_x_minus": 0.0,
        "terminal_x_plus": 0.0,
    }

    drives = [stage for stage in loaded.stages if stage.entrypoint_kind == "flat_run"]
    assert [stage.stage_id for stage in drives] == [
        "drive_solved_current_minus_1_5",
        "drive_solved_current_minus_1_0",
        "drive_solved_current_minus_0_5",
        "drive_solved_current_plus_0_5",
        "drive_solved_current_plus_1_0",
        "drive_solved_current_plus_1_5",
    ]
    assert [_terminal_currents(stage.problem) for stage in drives] == [
        {"terminal_x_minus": 1.5e12, "terminal_x_plus": -1.5e12},
        {"terminal_x_minus": 1.0e12, "terminal_x_plus": -1.0e12},
        {"terminal_x_minus": 0.5e12, "terminal_x_plus": -0.5e12},
        {"terminal_x_minus": -0.5e12, "terminal_x_plus": 0.5e12},
        {"terminal_x_minus": -1.0e12, "terminal_x_plus": 1.0e12},
        {"terminal_x_minus": -1.5e12, "terminal_x_plus": 1.5e12},
    ]

    actions = [stage.action for stage in loaded.stages if stage.action is not None]
    assert "drive_solved_current" in [stage.stage_id for stage in loaded.stages]
    assert actions[0] == {
        "kind": "set_spin_torque_enabled",
        "module_id": "transport_torque",
        "enabled": False,
    }
    assert any(
        action == {
            "kind": "set_spin_torque_enabled",
            "module_id": "transport_torque",
            "enabled": True,
        }
        for action in actions
    )
    assert sum(action["kind"] == "load_state" for action in actions) == 6
    assert all(
        action.get("artifact_name") == "relaxed_zero_current"
        for action in actions
        if action["kind"] == "load_state"
    )


def test_public_stage_first_racetrack_disables_the_transport_pipeline_during_relaxation() -> None:
    loaded = _load_scenario()
    relax = next(stage for stage in loaded.stages if stage.stage_id == "relax_zero_current")
    drive = next(stage for stage in loaded.stages if stage.stage_id == "drive_solved_current_plus_1_5")

    relax_activation = {
        module["id"]: module["activation"]
        for module in relax.problem.to_ir(include_geometry_assets=False)["physics_graph"]["modules"]
    }
    drive_activation = {
        module["id"]: module["activation"]
        for module in drive.problem.to_ir(include_geometry_assets=False)["physics_graph"]["modules"]
    }
    assert relax_activation == {
        "charge": "inactive",
        "spin": "inactive",
        "hm_fm": "inactive",
        "transport_torque": "inactive",
    }
    assert drive_activation == {
        "charge": "active",
        "spin": "active",
        "hm_fm": "active",
        "transport_torque": "active",
    }


def test_public_stage_first_racetrack_preserves_the_frozen_transport_contract() -> None:
    loaded = _load_scenario()
    ir = loaded.pipeline_base_problem().to_ir(include_geometry_assets=False)

    runtime = ir["problem_meta"]["runtime_metadata"]["runtime_selection"]
    assert runtime == {
        "backend": "fdm",
        "device": "cuda",
        "gpu_count": 1,
        "device_index": 0,
        "cpu_threads": None,
        "execution_mode": "strict",
        "execution_precision": "double",
    }
    assert ir["spin_transport_modules"][0]["requested_execution"] == {
        "discretization": "fdm",
        "device": "gpu",
        "precision": "double",
        "execution_mode": "strict",
    }
    assert [entry["name"] for entry in ir["magnets"]] == ["fm"]
    assert [entry["name"] for entry in ir["geometry"]["entries"]] == ["fm_geom", "hm"]
    assert ir["current_modules"][0]["gauge"] == "zero_mean"
    assert ir["spin_transport_modules"][0]["solver"]["engine"] == "native_m1_v1"
    assert ir["spin_transport_modules"][0]["interfaces"][0]["normal_surface"] == {
        "object_id": "hm",
        "surface_id": "z+",
        "orientation": [0.0, 0.0, 1.0],
    }
    assert ir["spin_transport_modules"][0]["interfaces"][0]["ferromagnet_surface"] == {
        "object_id": "fm",
        "surface_id": "z-",
        "orientation": [0.0, 0.0, -1.0],
    }
    assert [entry["kind"] for entry in ir["spin_torque_modules"]] == [
        "drift_diffusion_spin_torque"
    ]
    assert "oersted" not in {entry["kind"] for entry in ir["energy_terms"]}
    assert "Prescribed" not in SCENARIO.read_text(encoding="utf-8")
    assert "json" not in SCENARIO.read_text(encoding="utf-8").lower()


def test_public_stage_first_racetrack_declares_hm_as_conductor_object() -> None:
    loaded = _load_scenario()
    ir = loaded.pipeline_base_problem().to_ir(include_geometry_assets=False)

    assert {entry["name"]: entry["type"] for entry in ir["physics_objects"]} == {
        "hm": "conductor",
    }
    assert ir["physics_graph"]["objects"] == ir["physics_objects"]
    assert {region["name"]: region["geometry"] for region in ir["regions"]} == {
        "fm": "fm_geom",
        "hm": "hm",
    }
    assert 'study.geometry_object(' in SCENARIO.read_text(encoding="utf-8")
    assert 'study.antenna_object(' not in SCENARIO.read_text(encoding="utf-8")


def test_public_stage_first_racetrack_round_trips_typed_hm_geometry() -> None:
    from fullmag.runtime.script_builder import rewrite_loaded_problem_script

    rendered = rewrite_loaded_problem_script(_load_scenario())["rendered_source"]

    assert 'study.geometry_object(' in rendered
    assert 'name="hm", type="conductor"' in rendered
    assert 'study.antenna_object(' not in rendered


def test_public_stage_first_racetrack_uses_analytic_common_transport_grid() -> None:
    stdout = io.StringIO()
    with contextlib.redirect_stdout(stdout):
        exit_code = runtime_helper.main(
            [
                "export-run-config",
                "--script",
                str(SCENARIO),
                "--backend",
                "fdm",
                "--mode",
                "strict",
                "--precision",
                "double",
            ]
        )

    assert exit_code == 0
    payload = json.loads(stdout.getvalue())
    assert payload["ir"]["geometry_assets"] is None
    assert payload["shared_geometry_assets"] is None
    assert all(stage["ir"]["geometry_assets"] is None for stage in payload["stages"])
