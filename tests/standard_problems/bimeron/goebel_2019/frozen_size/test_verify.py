from __future__ import annotations

from tests.standard_problems.bimeron.goebel_2019.frozen_size.verify import verify_analysis


THRESHOLDS = {
    "frozen_reference_max_drift": 1e-12,
    "maximum_state_norm_defect": 1e-12,
    "maximum_energy_balance_relative": 1e-9,
    "maximum_energy_window_relative_span": 1e-3,
    "maximum_free_torque_T": 1e-6,
    "require_gpu_residency": True,
    "require_runtime_provenance": True,
    "require_completion": True,
    "require_finite_energy": True,
    "require_finite_profile_energy": True,
    "require_positive_frozen_dof_for_constrained_protocols": True,
    "require_frozen_hashes": True,
    "minimum_nontrivial_abs_topological_charge": 0.8,
    "maximum_area_core_radius_difference_nm": 3.0,
}


def _analysis(*, radius_nm: float = 3.0, converged: bool = True) -> dict:
    energy = {
        "E_ex_J": 1.0,
        "E_demag_J": 0.0,
        "E_ext_J": 0.0,
        "E_ani_J": 2.0,
        "E_rotated_dmi_J": -1.0,
        "E_total_J": 2.0,
        "E_component_sum_J": 2.0,
        "E_balance_relative": 0.0,
    }
    measurement = {
        "R_area_nm": radius_nm,
        "R_core_nm": radius_nm,
        "topological_charge": -1.0,
        "max_unit_norm_defect": 0.0,
        "nonfinite_vector_count": 0,
    }
    return {
        "schema_version": "bimeron_frozen_size.analysis.v1",
        "status": "measured",
        "protocol": {
            "protocol": "p3",
            "case_id": "R3-p3",
            "target_radius_nm": 3.0,
            "cell_nm": 0.5,
        },
        "energy": energy,
        "profile_energy": {**energy, "stage_id": "constrained_hold"},
        "states": {
            "initial": {"measurement": measurement},
            "constrained_held": {"measurement": measurement},
        },
        "runtime_provenance": {
            "requested_execution": {"device": "gpu"},
            "execution_provenance": {
                "fdm_gpu_execution_receipt": {
                    "resolved": "device_resident",
                    "executed": "cuda_fdm",
                    "fallback_count": 0,
                }
            },
            "completion": {"converged": converged},
        },
        "frozen_runtime": {
            "frozen_dof_count": 12,
            "free_dof_count": 8,
            "frozen_reference_max_drift": 0.0,
            "frozen_mask_sha256": "mask",
            "frozen_reference_sha256": "reference",
            "frozen_selector_sha256": "selector",
            "free_torque_metric_status": "emitted",
            "free_torque_metric": 0.0,
            "free_torque_metric_units": "T",
        },
        "convergence_diagnostics": {
            "energy_window_relative_span": 0.0,
        },
    }


def test_missing_convergence_cannot_pass() -> None:
    for invalid in (None, 0, 1, "true"):
        analysis = _analysis()
        analysis["runtime_provenance"]["completion"] = {"converged": invalid}
        result = verify_analysis(analysis, THRESHOLDS)
        assert result["status"] == "failed"
        assert "convergence_status_missing" in result["failures"]


def test_ambiguous_disconnected_contour_is_not_accepted() -> None:
    analysis = _analysis()
    analysis["states"]["constrained_held"]["measurement"]["area_component_contour_ambiguous"] = True
    result = verify_analysis(analysis, THRESHOLDS)
    assert result["status"] == "failed"
    assert "constrained_held_area_component_contour_ambiguous" in result["failures"]


def test_working_policy_does_not_change_strict_policy() -> None:
    import json
    from pathlib import Path

    root = Path(__file__).parent
    strict = json.loads((root / "thresholds.v1.json").read_text())
    working = json.loads((root / "thresholds.working.v2.json").read_text())
    assert strict["maximum_free_torque_T"] == 1e-5
    assert working["maximum_free_torque_T"] == 0.005
    result = verify_analysis(_analysis(), working)
    assert result["qualification_scope"] == "working_profile_not_release"


def test_unknown_torque_cannot_satisfy_convergence_gate() -> None:
    for value, units in ((None, "T"), (float("nan"), "T"), (0.0, "unknown"), (-1.0, "T")):
        analysis = _analysis()
        analysis["frozen_runtime"].update(free_torque_metric=value, free_torque_metric_units=units)
        result = verify_analysis(analysis, THRESHOLDS)
        assert result["status"] == "failed"
        assert any(reason.startswith("free_torque_metric_") for reason in result["failures"])


def test_verifier_reports_radius_mismatch_after_convergence() -> None:
    result = verify_analysis(_analysis(radius_nm=3.5), THRESHOLDS)
    assert result["status"] == "failed"
    assert "radius_mismatch" in result["failures"]
    assert result["radius_error_nm"] == 0.5
    assert result["radius_tolerance_nm"] == 0.25


def test_verifier_keeps_radius_and_window_diagnostics_non_accepting_before_convergence() -> None:
    analysis = _analysis(radius_nm=3.5, converged=False)
    analysis["convergence_diagnostics"]["energy_window_relative_span"] = 0.01
    result = verify_analysis(analysis, THRESHOLDS)
    assert result["status"] == "not_converged"
    assert "radius_mismatch_before_convergence" in result["warnings"]
    assert "energy_window_not_stable_before_convergence" in result["warnings"]
