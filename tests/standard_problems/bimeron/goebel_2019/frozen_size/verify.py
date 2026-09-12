"""Verify frozen-spin bimeron profile analysis without relabelling gaps."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any


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
    runtime = analysis.get("runtime_provenance") if isinstance(analysis.get("runtime_provenance"), dict) else {}
    requested = runtime.get("requested_execution") if isinstance(runtime.get("requested_execution"), dict) else {}
    provenance = runtime.get("execution_provenance") if isinstance(runtime.get("execution_provenance"), dict) else {}
    completion = runtime.get("completion") if isinstance(runtime.get("completion"), dict) else {}
    if thresholds.get("require_runtime_provenance", True):
        if not requested or not provenance:
            failures.append("runtime_provenance_missing")
    if thresholds.get("require_completion", True) and not completion:
        failures.append("completion_provenance_missing")
    if str(requested.get("device", "")).lower() == "gpu" and thresholds.get("require_gpu_residency", True):
        receipt = provenance.get("fdm_gpu_execution_receipt") if isinstance(provenance.get("fdm_gpu_execution_receipt"), dict) else {}
        if receipt.get("resolved") != "device_resident" or receipt.get("executed") != "cuda_fdm":
            failures.append("gpu_execution_not_device_resident")
        if receipt.get("fallback_count") not in {0, 0.0}:
            failures.append("gpu_fallback_detected")
    states = analysis.get("states") if isinstance(analysis.get("states"), dict) else {}
    for label in ("initial", "constrained_held"):
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
    if free_status != "emitted":
        warnings.append("free_torque_metric_not_emitted: full/all torque must not be interpreted as free-only")

    for label, payload in states.items():
        measurement = payload.get("measurement") if isinstance(payload, dict) else None
        if not isinstance(measurement, dict):
            continue
        charge = measurement.get("topological_charge")
        if label in {"initial", "constrained_held"} and _finite(charge):
            if abs(float(charge)) < float(thresholds.get("minimum_nontrivial_abs_topological_charge", 0.8)):
                failures.append(f"{label}_topological_charge_is_trivial")
        area = measurement.get("R_area_nm")
        core = measurement.get("R_core_nm")
        if _finite(area) and _finite(core) and abs(float(area) - float(core)) > float(thresholds.get("maximum_area_core_radius_difference_nm", 3.0)):
            warnings.append(f"{label}_area_core_radius_disagreement")

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
