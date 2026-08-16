from __future__ import annotations

import importlib.util
from pathlib import Path


SCENARIO = Path(__file__).with_name("scenario.py")


def _load_scenario():
    spec = importlib.util.spec_from_file_location("racetrack_m1_v1_scenario", SCENARIO)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_public_scenario_authors_exact_gpu_m1_transport_without_prescribed_torque() -> None:
    module = _load_scenario()
    problem = module.build()
    ir = problem.to_ir(include_geometry_assets=False)

    runtime = ir["problem_meta"]["runtime_metadata"]["runtime_selection"]
    assert runtime == {
        "backend": "fdm",
        "device": "gpu",
        "gpu_count": 1,
        "device_index": 0,
        "cpu_threads": None,
        "execution_mode": "strict",
        "execution_precision": "double",
    }
    assert ir["backend_policy"]["requested_backend"] == "fdm"
    assert ir["backend_policy"]["execution_precision"] == "double"
    assert ir["validation_profile"]["execution_mode"] == "strict"

    charge = ir["current_modules"]
    spin = ir["spin_transport_modules"]
    torque = ir["spin_torque_modules"]
    assert [entry["name"] for entry in charge] == ["charge"]
    assert [entry["id"] for entry in spin] == ["spin"]
    assert [entry["id"] for entry in torque] == ["transport_torque"]
    assert spin[0]["requested_execution"] == {
        "discretization": "fdm",
        "device": "gpu",
        "precision": "double",
        "execution_mode": "strict",
    }
    assert spin[0]["solver"]["engine"] == "native_m1_v1"
    assert torque[0]["kind"] == "drift_diffusion_spin_torque"
    assert not any(key.startswith("prescribed") for key in torque[0])

    electrodes = charge[0]["boundaries"][:2]
    assert electrodes[0]["outward_current_density_Apm2"] == -1.0e12
    assert electrodes[1]["outward_current_density_Apm2"] == 1.0e12
    assert charge[0]["gauge"] == "zero_mean"

    assert spin[0]["interfaces"][0]["normal_surface"] == {
        "object_id": "hm",
        "surface_id": "z+",
        "orientation": [0.0, 0.0, 1.0],
    }
    assert spin[0]["interfaces"][0]["ferromagnet_surface"] == {
        "object_id": "fm",
        "surface_id": "z-",
        "orientation": [0.0, 0.0, -1.0],
    }

    assert [entry["kind"] for entry in ir["energy_terms"]] == [
        "exchange",
        "demag",
        "interfacial_dmi",
    ]
    assert [entry["name"] for entry in ir["study"]["sampling"]["outputs"]] == [
        "m",
        "V_electric",
        "J_charge",
        "spin_potential",
        "spin_current_tensor",
        "torque_stt",
    ]


def test_public_scenario_uses_separate_transport_and_magnetic_objects() -> None:
    ir = _load_scenario().build().to_ir(include_geometry_assets=False)

    assert [entry["name"] for entry in ir["magnets"]] == ["fm"]
    assert [entry["name"] for entry in ir["geometry"]["entries"]] == ["fm", "hm"]
    assert ir["current_modules"][0]["domain"] == [
        {"object_id": "hm"},
        {"object_id": "fm"},
    ]
    assert ir["spin_torque_modules"][0]["target"] == {"object_id": "fm"}
