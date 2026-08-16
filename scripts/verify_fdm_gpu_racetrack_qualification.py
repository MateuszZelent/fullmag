#!/usr/bin/env python3
"""Fail-closed validator for the managed FDM/CUDA racetrack qualification.

The validator consumes evidence produced by the managed recipe.  It never runs
the workload, manufactures a missing proof, or promotes the capability matrix.
"""

from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path
from typing import Any


MANIFEST_NAME = "fdm_gpu_solved_current_racetrack_qualification_v1.json"
SCHEMA_VERSION = "fdm_gpu_solved_current_racetrack_qualification.v1"
GATE_EVIDENCE_SCHEMA = "fdm_gpu_racetrack_gate_evidence.v1"
GATE_PROOF_SCHEMA = "fdm_gpu_racetrack_gate_proof.v1"
EXECUTION_AUDIT_SCHEMA = "fdm_gpu_racetrack_execution_audit.v1"
REQUIRED_GATES = (
    "workload_signs_units",
    "solved_charge",
    "direct_she_steady_spin",
    "hm_fm_interface",
    "transport_torque",
    "transport_llg_lifecycle",
    "stable_skyrmion",
    "driven_racetrack",
    "hall_angle",
    "mumax_common_limit",
    "product_contract",
    "production_runtime",
)
EXPECTED_TUPLE = {
    "backend": "fdm",
    "device": "gpu",
    "precision": "double",
    "execution_mode": "strict",
}
REQUIRED_QUANTITIES = {
    "m",
    "J_c",
    "mu_s",
    "Q_spin",
    "T_tr_G",
    "topological_charge",
    "skyrmion_center",
    "skyrmion_hall_angle",
}
SHA256 = re.compile(r"^[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")


class QualificationError(RuntimeError):
    """An evidence contract error that blocks qualification promotion."""


def require(condition: bool, reason_code: str) -> None:
    if not condition:
        raise QualificationError(reason_code)


def object_at(value: Any, label: str) -> dict[str, Any]:
    require(isinstance(value, dict), f"{label}_missing_or_invalid")
    return value


def bool_at(value: dict[str, Any], field: str, label: str) -> None:
    require(value.get(field) is True, f"{label}_{field}_required")


def string_at(value: dict[str, Any], field: str, expected: str, label: str) -> None:
    require(value.get(field) == expected, f"{label}_{field}_invalid")


def identity(value: Any, label: str) -> dict[str, Any]:
    result = object_at(value, label)
    require(isinstance(result.get("commit"), str) and COMMIT.fullmatch(result["commit"]), f"{label}_commit_invalid")
    for field in ("source_snapshot_sha256", "input_sha256", "fixture_sha256"):
        require(isinstance(result.get(field), str) and SHA256.fullmatch(result[field]), f"{label}_{field}_invalid")
    return result


def runtime_identity(value: Any, label: str) -> dict[str, Any]:
    result = object_at(value, label)
    bool_at(result, "managed_container", label)
    for field in ("gpu_uuid", "cuda_driver", "cuda_runtime"):
        require(isinstance(result.get(field), str) and result[field], f"{label}_{field}_missing")
    require(isinstance(result.get("build_digest"), str) and SHA256.fullmatch(result["build_digest"]), f"{label}_build_digest_invalid")
    free_memory = result.get("free_memory_bytes")
    require(isinstance(free_memory, int) and not isinstance(free_memory, bool) and free_memory > 0, f"{label}_free_memory_bytes_invalid")
    return result


def same_identity(expected: dict[str, Any], actual: dict[str, Any], label: str) -> None:
    require(actual == expected, f"{label}_source_identity_mismatch")


def same_runtime_identity(expected: dict[str, Any], actual: dict[str, Any], label: str) -> None:
    require(actual == expected, f"{label}_runtime_identity_mismatch")


def relative_artifact(root: Path, raw: Any, gate_id: str) -> Path:
    require(isinstance(raw, str) and raw, f"{gate_id}_artifact_missing")
    artifact = (root / raw).resolve()
    try:
        artifact.relative_to(root.resolve())
    except ValueError as error:
        raise QualificationError(f"{gate_id}_artifact_outside_evidence_root") from error
    require(artifact.is_file(), f"{gate_id}_artifact_missing")
    return artifact


def load_json(path: Path, label: str) -> dict[str, Any]:
    try:
        return object_at(json.loads(path.read_text(encoding="utf-8")), label)
    except (OSError, json.JSONDecodeError) as error:
        raise QualificationError(f"{label}_unreadable") from error


def validate_gate_proof(
    root: Path,
    gate_id: str,
    evidence: dict[str, Any],
    expected_source: dict[str, Any],
    expected_runtime: dict[str, Any],
) -> None:
    """Require an identity-bound proof and at least one independent raw file."""

    proof_meta = object_at(evidence.get("proof"), f"{gate_id}_proof")
    string_at(proof_meta, "schema_version", GATE_PROOF_SCHEMA, f"{gate_id}_proof")
    raw_path = proof_meta.get("path")
    require(isinstance(raw_path, str) and raw_path, f"{gate_id}_proof_path_missing")
    proof_path = (root / raw_path).resolve()
    try:
        proof_relative = proof_path.relative_to(root.resolve()).as_posix()
    except ValueError as error:
        raise QualificationError(f"{gate_id}_proof_outside_evidence_root") from error
    require(proof_relative.split("/", 1)[0] == "proofs", f"{gate_id}_proof_path_invalid")
    require(proof_relative.rsplit("/", 1)[-1] == f"{gate_id}.json", f"{gate_id}_proof_path_invalid")
    require(proof_path.is_file() and not proof_path.is_symlink(), f"{gate_id}_proof_missing")
    proof = load_json(proof_path, f"{gate_id}_proof_file")
    string_at(proof, "schema_version", GATE_PROOF_SCHEMA, f"{gate_id}_proof_file")
    string_at(proof, "gate_id", gate_id, f"{gate_id}_proof_file")
    string_at(proof, "status", "pass", f"{gate_id}_proof_file")
    same_identity(
        expected_source,
        identity(proof.get("source_identity"), f"{gate_id}_proof_source_identity"),
        f"{gate_id}_proof",
    )
    same_runtime_identity(
        expected_runtime,
        runtime_identity(proof.get("runtime_identity"), f"{gate_id}_proof_runtime_identity"),
        f"{gate_id}_proof",
    )
    proof_claims = object_at(proof.get("claims"), f"{gate_id}_proof_claims")
    claims = object_at(evidence.get("claims"), f"{gate_id}_claims")
    require(proof_claims == claims, f"{gate_id}_proof_claims_mismatch")
    validate_gate_claims(gate_id, proof_claims)

    proof_paths = proof.get("evidence_paths")
    declared_paths = proof_meta.get("evidence_paths")
    require(isinstance(proof_paths, list) and proof_paths, f"{gate_id}_proof_evidence_missing")
    require(isinstance(declared_paths, list) and declared_paths, f"{gate_id}_proof_evidence_missing")
    require(
        all(isinstance(item, str) and item for item in declared_paths),
        f"{gate_id}_proof_evidence_path_invalid",
    )
    normalized: list[str] = []
    for item in proof_paths:
        require(isinstance(item, str) and item, f"{gate_id}_proof_evidence_path_invalid")
        candidate = (root / item).resolve()
        try:
            relative = candidate.relative_to(root.resolve()).as_posix()
        except ValueError as error:
            raise QualificationError(f"{gate_id}_proof_evidence_outside_root") from error
        require(relative.split("/", 1)[0] not in {"proofs", "gates"}, f"{gate_id}_proof_evidence_must_be_raw")
        require(candidate.is_file() and not candidate.is_symlink(), f"{gate_id}_proof_evidence_missing")
        normalized.append(relative)
    require(sorted(set(normalized)) == sorted(set(declared_paths)), f"{gate_id}_proof_evidence_mismatch")


def validate_gate_claims(gate_id: str, claims: dict[str, Any]) -> None:
    if gate_id == "workload_signs_units":
        string_at(claims, "fixture_id", "racetrack_m1_v1", gate_id)
        for key in ("signs_verified", "si_units_verified", "requested_resolved_tuple_equal"):
            bool_at(claims, key, gate_id)
    elif gate_id in ("solved_charge", "direct_she_steady_spin"):
        for key in ("analytic_oracle", "cpu_oracle", "cuda_parity", "convergence"):
            bool_at(claims, key, gate_id)
        bool_at(claims, "charge_balance" if gate_id == "solved_charge" else "spin_balance", gate_id)
    elif gate_id == "hm_fm_interface":
        for key in ("transparent_limit", "zero_conductance_limit", "real_mixing_limit", "imaginary_mixing_limit", "orientation_limit"):
            bool_at(claims, key, gate_id)
    elif gate_id == "transport_torque":
        string_at(claims, "torque_provenance", "solved_transport", gate_id)
        for key in ("algebraic_oracle", "target_mask_verified", "device_rhs_evaluation"):
            bool_at(claims, key, gate_id)
        require(claims.get("prescribed_torque_used") is False, "transport_torque_prescribed_torque_forbidden")
    elif gate_id == "transport_llg_lifecycle":
        for key in ("all_rk_stages", "rollback_exact", "checkpoint_restart", "hot_loop_device_to_device"):
            bool_at(claims, key, gate_id)
    elif gate_id == "stable_skyrmion":
        grids = claims.get("relaxed_grids")
        require(isinstance(grids, list) and len(set(grids)) >= 3, "stable_skyrmion_three_grids_required")
        for key in ("topology_stable", "energy_converged", "radius_converged", "center_stable"):
            bool_at(claims, key, gate_id)
    elif gate_id == "driven_racetrack":
        currents = claims.get("drive_currents_Apm2")
        require(isinstance(currents, list) and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in currents), "driven_racetrack_drive_currents_invalid")
        required = {-1.5e12, -1.0e12, -0.5e12, 0.5e12, 1.0e12, 1.5e12}
        require(set(float(x) for x in currents) == required, "driven_racetrack_drive_currents_incomplete")
        for key in ("no_annihilation", "no_edge_contamination", "transport_balance"):
            bool_at(claims, key, gate_id)
    elif gate_id == "hall_angle":
        string_at(claims, "algorithm_version", "skyrmion_hall_angle_v1", gate_id)
        for key in ("uncertainty_reported", "stationary_window", "finite_angle"):
            bool_at(claims, key, gate_id)
    elif gate_id == "mumax_common_limit":
        string_at(claims, "comparison_scope", "common_magnetodynamic_limit", gate_id)
        require(claims.get("solved_current_oracle") is False, "mumax_common_limit_solved_current_oracle_forbidden")
        for key in ("identical_torque_field", "literal_demag_policy_reported", "converged_demag_policy_reported"):
            bool_at(claims, key, gate_id)
    elif gate_id == "product_contract":
        for key in ("python_ui_round_trip", "normalized_ir_digest_equal"):
            bool_at(claims, key, gate_id)
        quantities = claims.get("output_quantities")
        require(isinstance(quantities, list) and REQUIRED_QUANTITIES <= set(quantities), "product_contract_output_quantities_incomplete")
    elif gate_id == "production_runtime":
        for key in ("checkpoint_restart", "deterministic_repeat", "memory_budget_descriptor_derived", "memory_budget_within_free_memory", "performance_within_budget", "compute_sanitizer_clean", "no_fallback", "no_hot_loop_transfer"):
            bool_at(claims, key, gate_id)
    else:  # pragma: no cover - required gate list is static.
        raise QualificationError(f"unknown_gate_{gate_id}")


def validate_evidence_root(
    evidence_root: Path,
    manifest_path: Path | None = None,
    source_snapshot_path: Path | None = None,
) -> dict[str, Any]:
    root = evidence_root.resolve()
    manifest_path = (manifest_path or root / MANIFEST_NAME).resolve()
    require(manifest_path.is_file(), "manifest_missing")
    try:
        manifest_path.relative_to(root)
    except ValueError as error:
        raise QualificationError("manifest_outside_evidence_root") from error
    manifest = load_json(manifest_path, "manifest")
    string_at(manifest, "schema_version", SCHEMA_VERSION, "manifest")
    string_at(manifest, "status", "pass", "manifest")
    string_at(manifest, "workload_id", "racetrack_m1_v1", "manifest")
    execution_tuple = object_at(manifest.get("execution_tuple"), "execution_tuple")
    require(set(execution_tuple) == set(EXPECTED_TUPLE), "execution_tuple_not_exact_fdm_gpu_double_strict")
    for field, expected in EXPECTED_TUPLE.items():
        require(execution_tuple.get(field) == expected, f"execution_tuple_{field}_not_exact")
    source = identity(manifest.get("source_identity"), "manifest_source_identity")
    if source_snapshot_path is not None:
        snapshot = load_json(source_snapshot_path.resolve(), "current_source_snapshot")
        require(snapshot.get("head_commit_full") == source["commit"], "current_source_snapshot_commit_mismatch")
        require(snapshot.get("source_snapshot_sha256") == source["source_snapshot_sha256"], "current_source_snapshot_digest_mismatch")
    runtime = runtime_identity(manifest.get("runtime_identity"), "manifest_runtime_identity")
    hashes = object_at(manifest.get("input_hashes"), "input_hashes")
    for key in ("before", "after"):
        require(isinstance(hashes.get(key), str) and SHA256.fullmatch(hashes[key]), f"input_hashes_{key}_invalid")
    require(hashes["before"] == hashes["after"], "input_hash_drift")
    audit = object_at(manifest.get("execution_audit"), "execution_audit")
    string_at(audit, "schema_version", EXECUTION_AUDIT_SCHEMA, "execution_audit")
    string_at(audit, "status", "pass", "execution_audit")
    same_runtime_identity(runtime, runtime_identity(audit.get("runtime_identity"), "execution_audit_runtime_identity"), "execution_audit")
    require(audit.get("reason_codes") == [], "execution_audit_reason_codes_nonempty")
    require(audit.get("fallbacks") == [], "execution_audit_fallback_forbidden")
    require(audit.get("hot_loop_host_device_transfers") == 0, "execution_audit_hot_loop_transfer_forbidden")
    require(audit.get("forbidden_transfer_bytes") == 0, "execution_audit_forbidden_transfer_bytes")
    string_at(audit, "torque_provenance", "solved_transport", "execution_audit")
    telemetry = object_at(audit.get("transport_telemetry"), "execution_audit_transport_telemetry")
    string_at(telemetry, "schema_version", "fdm_gpu_transport_telemetry_summary.v1", "execution_audit_transport_telemetry")
    string_at(telemetry, "status", "pass", "execution_audit_transport_telemetry")
    require(telemetry.get("hot_loop_host_device_transfers") == 0, "execution_audit_transport_telemetry_host_transfer_forbidden")
    require(telemetry.get("forbidden_transfer_bytes") == 0, "execution_audit_transport_telemetry_forbidden_bytes")
    for field in (
        "stage_count",
        "record_count",
        "hot_loop_host_device_transfers",
        "hot_loop_device_to_device_transfers",
        "hot_loop_host_sync_count",
        "forbidden_transfer_bytes",
        "allowed_control_h2d_records",
        "allowed_control_h2d_bytes",
        "allowed_scalar_d2h_records",
        "allowed_scalar_d2h_bytes",
    ):
        require(isinstance(telemetry.get(field), int) and telemetry[field] >= 0, f"execution_audit_transport_telemetry_{field}_invalid")
    require(telemetry.get("stage_count") == 6, "execution_audit_transport_telemetry_stage_count_invalid")
    require(telemetry.get("record_count", 0) > 0, "execution_audit_transport_telemetry_record_count_invalid")
    require(telemetry.get("all_stage_records_present") is True, "execution_audit_transport_telemetry_stage_records_incomplete")
    gate_index = object_at(manifest.get("gates"), "gates")
    require(set(gate_index) == set(REQUIRED_GATES), "gate_set_incomplete_or_unknown")
    validated_gates: dict[str, dict[str, str]] = {}
    for gate_id in REQUIRED_GATES:
        entry = object_at(gate_index.get(gate_id), f"{gate_id}_index")
        string_at(entry, "status", "pass", f"{gate_id}_index")
        artifact_path = relative_artifact(root, entry.get("artifact"), gate_id)
        evidence = load_json(artifact_path, gate_id)
        string_at(evidence, "schema_version", GATE_EVIDENCE_SCHEMA, gate_id)
        string_at(evidence, "status", "pass", gate_id)
        same_identity(source, identity(evidence.get("source_identity"), f"{gate_id}_source_identity"), gate_id)
        same_runtime_identity(runtime, runtime_identity(evidence.get("runtime_identity"), f"{gate_id}_runtime_identity"), gate_id)
        validate_gate_claims(gate_id, object_at(evidence.get("claims"), f"{gate_id}_claims"))
        validate_gate_proof(root, gate_id, evidence, source, runtime)
        validated_gates[gate_id] = {"status": "pass", "artifact": str(artifact_path.relative_to(root))}
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "pass",
        "workload_id": "racetrack_m1_v1",
        "execution_tuple": EXPECTED_TUPLE,
        "source_identity": source,
        "runtime_identity": runtime,
        "gates": validated_gates,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--source-snapshot", type=Path)
    args = parser.parse_args()
    try:
        result = validate_evidence_root(args.evidence_root, args.manifest, args.source_snapshot)
    except QualificationError as error:
        print(f"FAIL: {error}")
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
