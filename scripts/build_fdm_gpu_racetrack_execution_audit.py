#!/usr/bin/env python3
"""Build an identity-bound execution audit for the solved-current racetrack.

The audit is intentionally stricter than the runtime collector.  It consumes
only persisted workload evidence and raw managed contract outputs; it never
turns an incomplete observation into a production claim.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import tempfile
from typing import Any, Mapping, Sequence


SCHEMA_VERSION = "fdm_gpu_racetrack_execution_audit.v1"
RUNTIME_EVIDENCE_SCHEMA = "fdm_gpu_solved_current_racetrack_runtime_evidence.v1"
WORKLOAD_SCHEMA = "fdm_gpu_solved_current_racetrack_workload_run.v1"
CONTRACT_SCHEMA = "fdm_gpu_racetrack_contract_artifacts.v1"
TELEMETRY_SCHEMA = "fdm_gpu_transport_telemetry_summary.v1"
EXPECTED_CURRENTS = (-1.5e12, -1.0e12, -0.5e12, 0.5e12, 1.0e12, 1.5e12)
EXPECTED_ENVIRONMENT = {
    "FULLMAG_RACETRACK_AMPLITUDES": "-1.5e12,-1.0e12,-0.5e12,0.5e12,1.0e12,1.5e12",
    "FULLMAG_RACETRACK_DRIVE_DURATION": "2.0e-9",
    "FULLMAG_RACETRACK_OUTPUT_PERIOD": "5.0e-12",
    "FULLMAG_RACETRACK_RELAX_MAX_STEPS": "50000",
    "FULLMAG_RACETRACK_RELAX_TOLT": "1.0e-6",
    "FULLMAG_FDM_EXECUTION": "gpu",
    "FULLMAG_FDM_PRECISION": "double",
    "FULLMAG_ARTIFACT_FIELD_STORAGE": "zarr",
}
REQUIRED_CONTRACTS = (
    "charge-uniform",
    "charge-layered",
    "charge-snapshot",
    "charge-transfer",
    "spin-diffusion",
    "spin-public",
    "spin-sparse",
)


class AuditError(RuntimeError):
    """A persisted execution observation is invalid or incomplete."""


def _json(path: Path, label: str) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise AuditError(f"{label}_unreadable") from error
    if not isinstance(value, Mapping):
        raise AuditError(f"{label}_invalid")
    return value


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with open(descriptor, "w", encoding="utf-8", closefd=True) as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _identity(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise AuditError(f"{label}_missing")
    required = ("managed_container", "gpu_uuid", "cuda_driver", "cuda_runtime", "build_digest", "free_memory_bytes")
    if value.get("managed_container") is not True:
        raise AuditError(f"{label}_managed_container_required")
    if any(not isinstance(value.get(field), str) or not value[field] for field in required[1:5]):
        raise AuditError(f"{label}_identity_fields_missing")
    if not isinstance(value.get("build_digest"), str) or len(value["build_digest"]) != 64:
        raise AuditError(f"{label}_build_digest_invalid")
    if not isinstance(value.get("free_memory_bytes"), int) or value["free_memory_bytes"] <= 0:
        raise AuditError(f"{label}_free_memory_invalid")
    return dict(value)


def _validate_workload(workload: Mapping[str, Any], runtime: Mapping[str, Any], reasons: list[str]) -> None:
    if workload.get("schema_version") != WORKLOAD_SCHEMA:
        reasons.append("workload_schema_invalid")
    if workload.get("status") != "completed" or workload.get("returncode") != 0:
        reasons.append("workload_not_completed")
    if workload.get("runtime_identity") != runtime:
        reasons.append("workload_runtime_identity_mismatch")
    environment = workload.get("environment")
    if not isinstance(environment, Mapping):
        reasons.append("workload_environment_missing")
    else:
        for key, expected in EXPECTED_ENVIRONMENT.items():
            if environment.get(key) != expected:
                reasons.append(f"workload_environment_{key.lower()}_invalid")


def _validate_drive(drive: Mapping[str, Any], expected: float, reasons: list[str]) -> None:
    if drive.get("requested_current_Apm2") != expected:
        reasons.append("drive_current_mismatch")
    if drive.get("status") != "completed" or drive.get("runtime_tuple_valid") is not True:
        reasons.append("drive_runtime_or_status_invalid")
    if not isinstance(drive.get("accepted_solver_steps"), int) or drive["accepted_solver_steps"] <= 0:
        reasons.append("drive_accepted_steps_invalid")
    if drive.get("missing_output_quantities") != []:
        reasons.append("drive_output_quantities_incomplete")
    hall = drive.get("hall_angle")
    if not isinstance(hall, Mapping) or hall.get("artifact") is None or hall.get("reason_code") is not None:
        reasons.append("drive_hall_artifact_invalid")


def _validate_runtime_evidence(evidence: Mapping[str, Any], reasons: list[str]) -> Mapping[str, Any] | None:
    if evidence.get("schema_version") != RUNTIME_EVIDENCE_SCHEMA:
        reasons.append("runtime_evidence_schema_invalid")
    if evidence.get("workload_id") != "racetrack_m1_v1" or evidence.get("status") != "pass":
        reasons.append("runtime_evidence_not_pass")
    if evidence.get("reason_codes") != []:
        reasons.append("runtime_evidence_reason_codes_nonempty")
    if tuple(evidence.get("expected_drive_currents_Apm2", ())) != EXPECTED_CURRENTS:
        reasons.append("runtime_evidence_expected_currents_invalid")
    drives = evidence.get("drives")
    if not isinstance(drives, list) or len(drives) != len(EXPECTED_CURRENTS):
        reasons.append("runtime_evidence_drive_count_invalid")
    else:
        for drive, expected in zip(drives, EXPECTED_CURRENTS):
            if isinstance(drive, Mapping):
                _validate_drive(drive, expected, reasons)
            else:
                reasons.append("runtime_evidence_drive_invalid")
    checkpoint = evidence.get("checkpoint_restart")
    if not isinstance(checkpoint, Mapping) or checkpoint.get("restart_contract_observed") is not True:
        reasons.append("checkpoint_restart_not_observed")
    telemetry = evidence.get("transport_telemetry")
    if not isinstance(telemetry, Mapping):
        reasons.append("transport_telemetry_missing")
    return telemetry if isinstance(telemetry, Mapping) else None


def _validate_telemetry(telemetry: Mapping[str, Any], reasons: list[str]) -> dict[str, Any]:
    if telemetry.get("schema_version") != TELEMETRY_SCHEMA:
        reasons.append("transport_telemetry_schema_invalid")
    if telemetry.get("status") != "pass":
        reasons.append("transport_telemetry_not_pass")
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
        if not isinstance(telemetry.get(field), int) or telemetry[field] < 0:
            reasons.append(f"transport_telemetry_{field}_invalid")
    if telemetry.get("stage_count") != len(EXPECTED_CURRENTS):
        reasons.append("transport_telemetry_stage_count_invalid")
    if telemetry.get("record_count", 0) <= 0:
        reasons.append("transport_telemetry_record_count_invalid")
    if telemetry.get("all_stage_records_present") is not True:
        reasons.append("transport_telemetry_stage_records_incomplete")
    if telemetry.get("hot_loop_host_device_transfers") != 0:
        reasons.append("hot_loop_host_device_transfers_nonzero")
    if telemetry.get("forbidden_transfer_bytes") != 0:
        reasons.append("hot_loop_forbidden_transfer_bytes_nonzero")
    if telemetry.get("torque_provenance") != "solved_transport":
        reasons.append("torque_provenance_invalid")
    return dict(telemetry)


def _contract_paths(root: Path, summary: Mapping[str, Any], reasons: list[str]) -> dict[str, Path]:
    if summary.get("schema_version") != CONTRACT_SCHEMA:
        reasons.append("contract_summary_schema_invalid")
    if summary.get("status") != "collected" or summary.get("promotion") != "forbidden_raw_artifacts_only":
        reasons.append("contract_summary_not_collected")
    records = summary.get("records")
    if not isinstance(records, list):
        reasons.append("contract_summary_records_missing")
        return {}
    paths: dict[str, Path] = {}
    for record in records:
        if not isinstance(record, Mapping) or record.get("kind") != "artifact":
            continue
        label = record.get("label")
        raw_path = record.get("path")
        if not isinstance(label, str) or not isinstance(raw_path, str) or record.get("status") != "collected":
            continue
        path = (root / raw_path).resolve()
        try:
            path.relative_to(root.resolve())
        except ValueError:
            reasons.append(f"contract_{label}_outside_root")
            continue
        if not path.is_file() or path.is_symlink():
            reasons.append(f"contract_{label}_missing")
            continue
        paths[label] = path
    for label in REQUIRED_CONTRACTS:
        if label not in paths:
            reasons.append(f"contract_{label}_missing")
    return paths


def _validate_contracts(paths: Mapping[str, Path], runtime: Mapping[str, Any], reasons: list[str]) -> None:
    payloads: dict[str, Mapping[str, Any]] = {}
    for label, path in paths.items():
        try:
            payloads[label] = _json(path, f"contract_{label}")
        except AuditError as error:
            reasons.append(str(error))
    identity_fields = {
        "build_digest": "build_digest",
        "device_uuid": "gpu_uuid",
        "cuda_runtime": "cuda_runtime",
    }
    for label, payload in payloads.items():
        for field, runtime_field in identity_fields.items():
            if field in payload and payload[field] != runtime.get(runtime_field):
                reasons.append(f"contract_{label}_{field}_mismatch")
    numeric_residuals = {
        "charge-uniform": ("algebraic_residual", "physical_residual", "component_balance", "electrode_balance"),
        "charge-layered": ("algebraic_residual", "physical_residual", "interface_flux_jump"),
    }
    for label, fields in numeric_residuals.items():
        payload = payloads.get(label)
        if payload is None:
            continue
        if payload.get("host_fallback_count") != 0:
            reasons.append(f"contract_{label}_host_fallback")
        for field in fields:
            if not _finite(payload.get(field)):
                reasons.append(f"contract_{label}_{field}_invalid")
    snapshot = payloads.get("charge-snapshot")
    if snapshot is not None and (snapshot.get("host_fallback_count") != 0 or snapshot.get("restored_without_resolve") is not True or snapshot.get("one_cell_restored_without_resolve") is not True):
        reasons.append("contract_charge_snapshot_restart_invalid")
    transfer = payloads.get("charge-transfer")
    if transfer is not None and (transfer.get("host_fallback_count") != 0 or transfer.get("exact_order_verified") is not True):
        reasons.append("contract_charge_transfer_invalid")
    spin = payloads.get("spin-diffusion")
    if spin is not None and (spin.get("status") != "pass" or any(spin.get(key) is not True for key in ("direct_she_six_signs", "diffusion_independent_oracle", "six_views_present", "typed_spin_cells", "typed_spin_materials", "typed_spin_formula_ids", "skip_forbidden"))):
        reasons.append("contract_spin_diffusion_invalid")
    public = payloads.get("spin-public")
    if public is not None and (public.get("passed") is not True or public.get("first_required_is_upper_bound") is not True or public.get("warm_required_is_exact") is not True):
        reasons.append("contract_spin_public_invalid")
    sparse = payloads.get("spin-sparse")
    if sparse is not None and (sparse.get("passed") is not True or sparse.get("forbidden_transfer_bytes") != 0):
        reasons.append("contract_spin_sparse_invalid")


def audit(
    evidence_root: str | Path,
    *,
    runtime_evidence_path: str | Path,
    workload_run_path: str | Path,
    runtime_identity_path: str | Path,
    contracts_path: str | Path,
) -> dict[str, Any]:
    root = Path(evidence_root).resolve()
    reasons: list[str] = []
    try:
        runtime = _identity(_json(Path(runtime_identity_path), "runtime_identity"), "runtime_identity")
    except AuditError as error:
        runtime = {}
        reasons.append(str(error))
    try:
        workload = _json(Path(workload_run_path), "workload_run")
        if runtime:
            _validate_workload(workload, runtime, reasons)
    except AuditError as error:
        workload = {}
        reasons.append(str(error))
    telemetry: Mapping[str, Any] | None = None
    try:
        evidence = _json(Path(runtime_evidence_path), "runtime_evidence")
        telemetry = _validate_runtime_evidence(evidence, reasons)
    except AuditError as error:
        evidence = {}
        reasons.append(str(error))
    telemetry_summary = _validate_telemetry(telemetry, reasons) if telemetry is not None else {}
    try:
        contracts = _json(Path(contracts_path), "contract_summary")
        paths = _contract_paths(root, contracts, reasons)
        _validate_contracts(paths, runtime, reasons)
    except AuditError as error:
        paths = {}
        reasons.append(str(error))
    unique_reasons = sorted(set(reasons))
    result: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "status": "pass" if not unique_reasons else "blocked",
        "workload_id": "racetrack_m1_v1",
        "execution_tuple": {"backend": "fdm", "device": "gpu", "precision": "double", "execution_mode": "strict"},
        "runtime_identity": runtime or None,
        "fallbacks": [],
        "hot_loop_host_device_transfers": telemetry_summary.get("hot_loop_host_device_transfers"),
        "hot_loop_device_to_device_transfers": telemetry_summary.get("hot_loop_device_to_device_transfers"),
        "hot_loop_host_sync_count": telemetry_summary.get("hot_loop_host_sync_count"),
        "forbidden_transfer_bytes": telemetry_summary.get("forbidden_transfer_bytes"),
        "allowed_control_h2d_records": telemetry_summary.get("allowed_control_h2d_records"),
        "allowed_control_h2d_bytes": telemetry_summary.get("allowed_control_h2d_bytes"),
        "allowed_scalar_d2h_records": telemetry_summary.get("allowed_scalar_d2h_records"),
        "allowed_scalar_d2h_bytes": telemetry_summary.get("allowed_scalar_d2h_bytes"),
        "torque_provenance": telemetry_summary.get("torque_provenance"),
        "transport_telemetry": telemetry_summary or None,
        "contract_artifacts": {label: path.relative_to(root).as_posix() for label, path in sorted(paths.items())},
        "reason_codes": unique_reasons,
        "producer": "build_fdm_gpu_racetrack_execution_audit.py",
    }
    return result


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-root", type=Path, required=True)
    parser.add_argument("--runtime-evidence", type=Path, required=True)
    parser.add_argument("--workload-run", type=Path, required=True)
    parser.add_argument("--runtime-identity", type=Path, required=True)
    parser.add_argument("--contracts", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    result = audit(
        args.evidence_root,
        runtime_evidence_path=args.runtime_evidence,
        workload_run_path=args.workload_run,
        runtime_identity_path=args.runtime_identity,
        contracts_path=args.contracts,
    )
    _write_json(args.output, result)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
