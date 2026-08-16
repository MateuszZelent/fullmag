#!/usr/bin/env python3
"""Collect runtime evidence for the solved-current FDM racetrack workload.

This collector is deliberately weaker than the twelve-gate qualification
validator.  It materializes observations from completed stage artifacts,
creates Hall-analysis artifacts from the persisted ``m.zarr`` series, and
reports blockers.  Completed non-normative drive amplitudes are retained under
``diagnostic_drives`` and marked as unexpected; they never satisfy the
normative six-drive set.  It never fabricates gate claims or writes the
qualification manifest accepted by ``verify_fdm_gpu_racetrack_qualification``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any, Mapping

try:
    from scripts.build_skyrmion_hall_artifact import HallBuildError, build_hall_artifact
except ModuleNotFoundError:  # direct ``python scripts/collect_...py`` invocation
    from build_skyrmion_hall_artifact import HallBuildError, build_hall_artifact


SCHEMA_VERSION = "fdm_gpu_solved_current_racetrack_runtime_evidence.v1"
EXPECTED_DRIVES = (-1.5e12, -1.0e12, -0.5e12, 0.5e12, 1.0e12, 1.5e12)
DRIVE_PATTERN = re.compile(r"^drive_solved_current_(minus|plus)_([0-9]+)_([0-9]+)$")
QUANTITY_PATHS = {
    "m": "fields/m.zarr",
    # Current native qualification runs use the binary Zarr store.  The
    # legacy JSON directory is retained as a read-only compatibility path so
    # old evidence remains inspectable, but it is never preferred.
    "J_c": ("fields/J_charge.zarr", "fields/J_charge"),
    "mu_s": ("fields/spin_potential.zarr", "fields/spin_potential"),
    "Q_spin": ("fields/spin_current_tensor.zarr", "fields/spin_current_tensor"),
    "T_tr_G": ("fields/torque_stt.zarr", "fields/torque_stt"),
}


class EvidenceCollectionError(RuntimeError):
    """The session root cannot be inspected safely."""


def _json(path: Path, label: str) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise EvidenceCollectionError(f"{label}_unreadable") from error
    if not isinstance(value, Mapping):
        raise EvidenceCollectionError(f"{label}_invalid")
    return value


def _drive_id_to_current(stage_id: str) -> tuple[str, float] | None:
    match = DRIVE_PATTERN.fullmatch(stage_id)
    if match is None:
        return None
    sign = -1.0 if match.group(1) == "minus" else 1.0
    return stage_id, sign * float(f"{match.group(2)}.{match.group(3)}") * 1.0e12


def _drive_id(current: float) -> str:
    sign = "minus" if current < 0.0 else "plus"
    magnitude = f"{abs(current) / 1.0e12:.1f}".replace(".", "_")
    return f"drive_solved_current_{sign}_{magnitude}"


def _runtime_metadata(metadata: Mapping[str, Any]) -> Mapping[str, Any]:
    problem_meta = metadata.get("problem_meta")
    if not isinstance(problem_meta, Mapping):
        raise EvidenceCollectionError("problem_meta_missing")
    runtime = problem_meta.get("runtime_metadata")
    if not isinstance(runtime, Mapping):
        raise EvidenceCollectionError("runtime_metadata_missing")
    return runtime


def _stage_id(metadata: Mapping[str, Any]) -> str:
    runtime = _runtime_metadata(metadata)
    value = runtime.get("active_stage_id")
    if not isinstance(value, str) or not value:
        raise EvidenceCollectionError("active_stage_id_missing")
    return value


def _relative(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def _sha256(path: Path) -> str | None:
    try:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()
    except OSError:
        return None


def _write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def _resolve_checkpoint_path(raw: Any, artifact_root: Path | None) -> Path | None:
    if not isinstance(raw, str):
        return None
    direct = Path(raw)
    if direct.is_file():
        return direct
    if artifact_root is None:
        return None
    parts = direct.parts
    for anchor in ("states", "checkpoints"):
        if anchor not in parts:
            continue
        candidate = artifact_root.joinpath(*parts[parts.index(anchor) :])
        if candidate.is_file():
            return candidate
    return None


def _checkpoint_evidence(
    session_root: Path,
    expected_drive_count: int,
    artifact_root: Path | None,
) -> tuple[dict[str, Any], list[str]]:
    saves: list[dict[str, Any]] = []
    loads: list[dict[str, Any]] = []
    for path in sorted((session_root / "stages").glob("stage_*/synthetic_stage.json")):
        try:
            record = _json(path, "synthetic_stage")
        except EvidenceCollectionError:
            continue
        kind = record.get("kind")
        if kind == "save_state":
            stored = record.get("stored_path")
            resolved = _resolve_checkpoint_path(stored, artifact_root)
            saves.append(
                {
                    "stage": path.parent.name,
                    "stored_path": stored,
                    "resolved_path": str(resolved) if resolved is not None else None,
                    "exists": resolved is not None,
                    "sha256": _sha256(resolved) if resolved is not None else None,
                }
            )
        elif kind == "load_state":
            source = record.get("source_path")
            resolved = _resolve_checkpoint_path(source, artifact_root)
            loads.append(
                {
                    "stage": path.parent.name,
                    "source_path": source,
                    "resolved_path": str(resolved) if resolved is not None else None,
                    "exists": resolved is not None,
                }
            )
    reasons: list[str] = []
    if not saves:
        reasons.append("checkpoint_save_missing")
    if not loads:
        reasons.append("checkpoint_load_missing")
    if saves and not all(item["exists"] for item in saves):
        reasons.append("checkpoint_payload_missing")
    if len(loads) < expected_drive_count:
        reasons.append("checkpoint_load_count_below_expected")
    return (
        {
            "save_stages": saves,
            "load_stages": loads,
            "save_count": len(saves),
            "load_count": len(loads),
            "restart_contract_observed": not reasons,
        },
        reasons,
    )


def _available_quantities(stage: Path, hall_written: bool) -> list[str]:
    quantities = []
    for quantity, relative in QUANTITY_PATHS.items():
        candidates = (relative,) if isinstance(relative, str) else relative
        if any((stage / candidate).exists() for candidate in candidates):
            quantities.append(quantity)
    if hall_written:
        quantities.extend(("topological_charge", "skyrmion_center", "skyrmion_hall_angle"))
    return quantities


def _stage_transport_telemetry(provenance: Any) -> Mapping[str, Any] | None:
    if not isinstance(provenance, Mapping):
        return None
    telemetry = provenance.get("fdm_gpu_transport_telemetry")
    return telemetry if isinstance(telemetry, Mapping) else None


def _stage_record(stage: Path, session_root: Path, output_root: Path) -> tuple[dict[str, Any], list[str]]:
    metadata = _json(stage / "metadata.json", "stage_metadata")
    stage_id = _stage_id(metadata)
    parsed = _drive_id_to_current(stage_id)
    if parsed is None:
        raise EvidenceCollectionError("stage_is_not_solved_current_drive")
    drive_id, requested_current = parsed
    reasons: list[str] = []
    hall_record: dict[str, Any] = {"artifact": None, "reason_code": "hall_artifact_not_created"}
    hall_written = False
    try:
        hall = build_hall_artifact(stage)
        hall_path = output_root / "hall" / f"{drive_id}.json"
        _write_json(hall_path, hall)
        hall_record = {
            "artifact": _relative(hall_path, output_root),
            "artifact_sha256": _sha256(hall_path),
            "reason_code": hall["hall_angle"].get("reason_code"),
            "angle_rad": hall["hall_angle"].get("angle_rad"),
            "mean_signed_current_a_per_m2": hall["hall_angle"].get("mean_signed_current_a_per_m2"),
            "sample_count": len(hall["trajectory"]["time_s"]),
        }
        hall_written = True
        if hall_record["reason_code"] is not None:
            reasons.append(f"{drive_id}_hall_{hall_record['reason_code']}")
    except HallBuildError as error:
        hall_record["reason_code"] = f"rejected:{error}"
        reasons.append(f"{drive_id}_hall_artifact_rejected")

    requested = metadata.get("requested_execution")
    provenance = metadata.get("execution_provenance")
    transport_telemetry = _stage_transport_telemetry(provenance)
    runtime_ok = (
        isinstance(requested, Mapping)
        and requested.get("backend") == "fdm"
        and requested.get("device") == "gpu"
        and requested.get("precision") == "double"
        and requested.get("mode") == "strict"
        and isinstance(provenance, Mapping)
        and provenance.get("execution_engine") == "cuda_fdm"
        and provenance.get("precision") == "double"
        and provenance.get("lossy_fallback_used") is False
    )
    if not runtime_ok:
        reasons.append(f"{drive_id}_runtime_tuple_invalid")
    quantities = _available_quantities(stage, hall_written)
    missing_quantities = sorted(
        {"m", "J_c", "mu_s", "Q_spin", "T_tr_G"} - set(quantities)
    )
    if missing_quantities:
        reasons.append(f"{drive_id}_quantities_missing")
    if transport_telemetry is None:
        reasons.append(f"{drive_id}_transport_telemetry_missing")
    record = {
        "stage_id": stage_id,
        "drive_id": drive_id,
        "requested_current_Apm2": requested_current,
        "stage_dir": _relative(stage, session_root),
        "status": metadata.get("status"),
        "accepted_solver_steps": metadata.get("accepted_solver_steps"),
        "runtime_tuple_valid": runtime_ok,
        "hall_angle": hall_record,
        "output_quantities": quantities,
        "missing_output_quantities": missing_quantities,
        "transport_telemetry": dict(transport_telemetry) if transport_telemetry is not None else None,
    }
    if record["status"] != "completed":
        reasons.append(f"{drive_id}_stage_not_completed")
    return record, reasons


def collect_runtime_evidence(
    session_root: str | Path,
    output_root: str | Path,
    *,
    artifact_root: str | Path | None = None,
) -> dict[str, Any]:
    session = Path(session_root)
    output = Path(output_root)
    stages_root = session / "stages"
    if not stages_root.is_dir():
        raise EvidenceCollectionError("stages_root_missing")
    output.mkdir(parents=True, exist_ok=True)
    discovered: dict[str, tuple[dict[str, Any], Path]] = {}
    reasons: list[str] = []
    candidates = [item for item in stages_root.glob("stage_*") if item.is_dir()]
    # The headless runner may finalize the last flat-run directly in its
    # requested artifact root while live history contains only earlier stages.
    # Treat that root as one candidate, but only when it has a real metadata
    # record; an arbitrary session directory must not be inferred as a drive.
    if (session / "metadata.json").is_file():
        candidates.append(session)
    if artifact_root is not None:
        final_root = Path(artifact_root)
        if (final_root / "metadata.json").is_file():
            candidates.append(final_root)
    for stage in sorted(candidates):
        metadata_path = stage / "metadata.json"
        if not metadata_path.is_file():
            continue
        try:
            stage_id = _stage_id(_json(metadata_path, "stage_metadata"))
        except EvidenceCollectionError:
            continue
        parsed = _drive_id_to_current(stage_id)
        if parsed is None:
            continue
        drive_id = parsed[0]
        if drive_id in discovered:
            reasons.append(f"duplicate_drive_{drive_id}")
            continue
        discovered[drive_id] = ({}, stage)

    drives: list[dict[str, Any]] = []
    expected_drive_ids = {_drive_id(current) for current in EXPECTED_DRIVES}
    for current in EXPECTED_DRIVES:
        drive_id = _drive_id(current)
        entry = discovered.get(drive_id)
        if entry is None:
            reasons.append(
                f"missing_drive_{drive_id.removeprefix('drive_solved_current_')}"
            )
            drives.append(
                {
                    "drive_id": drive_id,
                    "requested_current_Apm2": current,
                    "status": "missing",
                    "hall_angle": {"artifact": None, "reason_code": "drive_missing"},
                    "output_quantities": [],
                    "missing_output_quantities": sorted(QUANTITY_PATHS),
                }
            )
            continue
        try:
            record, stage_reasons = _stage_record(entry[1], session, output)
        except EvidenceCollectionError as error:
            reasons.append(f"{drive_id}_{error}")
            drives.append(
                {
                    "drive_id": drive_id,
                    "requested_current_Apm2": current,
                    "status": "rejected",
                    "hall_angle": {"artifact": None, "reason_code": str(error)},
                    "output_quantities": [],
                    "missing_output_quantities": sorted(QUANTITY_PATHS),
                }
            )
            continue
        drives.append(record)
        reasons.extend(stage_reasons)

    diagnostic_drives: list[dict[str, Any]] = []
    for drive_id, (_, stage) in sorted(discovered.items()):
        if drive_id in expected_drive_ids:
            continue
        try:
            record, stage_reasons = _stage_record(stage, session, output)
        except EvidenceCollectionError as error:
            reasons.append(f"{drive_id}_{error}")
            diagnostic_drives.append(
                {
                    "drive_id": drive_id,
                    "status": "rejected",
                    "hall_angle": {"artifact": None, "reason_code": str(error)},
                    "output_quantities": [],
                    "missing_output_quantities": sorted(QUANTITY_PATHS),
                }
            )
            continue
        diagnostic_drives.append(record)
        reasons.append(
            f"unexpected_drive_{drive_id.removeprefix('drive_solved_current_')}"
        )
        reasons.extend(stage_reasons)

    checkpoint, checkpoint_reasons = _checkpoint_evidence(
        session, len(EXPECTED_DRIVES), Path(artifact_root) if artifact_root is not None else None
    )
    reasons.extend(checkpoint_reasons)
    telemetry_entries = [drive.get("transport_telemetry") for drive in drives]
    telemetry_reasons: list[str] = []
    telemetry_summary: dict[str, Any] | None = None
    if not all(isinstance(entry, Mapping) for entry in telemetry_entries):
        telemetry_reasons.append("transport_telemetry_missing")
    else:
        typed_entries = [entry for entry in telemetry_entries if isinstance(entry, Mapping)]
        integer_fields = (
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
        )
        invalid_entry = False
        for entry in typed_entries:
            if entry.get("schema_version") != "fdm_gpu_transport_telemetry_summary.v1":
                invalid_entry = True
            if entry.get("status") != "pass" or entry.get("all_stage_records_present") is not True:
                invalid_entry = True
            if any(not isinstance(entry.get(field), int) or entry[field] < 0 for field in integer_fields):
                invalid_entry = True
        torque_values = {entry.get("torque_provenance") for entry in typed_entries}
        if torque_values != {"solved_transport"}:
            telemetry_reasons.append("torque_provenance_invalid")
            invalid_entry = True
        if invalid_entry:
            telemetry_reasons.append("transport_telemetry_entry_invalid")
        else:
            telemetry_summary = {
                "schema_version": "fdm_gpu_transport_telemetry_summary.v1",
                "status": "pass",
                "stage_count": sum(entry["stage_count"] for entry in typed_entries),
                "record_count": sum(entry["record_count"] for entry in typed_entries),
                "hot_loop_host_device_transfers": sum(entry["hot_loop_host_device_transfers"] for entry in typed_entries),
                "hot_loop_device_to_device_transfers": sum(entry["hot_loop_device_to_device_transfers"] for entry in typed_entries),
                "hot_loop_host_sync_count": sum(entry["hot_loop_host_sync_count"] for entry in typed_entries),
                "forbidden_transfer_bytes": sum(entry["forbidden_transfer_bytes"] for entry in typed_entries),
                "allowed_control_h2d_records": sum(entry["allowed_control_h2d_records"] for entry in typed_entries),
                "allowed_control_h2d_bytes": sum(entry["allowed_control_h2d_bytes"] for entry in typed_entries),
                "allowed_scalar_d2h_records": sum(entry["allowed_scalar_d2h_records"] for entry in typed_entries),
                "allowed_scalar_d2h_bytes": sum(entry["allowed_scalar_d2h_bytes"] for entry in typed_entries),
                "torque_provenance": "solved_transport",
                "all_stage_records_present": True,
            }
            if telemetry_summary["stage_count"] != len(EXPECTED_DRIVES):
                telemetry_reasons.append("transport_telemetry_stage_count_invalid")
            if telemetry_summary["record_count"] <= 0:
                telemetry_reasons.append("transport_telemetry_record_count_invalid")
            if telemetry_summary["hot_loop_host_device_transfers"] != 0:
                telemetry_reasons.append("hot_loop_host_device_transfers_nonzero")
            if telemetry_summary["forbidden_transfer_bytes"] != 0:
                telemetry_reasons.append("hot_loop_forbidden_transfer_bytes_nonzero")
            if telemetry_reasons:
                telemetry_summary["status"] = "blocked"
    reasons.extend(telemetry_reasons)
    status = "pass" if not reasons else "blocked"
    first_runtime = next((item for item in drives if item.get("runtime_tuple_valid")), None)
    execution_tuple = None
    if first_runtime is not None:
        execution_tuple = {"backend": "fdm", "device": "gpu", "precision": "double", "execution_mode": "strict"}
    evidence = {
        "schema_version": SCHEMA_VERSION,
        "status": status,
        "qualification_manifest_status": "not_created_by_collector",
        "workload_id": "racetrack_m1_v1",
        "execution_tuple": execution_tuple,
        "session_root": str(session),
        "expected_drive_currents_Apm2": list(EXPECTED_DRIVES),
        "drives": drives,
        "diagnostic_drives": diagnostic_drives,
        "checkpoint_restart": checkpoint,
        "transport_telemetry": telemetry_summary,
        "reason_codes": sorted(set(reasons)),
        "producer": {
            "name": "collect_fdm_gpu_racetrack_evidence.py",
            "hall_producer": "build_skyrmion_hall_artifact.py",
            "fail_closed": True,
        },
    }
    _write_json(output / "fdm_gpu_solved_current_racetrack_runtime_evidence.v1.json", evidence)
    return evidence


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session-root", type=Path, required=True)
    parser.add_argument("--artifact-root", type=Path)
    parser.add_argument("--output-root", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        evidence = collect_runtime_evidence(args.session_root, args.output_root, artifact_root=args.artifact_root)
    except (EvidenceCollectionError, OSError) as error:
        print(f"racetrack runtime evidence rejected: {error}")
        return 1
    print(json.dumps(evidence, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
