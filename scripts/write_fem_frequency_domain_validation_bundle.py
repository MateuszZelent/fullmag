#!/usr/bin/env python3
"""Bind a concrete FEM frequency-domain artifact bundle to a closed scope.

Without an independent evidence manifest the writer emits a blocked production
record. Promotion is possible only when every DOD gate is supplied and the
fail-closed validator accepts the resulting immutable record; artifact
presence or a passing solver run alone never promotes a scope.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from verify_fem_frequency_domain_production_dod import (
    ALL_DOD_IDS,
    BINDING_SCHEMA,
    CATALOG_SCHEMA,
    SCHEMA,
    SIDECAR_SCHEMA,
    canonical_json_bytes,
    scope_id_for,
    _validate_verifier_execution_proof,
    validate_artifact_sidecar,
    validate_production_record,
    validate_scope,
    validate_scope_catalog,
    validate_scope_binding,
)


CATALOG_URI = "validation/scopes/scope_catalog.v1.json"


@dataclass(frozen=True)
class ValidationBundleResult:
    scope_id: str
    catalog_sha256: str
    production_record_path: str


def _sha256_bytes(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def _zarr_tree_digest(path: Path) -> str:
    digest = hashlib.sha256()
    for child in sorted(item for item in path.rglob("*") if item.is_file()):
        relative = child.relative_to(path).as_posix().encode("utf-8")
        payload = child.read_bytes()
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
    return "sha256:" + digest.hexdigest()


def _json_dump(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
        + b"\n"
    )


def _direct_binding(scope_id: str, catalog_sha256: str) -> dict[str, Any]:
    return {
        "schema": BINDING_SCHEMA,
        "scope_schema": SCHEMA,
        "kind": "direct",
        "scope_id": scope_id,
        "scope_catalog_uri": CATALOG_URI,
        "scope_catalog_sha256": catalog_sha256,
    }


def _artifact_kind(path: Path) -> str:
    if path.is_dir() and path.name.endswith(".zarr"):
        return "zarr"
    if path.suffix.lower() == ".csv":
        return "csv"
    if path.suffix.lower() in {".bin", ".dat", ".raw"}:
        return "binary"
    if path.suffix.lower() in {".txt", ".log"}:
        return "text"
    return "other_non_json"


def _iter_external_artifacts(bundle_root: Path) -> Iterable[Path]:
    for path in sorted(bundle_root.rglob("*")):
        if path.is_dir() and path.name.endswith(".zarr"):
            yield path
            continue
        if not path.is_file():
            continue
        if path.name.endswith(".validation_manifest.v1.json"):
            continue
        if path.parts[-2:] == ("scopes", "scope_catalog.v1.json"):
            continue
        if path.name == "frequency_domain_production_dod.v1.json":
            continue
        if path.suffix.lower() == ".json":
            yield path
        elif path.suffix.lower() in {".csv", ".bin", ".dat", ".raw", ".txt", ".log"}:
            yield path


def _bind_json_artifact(
    path: Path,
    binding: dict[str, Any],
    catalog: dict[str, Any],
    catalog_sha256: str,
) -> None:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"JSON evidence must be an object: {path}")
    value["verified_coverage_of"] = binding
    _json_dump(path, value)
    validate_scope_binding(binding, catalog, CATALOG_URI, catalog_sha256)


def _write_sidecar(
    bundle_root: Path,
    path: Path,
    binding: dict[str, Any],
    catalog: dict[str, Any],
    catalog_sha256: str,
    scope_id: str,
) -> None:
    kind = _artifact_kind(path)
    sidecar: dict[str, Any] = {
        "schema": SIDECAR_SCHEMA,
        "artifact_kind": kind,
        "artifact_schema": f"frequency_domain.{kind}.v1",
        "artifact_uri": path.relative_to(bundle_root).as_posix(),
        "verified_coverage_of": binding,
    }
    if kind == "zarr":
        sidecar["zarr_tree_sha256"] = _zarr_tree_digest(path)
    else:
        sidecar["artifact_sha256"] = _sha256_bytes(path.read_bytes())
    sidecar_path = path.with_name(path.name + ".validation_manifest.v1.json")
    _json_dump(sidecar_path, sidecar)
    validate_artifact_sidecar(
        path,
        sidecar_path,
        sidecar,
        catalog,
        CATALOG_URI,
        catalog_sha256,
        path.relative_to(bundle_root).as_posix(),
        scope_id,
    )


def _read_manifest_state(bundle_root: Path) -> tuple[str, str]:
    manifest_path = bundle_root / "frequency_domain" / "manifest.v1.json"
    if not manifest_path.is_file():
        raise ValueError(f"missing frequency-domain manifest: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("frequency-domain manifest must be an object")
    implementation_state = manifest.get("implementation_state", "unvalidated")
    validation_state = manifest.get("validation_state", "unvalidated")
    if not isinstance(implementation_state, str) or not implementation_state:
        raise ValueError("manifest implementation_state must be a non-empty string")
    if not isinstance(validation_state, str) or not validation_state:
        raise ValueError("manifest validation_state must be a non-empty string")
    return implementation_state, validation_state


def _write_blocked_record(
    bundle_root: Path,
    scope: dict[str, Any],
    scope_id: str,
    catalog_sha256: str,
) -> Path:
    implementation_state, validation_state = _read_manifest_state(bundle_root)
    blockers = [
        f"{gate_id}: independent production evidence has not been supplied"
        for gate_id in ALL_DOD_IDS
    ]
    record = {
        "schema": "frequency_domain_production_dod.v1",
        "scope_schema": SCHEMA,
        "scope_id": scope_id,
        "validated_scope": scope,
        "scope_catalog_uri": CATALOG_URI,
        "scope_catalog_sha256": catalog_sha256,
        "implementation_state": implementation_state,
        "validation_state_before_promotion": validation_state,
        "items": {gate_id: "fail" for gate_id in ALL_DOD_IDS},
        "item_evidence": {gate_id: {} for gate_id in ALL_DOD_IDS},
        "not_applicable_reasons": {},
        "open_blockers": blockers,
        "promotion_decision": "blocked",
    }
    path = bundle_root / "validation" / "frequency_domain_production_dod.v1.json"
    _json_dump(path, record)
    return path


def _artifact_evidence_descriptor(bundle_root: Path, raw_path: Any) -> dict[str, Any]:
    if not isinstance(raw_path, str) or not raw_path:
        raise ValueError("production evidence paths must be non-empty strings")
    artifact = (bundle_root / raw_path).resolve()
    try:
        artifact.relative_to(bundle_root.resolve())
    except ValueError as exc:
        raise ValueError(f"production evidence path escapes bundle root: {raw_path}") from exc
    if not artifact.exists():
        raise ValueError(f"production evidence artifact is missing: {raw_path}")
    artifact_uri = artifact.relative_to(bundle_root.resolve()).as_posix()
    descriptor: dict[str, Any] = {
        "path": artifact_uri,
        "sha256": _zarr_tree_digest(artifact) if artifact.is_dir() else _sha256_bytes(artifact.read_bytes()),
        "sidecar_path": None,
        "sidecar_sha256": None,
    }
    if artifact.is_dir() or artifact.suffix.lower() != ".json":
        sidecar = artifact.with_name(artifact.name + ".validation_manifest.v1.json")
        if not sidecar.is_file():
            raise ValueError(f"production evidence sidecar is missing: {sidecar}")
        descriptor["sidecar_path"] = sidecar.relative_to(bundle_root.resolve()).as_posix()
        descriptor["sidecar_sha256"] = _sha256_bytes(sidecar.read_bytes())
    return descriptor


def _write_promotion_record(
    bundle_root: Path,
    scope: dict[str, Any],
    scope_id: str,
    catalog_sha256: str,
    evidence_manifest_path: Path,
) -> Path:
    try:
        manifest = json.loads(evidence_manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"invalid production evidence manifest: {exc}") from exc
    if not isinstance(manifest, dict) or manifest.get("schema") != "frequency_domain_production_evidence_manifest.v1":
        raise ValueError("production evidence manifest has an unsupported schema")
    gates = manifest.get("gates")
    if not isinstance(gates, dict) or set(gates) != set(ALL_DOD_IDS):
        raise ValueError("production evidence manifest must define every DOD-01..DOD-14 gate")
    validation_state = manifest.get("validation_state_before_promotion")
    if validation_state not in {"algebra_validated", "physics_validated", "production_qualified"}:
        raise ValueError("production evidence manifest has an invalid validation state")
    catalog = {
        "schema": CATALOG_SCHEMA,
        "scope_schema": SCHEMA,
        "scopes": {scope_id: scope},
    }
    binding = _direct_binding(scope_id, catalog_sha256)
    items: dict[str, str] = {}
    item_evidence: dict[str, Any] = {}
    not_applicable_reasons: dict[str, str] = {}
    for gate_id in ALL_DOD_IDS:
        raw = gates[gate_id]
        if not isinstance(raw, dict):
            raise ValueError(f"{gate_id} evidence entry must be an object")
        state = raw.get("state", "pass")
        if state == "not_applicable":
            reason = raw.get("reason")
            if not isinstance(reason, str) or not reason:
                raise ValueError(f"{gate_id} not-applicable entry requires a reason")
            items[gate_id] = state
            item_evidence[gate_id] = {}
            not_applicable_reasons[gate_id] = reason
            continue
        if state != "pass":
            raise ValueError(f"{gate_id} evidence state must be pass or not_applicable")
        required = {"state", "evidence", "fixture_ids", "oracle_ids", "metrics", "tolerances", "verifier"}
        if set(raw) != required:
            raise ValueError(f"{gate_id} pass entry must contain exactly {sorted(required)!r}")
        evidence_paths = raw["evidence"]
        if not isinstance(evidence_paths, list) or not evidence_paths:
            raise ValueError(f"{gate_id} evidence must be a non-empty array")
        _validate_verifier_execution_proof(
            raw["verifier"],
            bundle_root=bundle_root,
            catalog=catalog,
            expected_uri=CATALOG_URI,
            expected_catalog_sha256=catalog_sha256,
            scope=scope,
            target_scope_id=scope_id,
            gate_id=gate_id,
        )
        item_evidence[gate_id] = {
            "gate_id": gate_id,
            "verified_coverage_of": binding,
            "evidence": [_artifact_evidence_descriptor(bundle_root, path) for path in evidence_paths],
            "fixture_ids": raw["fixture_ids"],
            "oracle_ids": raw["oracle_ids"],
            "metrics": raw["metrics"],
            "tolerances": raw["tolerances"],
            "verifier": raw["verifier"],
            "implementation_state": "executable",
            "validation_state_before_promotion": validation_state,
            "open_blockers": [],
        }
        items[gate_id] = "pass"
    record = {
        "schema": "frequency_domain_production_dod.v1",
        "scope_schema": SCHEMA,
        "scope_id": scope_id,
        "validated_scope": scope,
        "scope_catalog_uri": CATALOG_URI,
        "scope_catalog_sha256": catalog_sha256,
        "implementation_state": "executable",
        "validation_state_before_promotion": validation_state,
        "items": items,
        "item_evidence": item_evidence,
        "not_applicable_reasons": not_applicable_reasons,
        "open_blockers": [],
        "promotion_decision": "production_qualified",
    }
    path = bundle_root / "validation" / "frequency_domain_production_dod.v1.json"
    _json_dump(path, record)
    return path


def write_validation_bundle(
    bundle_root: Path,
    scope: dict[str, Any],
    *,
    expected_device: str | None = None,
    evidence_manifest: Path | None = None,
) -> ValidationBundleResult:
    """Write catalog, bindings, sidecars, and a blocked DOD record.

    ``scope`` must be the exact, already-decided semantic scope for this
    runtime bundle.  The function validates it and never widens or infers it.
    """

    bundle_root = bundle_root.resolve()
    if not bundle_root.is_dir():
        raise ValueError(f"artifact bundle root is not a directory: {bundle_root}")
    validate_scope(scope)
    if expected_device is not None:
        resolved_device = scope["device_scope"]["resolved"]
        if resolved_device != expected_device:
            raise ValueError(
                "scope device does not match the production lane: "
                f"expected {expected_device!r}, got {resolved_device!r}"
            )
    scope_id = scope_id_for(scope)
    catalog = {
        "schema": CATALOG_SCHEMA,
        "scope_schema": SCHEMA,
        "scopes": {scope_id: scope},
    }
    catalog_sha256 = validate_scope_catalog(catalog)
    catalog_path = bundle_root / CATALOG_URI
    catalog_path.parent.mkdir(parents=True, exist_ok=True)
    catalog_path.write_bytes(canonical_json_bytes(catalog))
    binding = _direct_binding(scope_id, catalog_sha256)

    for path in _iter_external_artifacts(bundle_root):
        if path.suffix.lower() == ".json":
            _bind_json_artifact(path, binding, catalog, catalog_sha256)
        else:
            _write_sidecar(
                bundle_root,
                path,
                binding,
                catalog,
                catalog_sha256,
                scope_id,
            )

    record_path = (
        _write_promotion_record(
            bundle_root,
            scope,
            scope_id,
            catalog_sha256,
            evidence_manifest,
        )
        if evidence_manifest is not None
        else _write_blocked_record(bundle_root, scope, scope_id, catalog_sha256)
    )
    validate_production_record(
        json.loads(record_path.read_text(encoding="utf-8")),
        bundle_root,
    )
    return ValidationBundleResult(
        scope_id=scope_id,
        catalog_sha256=catalog_sha256,
        production_record_path=record_path.as_posix(),
    )


def _cli(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle-root", type=Path, required=True)
    parser.add_argument("--scope", type=Path, required=True)
    parser.add_argument("--expected-device", choices=("cpu", "gpu"))
    parser.add_argument("--evidence-manifest", type=Path)
    args = parser.parse_args(argv)
    try:
        scope = json.loads(args.scope.read_text(encoding="utf-8"))
        result = write_validation_bundle(
            args.bundle_root,
            scope,
            expected_device=args.expected_device,
            evidence_manifest=args.evidence_manifest,
        )
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(f"invalid frequency-domain validation bundle: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result.__dict__, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli(sys.argv[1:]))
