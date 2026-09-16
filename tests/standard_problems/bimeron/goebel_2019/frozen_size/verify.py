"""Verify frozen-spin bimeron profile analysis without relabelling gaps."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

MU0_T_M_PER_A = 4.0 * math.pi * 1.0e-7


def _load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def _finite(value: Any) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def _profile_state_label(analysis: dict[str, Any]) -> str:
    label = analysis.get("profile_state_label")
    if label in {"constrained_relaxed", "constrained_held", "final"}:
        return str(label)
    profile = analysis.get("profile_energy")
    if isinstance(profile, dict) and profile.get("stage_id") == "constrained_relax":
        return "constrained_relaxed"
    if isinstance(profile, dict) and profile.get("stage_id") == "constrained_hold":
        return "constrained_held"
    return "final"


def verify_analysis(analysis: dict[str, Any], thresholds: dict[str, Any]) -> dict[str, Any]:
    failures: list[str] = []
    warnings: list[str] = []
    if analysis.get("schema_version") != "bimeron_frozen_size.analysis.v1":
        failures.append("analysis_schema_mismatch")
    if analysis.get("status") != "measured":
        failures.append("analysis_incomplete")
    energy = analysis.get("energy") if isinstance(analysis.get("energy"), dict) else {}
    if thresholds.get("require_finite_energy", True) and not _finite(energy.get("E_total_J")):
        failures.append("terminal_energy_not_finite")
    profile_energy = analysis.get("profile_energy") if isinstance(analysis.get("profile_energy"), dict) else {}
    if thresholds.get("require_finite_profile_energy", True) and not _finite(profile_energy.get("E_total_J")):
        failures.append("profile_energy_not_finite")
    if profile_energy.get("stage_id") not in {"constrained_hold", "constrained_relax", "terminal"}:
        failures.append("profile_energy_stage_missing")
    for label, payload in (("terminal", energy), ("profile", profile_energy)):
        balance = payload.get("E_balance_relative")
        if balance is not None and _finite(balance):
            if float(balance) > float(thresholds.get("maximum_energy_balance_relative", 1e-9)):
                failures.append(f"{label}_energy_balance_mismatch")
    runtime = analysis.get("runtime_provenance") if isinstance(analysis.get("runtime_provenance"), dict) else {}
    requested = runtime.get("requested_execution") if isinstance(runtime.get("requested_execution"), dict) else {}
    provenance = runtime.get("execution_provenance") if isinstance(runtime.get("execution_provenance"), dict) else {}
    completion = runtime.get("completion") if isinstance(runtime.get("completion"), dict) else {}
    if thresholds.get("require_runtime_provenance", True):
        if not requested or not provenance:
            failures.append("runtime_provenance_missing")
    if thresholds.get("require_completion", True) and not completion:
        failures.append("completion_provenance_missing")
    background_reference = analysis.get("background_reference")
    background_reference_missing = thresholds.get("require_converged_background", True) and (
        not isinstance(background_reference, dict) or background_reference.get("status") != "usable"
    )
    if background_reference_missing:
        if completion.get("converged") is True:
            failures.append("background_reference_unavailable")
        else:
            warnings.append("background_reference_unavailable_before_convergence")
    if str(requested.get("device", "")).lower() == "gpu" and thresholds.get("require_gpu_residency", True):
        receipt = provenance.get("fdm_gpu_execution_receipt") if isinstance(provenance.get("fdm_gpu_execution_receipt"), dict) else {}
        if receipt.get("resolved") != "device_resident" or receipt.get("executed") != "cuda_fdm":
            failures.append("gpu_execution_not_device_resident")
        if receipt.get("fallback_count") not in {0, 0.0}:
            failures.append("gpu_fallback_detected")
    states = analysis.get("states") if isinstance(analysis.get("states"), dict) else {}
    profile_state_label = _profile_state_label(analysis)
    required_state_labels = {"initial", "constrained_held", profile_state_label}
    for label in required_state_labels:
        measurement = states.get(label, {}).get("measurement") if isinstance(states.get(label), dict) else None
        if not isinstance(measurement, dict):
            failures.append(f"missing_{label}_measurement")
    protocol = analysis.get("protocol") if isinstance(analysis.get("protocol"), dict) else {}
    name = str(protocol.get("protocol", ""))
    frozen = analysis.get("frozen_runtime") if isinstance(analysis.get("frozen_runtime"), dict) else {}
    frozen_count = frozen.get("frozen_dof_count")
    if name != "p0" and thresholds.get("require_positive_frozen_dof_for_constrained_protocols", True):
        if not isinstance(frozen_count, int) or frozen_count <= 0:
            failures.append("constrained_protocol_has_no_frozen_dof")
        frozen_cells = frozen.get("frozen_cell_count")
        if frozen_cells is not None and _finite(frozen_cells) and int(float(frozen_cells)) != int(frozen_count):
            failures.append("frozen_cell_count_mismatch")
        active_cells = frozen.get("frozen_mask_domain_cell_count", frozen.get("active_dof_count"))
        if active_cells is not None and _finite(active_cells) and int(float(active_cells)) < int(frozen_count):
            failures.append("frozen_mask_domain_smaller_than_frozen_cells")
    if name != "p0" and thresholds.get("require_frozen_hashes", True):
        for key in ("frozen_mask_sha256", "frozen_reference_sha256", "frozen_selector_sha256"):
            if not isinstance(frozen.get(key), str) or not frozen[key]:
                failures.append(f"{key}_missing")
    drift = frozen.get("frozen_reference_max_drift")
    if drift is not None and _finite(drift) and float(drift) > float(thresholds.get("frozen_reference_max_drift", 1e-15)):
        failures.append("frozen_reference_drift_exceeds_threshold")
    elif drift is None and name != "p0":
        warnings.append("frozen_reference_drift_not_emitted")
    free_status = frozen.get("free_torque_metric_status")
    free_torque_value = frozen.get("free_torque_metric")
    free_torque_units = frozen.get("free_torque_metric_units")
    free_torque_t = None
    if free_status != "emitted":
        warnings.append("free_torque_metric_not_emitted: full/all torque must not be interpreted as free-only")
    elif _finite(free_torque_value):
        free_torque_t = float(free_torque_value)
        if free_torque_units != "T":
            free_torque_t *= MU0_T_M_PER_A
        maximum_free_torque_t = float(thresholds.get("maximum_free_torque_T", 1.0e-5))
        if free_torque_t > maximum_free_torque_t:
            if completion.get("converged") is True:
                failures.append("free_torque_exceeds_threshold")
            else:
                warnings.append("free_torque_exceeds_threshold_before_convergence")

    for label, payload in states.items():
        measurement = payload.get("measurement") if isinstance(payload, dict) else None
        if not isinstance(measurement, dict):
            continue
        norm_defect = measurement.get("max_unit_norm_defect")
        if _finite(norm_defect) and float(norm_defect) > float(thresholds.get("maximum_state_norm_defect", 1e-12)):
            failures.append(f"{label}_unit_norm_defect_exceeds_threshold")
        nonfinite_vectors = measurement.get("nonfinite_vector_count")
        if _finite(nonfinite_vectors) and int(float(nonfinite_vectors)) > 0:
            failures.append(f"{label}_contains_nonfinite_vectors")
        charge = measurement.get("topological_charge")
        if label in {"initial", "constrained_held", profile_state_label} and _finite(charge):
            if abs(float(charge)) < float(thresholds.get("minimum_nontrivial_abs_topological_charge", 0.8)):
                failures.append(f"{label}_topological_charge_is_trivial")
        area = measurement.get("R_area_nm")
        core = measurement.get("R_core_nm")
        if _finite(area) and _finite(core) and abs(float(area) - float(core)) > float(thresholds.get("maximum_area_core_radius_difference_nm", 3.0)):
            warnings.append(f"{label}_area_core_radius_disagreement")

    held_measurement = states.get("constrained_held", {}).get("measurement") if isinstance(states.get("constrained_held"), dict) else None
    profile_measurement = states.get(profile_state_label, {}).get("measurement") if isinstance(states.get(profile_state_label), dict) else None
    target_radius = protocol.get("target_radius_nm")
    measured_area_radius = profile_measurement.get("R_area_nm") if isinstance(profile_measurement, dict) else None
    measured_core_radius = profile_measurement.get("R_core_nm") if isinstance(profile_measurement, dict) else None
    cell_nm = protocol.get("cell_nm", 0.5)
    radius_error = None
    area_radius_error = None
    core_radius_error = None
    radius_tolerance = None
    controlled_radius_name = "R_core" if name in {"p2", "p3"} else "R_area"
    controlled_radius = measured_core_radius if controlled_radius_name == "R_core" else measured_area_radius
    # P0 is the one-time free-relaxation control.  Its purpose is to measure
    # the natural equilibrium radius, so comparing it with the requested seed
    # radius would incorrectly turn the control into a profile point.
    if _finite(target_radius) and _finite(measured_area_radius):
        area_radius_error = abs(float(measured_area_radius) - float(target_radius))
    if _finite(target_radius) and _finite(measured_core_radius):
        core_radius_error = abs(float(measured_core_radius) - float(target_radius))
    if name != "p0" and _finite(target_radius) and _finite(controlled_radius):
        radius_error = abs(float(controlled_radius) - float(target_radius))
        radius_tolerance = max(0.5 * float(cell_nm), 0.02 * float(target_radius))
        # Measurements are reported in nanometres and can carry a few ulps
        # from the cell-centre reduction.  Keep the physical tolerance strict
        # while avoiding a false failure at an exactly-on-the-boundary value.
        if radius_error > radius_tolerance + 1.0e-9:
            if completion.get("converged") is True:
                failures.append("radius_mismatch")
            else:
                warnings.append("radius_mismatch_before_convergence")
        elif name in {"p2", "p3"} and _finite(area_radius_error) and float(area_radius_error) > radius_tolerance:
            warnings.append("area_radius_mismatch_for_core_control")
    elif name in {"p2", "p3"} and name != "p0":
        failures.append("missing_core_radius_for_core_control")

    convergence = analysis.get("convergence_diagnostics") if isinstance(analysis.get("convergence_diagnostics"), dict) else {}
    energy_window_relative = convergence.get("energy_window_relative_span")
    if _finite(energy_window_relative) and float(energy_window_relative) > float(thresholds.get("maximum_energy_window_relative_span", 1e-3)):
        if completion.get("converged") is True:
            failures.append("energy_window_not_stable")
        else:
            warnings.append("energy_window_not_stable_before_convergence")
    energy_window_relative_to_excess = None
    profile_delta = profile_energy.get("delta_E_to_background_J")
    energy_window_span = convergence.get("energy_window_span_J")
    if _finite(energy_window_span) and _finite(profile_delta):
        energy_window_relative_to_excess = float(energy_window_span) / max(
            abs(float(profile_delta)), float(thresholds.get("minimum_excess_energy_scale_J", 1e-21))
        )
    elif _finite(energy_window_relative) and _finite(profile_delta):
        # Keep compatibility with older summaries that only recorded the
        # relative span.  New runs always take the direct span branch above.
        minimum_scale = float(thresholds.get("minimum_excess_energy_scale_J", 1e-21))
        energy_window_relative_to_excess = float(energy_window_relative) * max(
            abs(float(profile_energy.get("E_total_J") or 0.0)), 1e-30
        ) / max(abs(float(profile_delta)), minimum_scale)
    if _finite(energy_window_relative_to_excess) and energy_window_relative_to_excess > float(
        thresholds.get("maximum_energy_window_relative_to_excess", 0.05)
    ):
        if completion.get("converged") is True:
            failures.append("energy_window_not_stable_relative_to_excess")
        else:
            warnings.append("energy_window_not_stable_relative_to_excess_before_convergence")

    not_converged = completion.get("converged") is False
    if not_converged:
        warnings.append(
            "solver_not_converged: max_steps/max_physical_time is diagnostic and is excluded from an accepted minimum curve"
        )
    status = "failed" if failures else ("not_converged" if not_converged else "passed")
    result = {
        "schema_version": "bimeron_frozen_size.verification.v1",
        "artifact_root": analysis.get("artifact_root"),
        "case_id": protocol.get("case_id"),
        "status": status,
        "failures": failures,
        "warnings": warnings,
        "free_torque_metric_status": free_status or "not_emitted",
        "free_torque_metric": free_torque_value,
        "free_torque_metric_units": free_torque_units,
        "free_torque_T": free_torque_t,
        "radius_error_nm": radius_error,
        "radius_tolerance_nm": radius_tolerance,
        "radius_coordinate": controlled_radius_name,
        "radius_coordinate_nm": controlled_radius,
        "area_radius_error_nm": area_radius_error,
        "core_radius_error_nm": core_radius_error,
        "energy_balance_relative": profile_energy.get("E_balance_relative"),
        "energy_window_relative_span": energy_window_relative,
        "energy_window_relative_to_excess": energy_window_relative_to_excess,
    }
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("analysis", type=Path)
    parser.add_argument("--thresholds", type=Path, default=Path(__file__).with_name("thresholds.v1.json"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = verify_analysis(_load(args.analysis), _load(args.thresholds))
    encoded = json.dumps(result, indent=2, ensure_ascii=False) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    else:
        print(encoded, end="")
    return 0 if result["status"] == "passed" else 2


if __name__ == "__main__":
    raise SystemExit(main())
