from __future__ import annotations

import json
from pathlib import Path

import pytest

from run_fullmag_m2_nf_reference import (
    Resolution,
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
