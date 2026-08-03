from __future__ import annotations

import json
from pathlib import Path

import pytest

from run_fullmag_m2_nf_reference import (
    Resolution,
    _materialize_comparison_artifact,
    build_fullmag_nf_problem,
    run_fullmag_nf_reference,
)


def test_reference_problem_is_strict_fdm_cpu_double() -> None:
    problem = build_fullmag_nf_problem(Resolution(10, 4, 2, 2))
    assert problem["execution"] == {
        "discretization": "fdm",
        "device": "cpu",
        "precision": "double",
        "mode": "strict",
    }
    assert problem["transport"]["coupling"] == "bidirectional"
    assert problem["transport"]["interface"]["Gi_Spm2"] > 0.0
    assert problem["transport"]["interface"]["Gmix_Spm2"] == [1.5e15, 0.0]
    assert problem["transport"]["SHA"] == problem["transport"]["iSHA"] == 0.1
    assert problem["transport"]["solver"]["operator_version"] == (
        "fdm_coupled_charge_spin_fv_block_gmres.v1"
    )

    ir = problem["problem_ir"]
    assert ir["backend_policy"]["requested_backend"] == "fdm"
    assert ir["backend_policy"]["execution_precision"] == "double"
    assert ir["validation_profile"]["execution_mode"] == "strict"
    assert ir["spin_transport_modules"][0]["constitutive_version"] == (
        "transport_constitutive.reciprocal.fullmag.v1"
    )
    assert ir["spin_transport_modules"][0]["requested_execution"] == {
        "discretization": "fdm",
        "device": "cpu",
        "precision": "double",
        "execution_mode": "strict",
    }


def test_reference_problem_carries_two_region_mesh_contract() -> None:
    problem = build_fullmag_nf_problem(Resolution(4, 2, 2, 3))
    assert problem["mesh"]["shape"] == [4, 2, 5]
    assert problem["mesh"]["step_m"] == [1.0e-7, 1.0e-7, 1.0e-9]
    regions = problem["problem_ir"]["object_regions"]
    assert {entry["region_id"] for entry in regions} == {"normal_metal", "ferromagnet"}
    materials = problem["problem_ir"]["spin_transport_modules"][0]["materials"]
    assert {entry["region"]["region_id"] for entry in materials} == {
        "normal_metal",
        "ferromagnet",
    }


def test_reference_problem_rejects_non_positive_resolution() -> None:
    with pytest.raises(ValueError, match="positive"):
        Resolution(0, 4, 2, 2)


def test_reference_runner_reports_not_run_when_binary_is_missing(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="not_run"):
        run_fullmag_nf_reference(
            tmp_path / "missing-fullmag",
            Resolution(4, 2, 2, 2),
            tmp_path / "run",
        )


def test_reference_request_is_json_serializable() -> None:
    problem = build_fullmag_nf_problem(Resolution(4, 2, 2, 2))
    json.dumps(problem, allow_nan=False)


def test_materializer_averages_all_in_plane_interface_observations(tmp_path: Path) -> None:
    request = build_fullmag_nf_problem(Resolution(4, 2, 2, 2))
    accepted_path = tmp_path / "spin_transport_accepted.json"
    interface_fluxes = [
        {
            "absorbed_transverse_apm2": [1.0, 2.0, 3.0],
            "from_side_outgoing_apm2": [4.0, 5.0, 6.0],
            "to_side_transmitted_apm2": [7.0, 8.0, 9.0],
        },
        {
            "absorbed_transverse_apm2": [3.0, 4.0, 5.0],
            "from_side_outgoing_apm2": [6.0, 7.0, 8.0],
            "to_side_transmitted_apm2": [8.0, 10.0, 12.0],
        },
    ]
    accepted_path.write_text(
        json.dumps(
            {
                "schema": "fullmag.fdm.spin_transport.accepted.v1",
                "evaluation": {
                    "modules": [
                        {
                            "telemetry": {
                                "charge_balance_relative": 1.0e-12,
                                "spin_balance_relative": 2.0e-12,
                            },
                            "interface_fluxes": interface_fluxes,
                            "transport_torque_per_s": [
                                [0.0, 0.0, 0.0]
                            ]
                            * 32,
                        }
                    ]
                },
            }
        ),
        encoding="utf-8",
    )

    output = _materialize_comparison_artifact(
        accepted_path,
        request,
        tmp_path / "fullmag_m2_nf_reference.json",
    )
    artifact = json.loads(output.read_text(encoding="utf-8"))
    balances = artifact["interface_balances"]
    assert balances["absorbed_spin_flux"] == [2.0, 3.0, 4.0]
    assert balances["normal_spin_flux"] == [5.0, 6.0, 7.0]
    assert balances["ferromagnet_spin_flux"] == [7.5, 9.0, 10.5]
