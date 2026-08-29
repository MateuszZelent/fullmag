#!/usr/bin/env python3
"""Fail-closed aggregator for Frozen Spins production qualification receipts."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Iterable

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from validate_frozen_spins_v1_scope import load_scope, validate_scope_document


ROOT = Path(__file__).resolve().parents[1]
RECEIPT_SCHEMA = "fullmag.frozen_spins_qualification.v1"
SOURCE_IDENTITY_SCHEMA = "fullmag.frozen_spins.source-identity.v1"
PLACEHOLDER_VALUES = {"", "unknown", "n/a", "cuda_runtime", "0000:00:00.0"}


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def receipt_payload_sha256(receipt: dict[str, Any]) -> str:
    payload = dict(receipt)
    payload.pop("receipt_sha256", None)
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return sha256_bytes(encoded)


def required_test_case_ids(scope: dict[str, Any]) -> set[str]:
    return {
        test_id
        for feature in scope["features"]
        for test_id in feature["required_test_case_ids"]
    }


def _required_string(document: dict[str, Any], key: str, prefix: str, errors: list[str]) -> str | None:
    value = document.get(key)
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{prefix}.{key} must be a non-empty string")
        return None
    return value


def _required_object(document: dict[str, Any], key: str, prefix: str, errors: list[str]) -> dict[str, Any]:
    value = document.get(key)
    if not isinstance(value, dict):
        errors.append(f"{prefix}.{key} must be an object")
        return {}
    return value


def validate_receipt(receipt: Any, receipt_path: Path) -> list[str]:
    errors: list[str] = []
    prefix = receipt_path.name
    if not isinstance(receipt, dict):
        return [f"{prefix}: receipt must be a JSON object"]
    if receipt.get("schema") != RECEIPT_SCHEMA:
        errors.append(f"{prefix}.schema must equal {RECEIPT_SCHEMA!r}")
    if receipt.get("status") != "PASS":
        errors.append(f"{prefix}.status must equal 'PASS'")
    for key in ("timestamp_utc", "evidence_id", "source_snapshot_id", "command", "binary_sha256", "toolchain"):
        _required_string(receipt, key, prefix, errors)
    evidence_id = receipt.get("evidence_id")
    if isinstance(evidence_id, str) and not evidence_id.startswith("FS-EV-"):
        errors.append(f"{prefix}.evidence_id must start with 'FS-EV-'")

    source = _required_object(receipt, "source", prefix, errors)
    for key in (
        "git_sha",
        "tree_sha",
        "tracked_diff_sha256",
        "staged_diff_sha256",
        "untracked_manifest_sha256",
    ):
        _required_string(source, key, f"{prefix}.source", errors)
    if source.get("git_dirty") is not False:
        errors.append(f"{prefix}.source.git_dirty must be false for release qualification")
    if not isinstance(source.get("submodule_identities"), dict):
        errors.append(f"{prefix}.source.submodule_identities must be an object")

    runtime = _required_object(receipt, "runtime", prefix, errors)
    for key in ("recipe", "image_digest", "build_manifest"):
        value = _required_string(runtime, key, f"{prefix}.runtime", errors)
        if isinstance(value, str) and value.strip().lower() in PLACEHOLDER_VALUES:
            errors.append(f"{prefix}.runtime.{key} cannot use a placeholder value")

    execution = _required_object(receipt, "execution_evidence", prefix, errors)
    for key in ("cwd", "started_at_utc", "finished_at_utc", "stdout_sha256", "stderr_sha256"):
        _required_string(execution, key, f"{prefix}.execution_evidence", errors)
    if execution.get("exit_code") != 0:
        errors.append(f"{prefix}.execution_evidence.exit_code must equal 0")
    if not isinstance(execution.get("environment"), dict):
        errors.append(f"{prefix}.execution_evidence.environment must be an object")

    hardware = _required_object(receipt, "hardware", prefix, errors)
    for key in ("device_name", "driver"):
        value = _required_string(hardware, key, f"{prefix}.hardware", errors)
        if isinstance(value, str) and value.strip().lower() in PLACEHOLDER_VALUES:
            errors.append(f"{prefix}.hardware.{key} cannot use a placeholder value")
    if str(hardware.get("device_type", "")).lower() == "gpu":
        pci_bus_id = _required_string(hardware, "pci_bus_id", f"{prefix}.hardware", errors)
        if isinstance(pci_bus_id, str) and pci_bus_id.strip().lower() in PLACEHOLDER_VALUES:
            errors.append(f"{prefix}.hardware.pci_bus_id cannot use a placeholder value")

    qualification_tuple = _required_object(receipt, "qualification_tuple", prefix, errors)
    for key in (
        "backend",
        "execution",
        "precision",
        "mesh_mode",
        "algorithm",
        "active_physics",
        "membership_policy",
        "reference_policy",
    ):
        if key == "active_physics":
            value = qualification_tuple.get(key)
            if not isinstance(value, list):
                errors.append(f"{prefix}.qualification_tuple.{key} must be an array")
        else:
            _required_string(qualification_tuple, key, f"{prefix}.qualification_tuple", errors)

    contract = _required_object(receipt, "contract", prefix, errors)
    for key in ("membership_policy", "reference_policy"):
        _required_string(contract, key, f"{prefix}.contract", errors)
    if not isinstance(contract.get("constraint_activation_epochs"), dict):
        errors.append(f"{prefix}.contract.constraint_activation_epochs must be an object")
    revision = contract.get("resolved_constraint_set_revision")
    if not isinstance(revision, int) or revision < 1:
        errors.append(f"{prefix}.contract.resolved_constraint_set_revision must be a positive integer")
    if contract.get("fallback_used") is not False:
        errors.append(f"{prefix}.contract.fallback_used must be false")

    results = _required_object(receipt, "results", prefix, errors)
    if results.get("frozen_max_ulp_drift") != 0:
        errors.append(f"{prefix}.results.frozen_max_ulp_drift must equal 0")
    if results.get("frozen_max_abs_drift") != 0.0:
        errors.append(f"{prefix}.results.frozen_max_abs_drift must equal 0.0")
    if results.get("fallback_count") != 0:
        errors.append(f"{prefix}.results.fallback_count must equal 0")
    if results.get("oracle_result") != "PASS":
        errors.append(f"{prefix}.results.oracle_result must equal 'PASS'")
    if results.get("energy_finite") is not True:
        errors.append(f"{prefix}.results.energy_finite must be true")
    test_ids = results.get("test_case_ids")
    if not isinstance(test_ids, list) or not test_ids or any(not isinstance(item, str) for item in test_ids):
        errors.append(f"{prefix}.results.test_case_ids must be a non-empty string array")

    artifacts = receipt.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        errors.append(f"{prefix}.artifacts must be a non-empty array")
    else:
        for index, artifact in enumerate(artifacts):
            artifact_prefix = f"{prefix}.artifacts[{index}]"
            if not isinstance(artifact, dict):
                errors.append(f"{artifact_prefix} must be an object")
                continue
            artifact_name = _required_string(artifact, "path", artifact_prefix, errors)
            expected_sha = _required_string(artifact, "sha256", artifact_prefix, errors)
            if artifact_name and expected_sha:
                artifact_path = Path(artifact_name)
                if not artifact_path.is_absolute():
                    artifact_path = receipt_path.parent / artifact_path
                if not artifact_path.is_file():
                    errors.append(f"{artifact_prefix}.path does not exist: {artifact_path}")
                elif sha256_bytes(artifact_path.read_bytes()) != expected_sha:
                    errors.append(f"{artifact_prefix}.sha256 does not match artifact content")

    expected_receipt_sha = receipt.get("receipt_sha256")
    if not isinstance(expected_receipt_sha, str) or expected_receipt_sha != receipt_payload_sha256(receipt):
        errors.append(f"{prefix}.receipt_sha256 does not match canonical receipt payload")
    return errors


def aggregate(
    scope: dict[str, Any],
    receipts: Iterable[tuple[Path, Any]],
    expected_source_identity: dict[str, Any] | None = None,
) -> tuple[list[str], set[str]]:
    errors = validate_scope_document(scope)
    if expected_source_identity is not None:
        if expected_source_identity.get("schema") != SOURCE_IDENTITY_SCHEMA:
            errors.append(f"source identity schema must equal {SOURCE_IDENTITY_SCHEMA!r}")
        expected_source = expected_source_identity.get("source")
        if not isinstance(expected_source, dict):
            errors.append("source identity source must be an object")
        elif expected_source.get("git_dirty") is not False:
            errors.append("source identity must describe a clean qualification tree")
        if not isinstance(expected_source_identity.get("source_snapshot_id"), str):
            errors.append("source identity source_snapshot_id must be a string")
    covered: set[str] = set()
    evidence_ids: set[str] = set()
    source_snapshot_ids: set[str] = set()
    tree_shas: set[str] = set()
    count = 0
    for path, receipt in receipts:
        count += 1
        receipt_errors = validate_receipt(receipt, path)
        errors.extend(receipt_errors)
        if receipt_errors or not isinstance(receipt, dict):
            continue
        if expected_source_identity is not None:
            if receipt["source_snapshot_id"] != expected_source_identity.get("source_snapshot_id"):
                errors.append(f"{path.name} does not match qualification source_snapshot_id")
            if receipt["source"] != expected_source_identity.get("source"):
                errors.append(f"{path.name} source object does not match qualification source identity")
        evidence_id = receipt["evidence_id"]
        if evidence_id in evidence_ids:
            errors.append(f"duplicate evidence_id: {evidence_id}")
        evidence_ids.add(evidence_id)
        source_snapshot_ids.add(receipt["source_snapshot_id"])
        tree_shas.add(receipt["source"]["tree_sha"])
        covered.update(receipt["results"]["test_case_ids"])
    if count == 0:
        errors.append("no qualification receipts found")
    if len(source_snapshot_ids) > 1:
        errors.append("qualification receipts use different source_snapshot_id values")
    if len(tree_shas) > 1:
        errors.append("qualification receipts use different source.tree_sha values")
    missing = required_test_case_ids(scope) - covered
    if missing:
        errors.append("missing required test case receipts: " + ", ".join(sorted(missing)))
    return errors, covered


def load_receipts(receipt_dir: Path) -> tuple[list[str], list[tuple[Path, Any]]]:
    errors: list[str] = []
    receipts: list[tuple[Path, Any]] = []
    if not receipt_dir.is_dir():
        return [f"receipt directory does not exist: {receipt_dir}"], receipts
    for path in sorted(receipt_dir.glob("*.json")):
        try:
            receipts.append((path, json.loads(path.read_text(encoding="utf-8"))))
        except (OSError, json.JSONDecodeError) as error:
            errors.append(f"unable to read receipt {path}: {error}")
    return errors, receipts


def append_evidence_ledger(
    ledger_path: Path, receipts: Iterable[tuple[Path, Any]]
) -> list[str]:
    errors: list[str] = []
    existing: dict[str, dict[str, Any]] = {}
    if ledger_path.exists():
        try:
            for line_number, line in enumerate(
                ledger_path.read_text(encoding="utf-8").splitlines(), start=1
            ):
                if not line.strip():
                    continue
                entry = json.loads(line)
                evidence_id = entry.get("evidence_id")
                if not isinstance(evidence_id, str):
                    errors.append(f"evidence ledger line {line_number} has no evidence_id")
                    continue
                if evidence_id in existing:
                    errors.append(f"evidence ledger duplicates evidence_id: {evidence_id}")
                existing[evidence_id] = entry
        except (OSError, json.JSONDecodeError) as error:
            return [f"unable to read evidence ledger: {error}"]

    additions: list[dict[str, Any]] = []
    for receipt_path, receipt in receipts:
        evidence_id = receipt["evidence_id"]
        entry = {
            "schema": "fullmag.frozen_spins.evidence-ledger.v1",
            "evidence_id": evidence_id,
            "source_snapshot_id": receipt["source_snapshot_id"],
            "receipt_path": str(receipt_path),
            "receipt_sha256": receipt["receipt_sha256"],
            "command": receipt["command"],
            "execution_evidence": receipt["execution_evidence"],
            "binary_sha256": receipt["binary_sha256"],
            "artifacts": receipt["artifacts"],
        }
        previous = existing.get(evidence_id)
        if previous is not None and previous != entry:
            errors.append(f"evidence ledger entry is immutable: {evidence_id}")
        elif previous is None:
            additions.append(entry)
    if errors or not additions:
        return errors
    try:
        ledger_path.parent.mkdir(parents=True, exist_ok=True)
        with ledger_path.open("a", encoding="utf-8", newline="\n") as stream:
            for entry in additions:
                stream.write(json.dumps(entry, sort_keys=True, separators=(",", ":")) + "\n")
    except OSError as error:
        errors.append(f"unable to append evidence ledger: {error}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--scope",
        type=Path,
        default=ROOT / "docs" / "validation" / "frozen-spins-v1-scope.yaml",
    )
    parser.add_argument(
        "--receipt-dir",
        type=Path,
        default=ROOT / "artifacts" / "qualification" / "frozen-spins" / "receipts",
    )
    parser.add_argument(
        "--source-identity",
        type=Path,
        default=ROOT / "artifacts" / "qualification" / "frozen-spins" / "source-baseline.json",
    )
    parser.add_argument(
        "--evidence-ledger",
        type=Path,
        default=ROOT / "artifacts" / "qualification" / "frozen-spins" / "evidence-ledger.jsonl",
    )
    args = parser.parse_args()
    try:
        scope = load_scope(args.scope)
    except (OSError, json.JSONDecodeError) as error:
        print(f"FAIL: unable to load scope ledger: {error}")
        return 1
    try:
        source_identity = json.loads(args.source_identity.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(f"FAIL: unable to load qualification source identity: {error}")
        return 1
    load_errors, receipts = load_receipts(args.receipt_dir)
    errors, covered = aggregate(scope, receipts, source_identity)
    errors = [*load_errors, *errors]
    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        print(
            "INCOMPLETE: Frozen Spins production qualification did not pass "
            f"({len(covered)}/{len(required_test_case_ids(scope))} required test cases covered)"
        )
        return 1
    ledger_errors = append_evidence_ledger(args.evidence_ledger, receipts)
    if ledger_errors:
        for error in ledger_errors:
            print(f"FAIL: {error}")
        return 1
    print(
        "PASS: Frozen Spins production qualification receipts are complete "
        f"({len(covered)} required test cases covered)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
