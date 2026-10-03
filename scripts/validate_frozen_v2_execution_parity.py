"""Compare two revalidated frozen-v2 runs without claiming science or speedup.

The local -10,+10,-10 probe uses the same native build, frozen MeshIR,
equilibrium, derived script, numerical settings and host consumers. Only the
explicit serial/adaptive policy mode may differ. Frequency tolerances reuse
the existing DE execution-parity gate; each physical residual must separately
pass the existing full-descriptor gate.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any, Mapping

import validate_de_frozen_v2_probe as probe
from validate_de_smoke_rows import DENSE_CERTIFICATION_TOLERANCE, MAX_PROBE_RELATIVE_TOLERANCE
from validate_parallel_execution_report import validate_parallel_execution_report

FREQUENCY_RELATIVE_TOLERANCE = MAX_PROBE_RELATIVE_TOLERANCE
FREQUENCY_ABSOLUTE_TOLERANCE_HZ = 1e-6
EXPECTED_VECTORS = ((0.0, -1e7, 0.0), (0.0, 1e7, 0.0), (0.0, -1e7, 0.0))
PHYSICAL_IDENTITY_FIELDS = probe.fem_linearization_identity_replay.IDENTITY_FIELDS - {
    "consumer_plan_snapshot_sha256", "content_sha256",
}


def _same(left: Any, right: Any, label: str) -> None:
    # Strict JSON comparison keeps booleans distinct from numbers.
    options = dict(sort_keys=True, separators=(",", ":"), allow_nan=False)
    if json.dumps(left, **options) != json.dumps(right, **options):
        raise probe.ProbeValidationError(f"serial/adaptive {label} differs")


def _finite(value: Any, label: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise probe.ProbeValidationError(f"{label} must be finite numeric evidence")
    value = float(value)
    if not math.isfinite(value) or value < 0 or (positive and value == 0):
        raise probe.ProbeValidationError(f"{label} must be finite in the allowed range")
    return value


def _close(left: float, right: float) -> bool:
    return math.isclose(left, right, rel_tol=FREQUENCY_RELATIVE_TOLERANCE,
                        abs_tol=FREQUENCY_ABSOLUTE_TOLERANCE_HZ)


def _physical_identity(binding: Mapping[str, Any], label: str) -> Mapping[str, Any]:
    identity = binding.get("immutable_physical_identity")
    if not isinstance(identity, Mapping) or set(identity) != PHYSICAL_IDENTITY_FIELDS:
        raise probe.ProbeValidationError(f"{label} lacks the full immutable physical identity")
    raw = json.dumps(identity, sort_keys=True, separators=(",", ":"),
                     ensure_ascii=False, allow_nan=False).encode("utf-8")
    digest = "sha256:" + hashlib.sha256(raw).hexdigest()
    if binding.get("immutable_physical_identity_sha256") != digest:
        raise probe.ProbeValidationError(f"{label} immutable physical identity digest differs")
    for field in ("sample_index", "equilibrium_content_sha256", "source_mesh_topology_sha256",
                  "modal_mesh_topology_fingerprint_v3", "linearization_state_sha256"):
        _same(identity[field], binding.get(field), f"{label} physical identity.{field}")
    return identity


def compare_validated_runs(
    requests: Mapping[str, Mapping[str, Any]],
    validations: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    """Pure comparison step; callers must first revalidate both native cases."""
    if set(requests) != {"serial", "adaptive"} or set(validations) != set(requests):
        raise probe.ProbeValidationError("exactly one serial and one adaptive run are required")
    left, right = requests["serial"], requests["adaptive"]
    for mode in ("serial", "adaptive"):
        request, validated = requests[mode], validations[mode]
        if request.get("mode") != mode or validated.get("status") != "passed_artifact_preflight":
            raise probe.ProbeValidationError(f"{mode} does not have current artifact preflight")
        if validated.get("qualification") != "NOT VERIFIED":
            raise probe.ProbeValidationError(f"{mode} artifact preflight overclaims qualification")
        if not isinstance(request.get("mode_policy"), Mapping) or request["mode_policy"].get("mode") != mode:
            raise probe.ProbeValidationError(f"{mode} execution policy is not bound")
    for field in ("job", "source", "bundle", "numerics", "consumer_hashes"):
        if not isinstance(left.get(field), Mapping) or not left[field]:
            raise probe.ProbeValidationError(f"serial request lacks {field}")
        _same(left[field], right.get(field), field)
    for field in ("original", "derived_script_sha256"):
        value = left.get("model", {}).get(field)
        if not value:
            raise probe.ProbeValidationError(f"serial request lacks model.{field}")
        _same(value, right.get("model", {}).get(field), f"model.{field}")
    policy_left, policy_right = dict(left["mode_policy"]), dict(right["mode_policy"])
    policy_left.pop("mode")
    policy_right.pop("mode")
    _same(policy_left, policy_right, "policy outside mode")
    for mode in ("serial", "adaptive"):
        validation = validations[mode]
        bindings = validation.get("native_bindings_by_sample")
        phases = validation.get("solver", {}).get("phase_constraints_by_sample")
        if not isinstance(bindings, list) or len(bindings) != 3 or not isinstance(phases, list) or len(phases) != 3:
            raise probe.ProbeValidationError(f"{mode} lacks three current native identities and phases")
        for index, binding in enumerate(bindings):
            if type(binding.get("sample_index")) is not int or binding["sample_index"] != index:
                raise probe.ProbeValidationError(f"{mode} native identity sample order differs")
            for field in ("equilibrium_content_sha256", "source_mesh_topology_sha256",
                          "modal_mesh_topology_fingerprint_v3", "linearization_state_sha256"):
                value = binding.get(field)
                if not isinstance(value, str) or not value.startswith("sha256:") or len(value) != 71:
                    raise probe.ProbeValidationError(f"{mode} native sample {index} lacks {field}")
            _physical_identity(binding, f"{mode} native sample {index}")
    for index in range(3):
        for field in ("equilibrium_content_sha256", "source_mesh_topology_sha256",
                      "modal_mesh_topology_fingerprint_v3", "linearization_state_sha256"):
            _same(validations["serial"]["native_bindings_by_sample"][index][field],
                  validations["adaptive"]["native_bindings_by_sample"][index][field],
                  f"native sample {index}.{field}")
        _same(validations["serial"]["native_bindings_by_sample"][index]["immutable_physical_identity"],
              validations["adaptive"]["native_bindings_by_sample"][index]["immutable_physical_identity"],
              f"native sample {index} immutable physical identity")
    _same(validations["serial"]["solver"]["phase_constraints_by_sample"],
          validations["adaptive"]["solver"]["phase_constraints_by_sample"], "per-sample Floquet constraints")
    rows: dict[str, list[Mapping[str, Any]]] = {}
    for mode in ("serial", "adaptive"):
        rows[mode] = validations[mode].get("samples", {}).get("samples")
        if not isinstance(rows[mode], list) or len(rows[mode]) != 3:
            raise probe.ProbeValidationError(f"{mode} must have three native samples")
        for index, row in enumerate(rows[mode]):
            if (type(row.get("sample_index")) is not int or row["sample_index"] != index
                    or type(row.get("source_sample_index")) is not int
                    or row["source_sample_index"] != (3, 11, 3)[index]):
                raise probe.ProbeValidationError(f"{mode} native sample mapping differs")
            if row.get("k_vector_rad_per_m") != list(EXPECTED_VECTORS[index]):
                raise probe.ProbeValidationError(f"{mode} native k vector differs")
            _finite(row.get("frequency_hz"), f"{mode} sample {index} frequency", positive=True)
            residual = _finite(row.get("residual_relative_l2"), f"{mode} sample {index} residual")
            if residual > DENSE_CERTIFICATION_TOLERANCE:
                raise probe.ProbeValidationError(f"{mode} sample {index} exceeds the physical residual ceiling")
    comparisons = []
    for index, (a, b) in enumerate(zip(rows["serial"], rows["adaptive"])):
        fa, fb = float(a["frequency_hz"]), float(b["frequency_hz"])
        comparisons.append({
            "sample_index": index, "k_vector_rad_per_m": list(EXPECTED_VECTORS[index]),
            "serial_frequency_hz": fa, "adaptive_frequency_hz": fb,
            "difference_hz": abs(fa - fb), "within_tolerance": _close(fa, fb),
            "serial_residual_relative_l2": a["residual_relative_l2"],
            "adaptive_residual_relative_l2": b["residual_relative_l2"],
        })
    repeats = {mode: {"difference_hz": abs(rows[mode][0]["frequency_hz"] - rows[mode][2]["frequency_hz"]),
                      "within_tolerance": _close(rows[mode][0]["frequency_hz"], rows[mode][2]["frequency_hz"])}
               for mode in rows}
    passed = all(item["within_tolerance"] for item in comparisons) and all(item["within_tolerance"] for item in repeats.values())
    return {
        "schema_version": "fullmag.de.frozen_v2_execution_parity.v1",
        "status": "parity_passed_unqualified" if passed else "parity_failed",
        "qualification": "NOT VERIFIED", "same_frozen_inputs_and_native_states": True,
        "frequency_tolerance": {"relative": FREQUENCY_RELATIVE_TOLERANCE,
                                "absolute_hz": FREQUENCY_ABSOLUTE_TOLERANCE_HZ,
                                "source": "existing DE serial/adaptive execution-parity gate"},
        "physical_residual_ceiling": DENSE_CERTIFICATION_TOLERANCE,
        "physical_residuals_within_ceiling": True,
        "residual_equality_claimed": False,
        "comparisons": comparisons, "repeated_minus10": repeats,
        "pending_requirements": ["scientific convergence", "COMSOL A1 comparison", "release qualification"],
    }


def validate_execution_parity(serial_batch: str | Path, adaptive_batch: str | Path) -> dict[str, Any]:
    """Rehash/revalidate both durable runs before comparing their native modes."""
    requests, validations, receipt_hashes = {}, {}, {}
    for mode, root in (("serial", Path(serial_batch)), ("adaptive", Path(adaptive_batch))):
        request_path, result_path = root / "run-request.json", root / "run-result.json"
        request_path, raw, request = probe._read_receipt(request_path, f"{mode} request")
        case = root / "de-smoke-signed-fifteen"
        validations[mode] = probe.validate_probe_artifacts(case, request_path, result_path)
        requests[mode] = request
        receipt_hashes[mode] = {"request_sha256": hashlib.sha256(raw).hexdigest(),
                              "result_sha256": probe._sha256_file(result_path)[1],
                              "case_artifact_hashes_sha256": validations[mode]["case_artifact_hashes_sha256"]}
    comparison = compare_validated_runs(requests, validations)
    report = validate_parallel_execution_report(
        Path(adaptive_batch) / "de-smoke-signed-fifteen/eigen/parallel_execution.v1.json",
        expected_mode="adaptive", expected_sample_count=3, require_concurrency=False,
    )
    comparison["receipt_hashes"] = receipt_hashes
    comparison["concurrency"] = report["concurrency"]
    comparison["resource_quality"] = report["resource_quality"]
    comparison["performance_qualification"] = "NOT VERIFIED"
    comparison["speedup_claimed"] = False
    # Revalidate after comparison/report reads as well; a changed native file
    # must not be covered by the earlier durable preflight.
    for mode, root in (("serial", Path(serial_batch)), ("adaptive", Path(adaptive_batch))):
        current = probe.validate_probe_artifacts(root / "de-smoke-signed-fifteen", root / "run-request.json", root / "run-result.json")
        _same(current, validations[mode], f"{mode} current artifact validation")
        _same(probe._sha256_file(root / "run-request.json")[1], receipt_hashes[mode]["request_sha256"], f"{mode} request bytes")
        _same(probe._sha256_file(root / "run-result.json")[1], receipt_hashes[mode]["result_sha256"], f"{mode} result bytes")
    return comparison


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("serial_batch", type=Path)
    parser.add_argument("adaptive_batch", type=Path)
    args = parser.parse_args()
    try:
        result = validate_execution_parity(args.serial_batch, args.adaptive_batch)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({"status": "failed", "qualification": "NOT VERIFIED", "error": str(error)}, allow_nan=False))
        return 1
    print(json.dumps(result, indent=2, allow_nan=False))
    return 0 if result["status"] == "parity_passed_unqualified" else 1


if __name__ == "__main__":
    raise SystemExit(main())
