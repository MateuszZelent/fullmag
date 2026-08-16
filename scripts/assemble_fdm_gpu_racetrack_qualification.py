#!/usr/bin/env python3
"""Atomically assemble the twelve-gate solved-current qualification manifest.

Only independently produced, identity-matched gate artifacts can become the
public qualification manifest.  Incomplete evidence is written as a blocked
summary and never as a pass manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import tempfile
from typing import Any, Mapping, Sequence

try:
    from scripts.verify_fdm_gpu_racetrack_qualification import (
        EXPECTED_TUPLE,
        MANIFEST_NAME,
        REQUIRED_GATES,
        SCHEMA_VERSION as QUALIFICATION_SCHEMA,
        GATE_EVIDENCE_SCHEMA,
        QualificationError,
        identity,
        runtime_identity,
        validate_gate_claims,
        validate_gate_proof,
    )
except ModuleNotFoundError:
    from verify_fdm_gpu_racetrack_qualification import (
        EXPECTED_TUPLE,
        MANIFEST_NAME,
        REQUIRED_GATES,
        SCHEMA_VERSION as QUALIFICATION_SCHEMA,
        GATE_EVIDENCE_SCHEMA,
        QualificationError,
        identity,
        runtime_identity,
        validate_gate_claims,
        validate_gate_proof,
    )


SUMMARY_NAME = "fdm_gpu_solved_current_racetrack_qualification_summary.v1.json"
SUMMARY_SCHEMA = "fdm_gpu_solved_current_racetrack_qualification_summary.v1"
EXECUTION_AUDIT_SCHEMA = "fdm_gpu_racetrack_execution_audit.v1"


class AssemblyError(RuntimeError):
    """The evidence set cannot be promoted to the qualification manifest."""


def _validate_execution_audit(
    audit: Mapping[str, Any],
    runtime: Mapping[str, Any],
) -> list[str]:
    reasons: list[str] = []
    if audit.get("schema_version") != EXECUTION_AUDIT_SCHEMA:
        reasons.append("execution_audit_schema_invalid")
    if audit.get("status") != "pass":
        reasons.append("execution_audit_not_pass")
    if audit.get("runtime_identity") != dict(runtime):
        reasons.append("execution_audit_runtime_identity_mismatch")
    if audit.get("reason_codes") != []:
        reasons.append("execution_audit_reason_codes_nonempty")
    if audit.get("fallbacks") != []:
        reasons.append("execution_audit_fallback_forbidden")
    if audit.get("hot_loop_host_device_transfers") != 0:
        reasons.append("execution_audit_hot_loop_transfer_forbidden")
    if audit.get("forbidden_transfer_bytes") != 0:
        reasons.append("execution_audit_forbidden_transfer_bytes")
    if audit.get("torque_provenance") != "solved_transport":
        reasons.append("execution_audit_torque_provenance_invalid")
    telemetry = audit.get("transport_telemetry")
    if (
        not isinstance(telemetry, Mapping)
        or telemetry.get("schema_version") != "fdm_gpu_transport_telemetry_summary.v1"
        or telemetry.get("status") != "pass"
        or telemetry.get("hot_loop_host_device_transfers") != 0
        or telemetry.get("forbidden_transfer_bytes") != 0
        or telemetry.get("torque_provenance") != "solved_transport"
    ):
        reasons.append("execution_audit_transport_telemetry_invalid")
    elif any(
        not isinstance(telemetry.get(field), int) or telemetry[field] < 0
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
        )
    ):
        reasons.append("execution_audit_transport_telemetry_fields_invalid")
    elif telemetry.get("stage_count") != 6 or telemetry.get("record_count", 0) <= 0 or telemetry.get("all_stage_records_present") is not True:
        reasons.append("execution_audit_transport_telemetry_incomplete")
    return reasons


def _json(path: Path, label: str) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise AssemblyError(f"{label}_unreadable") from error
    if not isinstance(value, Mapping):
        raise AssemblyError(f"{label}_invalid")
    return value


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
    except OSError as error:
        raise AssemblyError(f"input_unreadable:{path}") from error
    return digest.hexdigest()


def input_digest(paths: Sequence[Path]) -> str:
    digest = hashlib.sha256()
    for path in paths:
        digest.update(path.as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(bytes.fromhex(sha256_file(path)))
    return digest.hexdigest()


def _write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with open(descriptor, "wb", closefd=True) as stream:
            stream.write((json.dumps(value, indent=2, sort_keys=True) + "\n").encode())
            stream.flush()
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _source_identity(
    source_snapshot_path: Path,
    input_paths: Sequence[Path],
    fixture_path: Path,
    qualification_input: str | None = None,
) -> dict[str, str]:
    snapshot = _json(source_snapshot_path, "source_snapshot")
    commit = snapshot.get("head_commit_full")
    source_snapshot_sha256 = snapshot.get("source_snapshot_sha256")
    if not isinstance(commit, str) or not isinstance(source_snapshot_sha256, str):
        raise AssemblyError("source_snapshot_identity_invalid")
    result = {
        "commit": commit,
        "source_snapshot_sha256": source_snapshot_sha256,
        "input_sha256": input_digest(input_paths),
        "fixture_sha256": sha256_file(fixture_path),
    }
    if qualification_input is not None:
        entries = snapshot.get("qualification_inputs")
        if not isinstance(entries, list):
            raise AssemblyError("source_snapshot_qualification_input_missing")
        matching = [
            entry
            for entry in entries
            if isinstance(entry, Mapping) and entry.get("path") == qualification_input
        ]
        if len(matching) != 1 or matching[0].get("sha256") != result["fixture_sha256"]:
            raise AssemblyError("source_snapshot_qualification_input_mismatch")
    try:
        identity(result, "source_identity")
    except QualificationError as error:
        raise AssemblyError(str(error)) from error
    return result


def _gate_artifacts(
    evidence_root: Path,
    source: Mapping[str, Any],
    runtime: Mapping[str, Any],
) -> tuple[dict[str, dict[str, str]], list[str]]:
    gate_dir = evidence_root / "gates"
    gates: dict[str, dict[str, str]] = {}
    reasons: list[str] = []
    for gate_id in REQUIRED_GATES:
        path = gate_dir / f"{gate_id}.json"
        if not path.is_file():
            reasons.append(f"missing_gate_{gate_id}")
            continue
        try:
            evidence = _json(path, gate_id)
            if evidence.get("schema_version") != GATE_EVIDENCE_SCHEMA:
                raise AssemblyError(f"{gate_id}_schema_invalid")
            if evidence.get("status") != "pass":
                blocked_reasons = evidence.get("reason_codes")
                if isinstance(blocked_reasons, list) and all(
                    isinstance(reason, str) and reason for reason in blocked_reasons
                ):
                    raise AssemblyError(
                        ";".join(f"{gate_id}_{reason}" for reason in blocked_reasons)
                    )
                raise AssemblyError(f"{gate_id}_not_pass")
            observed_source = identity(evidence.get("source_identity"), f"{gate_id}_source_identity")
            observed_runtime = runtime_identity(evidence.get("runtime_identity"), f"{gate_id}_runtime_identity")
            if dict(observed_source) != dict(source):
                raise AssemblyError(f"{gate_id}_source_identity_mismatch")
            if dict(observed_runtime) != dict(runtime):
                raise AssemblyError(f"{gate_id}_runtime_identity_mismatch")
            claims = evidence.get("claims")
            if not isinstance(claims, dict):
                raise AssemblyError(f"{gate_id}_claims_invalid")
            validate_gate_claims(gate_id, claims)
            validate_gate_proof(evidence_root, gate_id, dict(evidence), dict(source), dict(runtime))
        except (AssemblyError, QualificationError) as error:
            reasons.append(str(error))
            continue
        gates[gate_id] = {
            "status": "pass",
            "artifact": path.resolve().relative_to(evidence_root.resolve()).as_posix(),
        }
    return gates, reasons


def assemble(
    evidence_root: str | Path,
    *,
    source_snapshot_path: str | Path,
    runtime_identity_path: str | Path,
    input_paths: Sequence[str | Path],
    fixture_path: str | Path,
    qualification_input: str | None = None,
    input_hashes_path: str | Path | None = None,
    execution_audit_path: str | Path | None = None,
) -> dict[str, Any]:
    root = Path(evidence_root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    reasons: list[str] = []
    try:
        source = _source_identity(
            Path(source_snapshot_path),
            tuple(Path(item) for item in input_paths),
            Path(fixture_path),
            qualification_input,
        )
        runtime_raw = _json(Path(runtime_identity_path), "runtime_identity")
        runtime = runtime_identity(runtime_raw, "runtime_identity")
    except AssemblyError as error:
        reasons.append(str(error))
        source = {}
        runtime = {}

    if source and runtime:
        gates, gate_reasons = _gate_artifacts(root, source, runtime)
        reasons.extend(gate_reasons)
    else:
        gates = {}

    if input_hashes_path is None:
        computed_input_hash = input_digest(tuple(Path(item) for item in input_paths))
        input_hashes = {"before": computed_input_hash, "after": computed_input_hash}
    else:
        try:
            input_hashes_raw = _json(Path(input_hashes_path), "input_hashes")
            input_hashes = {"before": input_hashes_raw.get("before"), "after": input_hashes_raw.get("after")}
        except AssemblyError as error:
            input_hashes = {"before": None, "after": None}
            reasons.append(str(error))
    audit: Mapping[str, Any] | None = None
    if execution_audit_path is None:
        reasons.append("execution_audit_missing")
    else:
        try:
            audit = _json(Path(execution_audit_path), "execution_audit")
        except AssemblyError as error:
            reasons.append(str(error))

    if set(gates) != set(REQUIRED_GATES):
        reasons.append("gate_set_incomplete")
    if input_hashes.get("before") != input_hashes.get("after"):
        reasons.append("input_hash_drift")
    if audit is not None:
        reasons.extend(_validate_execution_audit(audit, runtime))

    unique_reasons = sorted(set(reasons))
    if unique_reasons:
        summary = {
            "schema_version": SUMMARY_SCHEMA,
            "status": "blocked",
            "workload_id": "racetrack_m1_v1",
            "execution_tuple": EXPECTED_TUPLE,
            "source_identity": source or None,
            "runtime_identity": runtime or None,
            "gates_collected": sorted(gates),
            "required_gates": list(REQUIRED_GATES),
            "reason_codes": unique_reasons,
        }
        _write_json(root / SUMMARY_NAME, summary)
        return summary

    assert audit is not None
    manifest = {
        "schema_version": QUALIFICATION_SCHEMA,
        "status": "pass",
        "workload_id": "racetrack_m1_v1",
        "execution_tuple": EXPECTED_TUPLE,
        "source_identity": source,
        "runtime_identity": runtime,
        "input_hashes": input_hashes,
        "execution_audit": dict(audit),
        "gates": gates,
    }
    _write_json(root / MANIFEST_NAME, manifest)
    return manifest


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-root", type=Path, required=True)
    parser.add_argument("--source-snapshot", type=Path, required=True)
    parser.add_argument("--runtime-identity", type=Path, required=True)
    parser.add_argument("--input", type=Path, action="append", required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--qualification-input")
    parser.add_argument("--input-hashes", type=Path)
    parser.add_argument("--execution-audit", type=Path)
    args = parser.parse_args(argv)
    try:
        result = assemble(
            args.evidence_root,
            source_snapshot_path=args.source_snapshot,
            runtime_identity_path=args.runtime_identity,
            input_paths=args.input,
            fixture_path=args.fixture,
            qualification_input=args.qualification_input,
            input_hashes_path=args.input_hashes,
            execution_audit_path=args.execution_audit,
        )
    except AssemblyError as error:
        print(f"racetrack qualification assembly rejected: {error}")
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result.get("status") == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
