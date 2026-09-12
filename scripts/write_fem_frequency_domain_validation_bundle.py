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
import shutil
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from verify_fem_frequency_domain_production_dod import (
    ALL_DOD_IDS,
    BINDING_SCHEMA,
    CATALOG_SCHEMA,
    SCHEMA,
    SHA256_ID,
    SIDECAR_SCHEMA,
    canonical_json_bytes,
    scope_id_for,
    _validate_binding_covers_scope,
    _validate_verifier_execution_proof,
    validate_artifact_sidecar,
    validate_production_record,
    validate_scope,
    validate_scope_catalog,
    validate_scope_binding,
)


CATALOG_URI = "validation/scopes/scope_catalog.v1.json"
STAGING_INDEX_SCHEMA = "frequency_domain_staging_index.v1"
EVIDENCE_MANIFEST_SCHEMA = "frequency_domain_production_evidence_manifest.v1"
SOURCE_MANIFEST_SCHEMA = "frequency_domain_source_manifest.v1"


@dataclass(frozen=True)
class ValidationBundleResult:
    scope_id: str
    catalog_sha256: str
    production_record_path: str


@dataclass(frozen=True)
class StagedEvidenceResult:
    prepublish_bundle_root: str
    evidence_manifest_path: str
    source_manifest_path: str


def _sha256_bytes(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def _require_regular_file(path: Path, *, label: str) -> None:
    stat_result = path.lstat()
    if not path.is_file() or path.is_symlink():
        raise ValueError(f"{label} must be a regular non-symlink file: {path}")
    if stat_result.st_nlink != 1:
        raise ValueError(f"{label} must not be hardlinked: {path}")


def _safe_relative_file(root: Path, raw_path: Any, *, label: str) -> tuple[Path, str]:
    if not isinstance(raw_path, str) or not raw_path:
        raise ValueError(f"{label} must be a non-empty relative path")
    relative = Path(raw_path)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError(f"{label} must be a safe relative path")
    path = root / relative
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError as exc:
        raise ValueError(f"{label} escapes staging root") from exc
    _require_regular_file(path, label=label)
    return path, relative.as_posix()


def _copy_hash_bound_file(source: Path, destination: Path, expected_sha256: str, expected_size: int) -> None:
    _require_regular_file(source, label="staging artifact")
    source_bytes = source.read_bytes()
    if len(source_bytes) != expected_size:
        raise ValueError(f"staging artifact size does not match index: {source}")
    if _sha256_bytes(source_bytes) != expected_sha256:
        raise ValueError(f"staging artifact hash does not match index: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(source_bytes)
    _require_regular_file(destination, label="copied evidence artifact")
    copied_bytes = destination.read_bytes()
    if len(copied_bytes) != expected_size or _sha256_bytes(copied_bytes) != expected_sha256:
        raise ValueError(f"copied evidence artifact does not match source index: {source}")


def _safe_zarr_tree_digest(path: Path) -> str:
    if path.is_symlink() or not path.is_dir() or not path.name.endswith(".zarr"):
        raise ValueError(f"Zarr artifact must be a non-symlink .zarr directory: {path}")
    digest = hashlib.sha256()
    for child in sorted(path.rglob("*")):
        if child.is_symlink():
            raise ValueError(f"Zarr tree must not contain symlinks: {child}")
        if child.is_dir():
            continue
        _require_regular_file(child, label="Zarr tree entry")
        relative = child.relative_to(path).as_posix().encode("utf-8")
        payload = child.read_bytes()
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
    return "sha256:" + digest.hexdigest()


def _zarr_size_bytes(path: Path) -> int:
    _safe_zarr_tree_digest(path)
    return sum(child.stat().st_size for child in path.rglob("*") if child.is_file())


def _safe_relative_artifact(root: Path, raw_path: Any) -> tuple[Path, str]:
    if not isinstance(raw_path, str) or not raw_path:
        raise ValueError("staging artifact path must be a non-empty relative path")
    relative = Path(raw_path)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("staging artifact path must be a safe relative path")
    path = root / relative
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError as exc:
        raise ValueError("staging artifact path escapes staging root") from exc
    if path.is_symlink():
        raise ValueError(f"staging artifact must not be a symlink: {path}")
    if path.is_dir():
        _safe_zarr_tree_digest(path)
    else:
        _require_regular_file(path, label="staging artifact path")
    return path, relative.as_posix()


def _copy_hash_bound_zarr(
    source: Path,
    destination: Path,
    expected_sha256: str,
    expected_size: int,
) -> None:
    if _safe_zarr_tree_digest(source) != expected_sha256:
        raise ValueError(f"staging Zarr tree digest does not match index: {source}")
    if _zarr_size_bytes(source) != expected_size:
        raise ValueError(f"staging Zarr size does not match index: {source}")
    destination.mkdir(parents=True)
    for child in sorted(source.rglob("*")):
        relative = child.relative_to(source)
        target = destination / relative
        if child.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            _require_regular_file(child, label="Zarr tree entry")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(child.read_bytes())
            _require_regular_file(target, label="copied Zarr tree entry")
    if _safe_zarr_tree_digest(destination) != expected_sha256:
        raise ValueError(f"copied Zarr tree digest does not match source index: {source}")
    if _zarr_size_bytes(destination) != expected_size:
        raise ValueError(f"copied Zarr size does not match source index: {source}")


def _staging_tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix().encode("utf-8")
        if path.is_symlink():
            raise ValueError(f"staging tree must not contain symlinks: {path}")
        if path.is_dir():
            digest.update(b"D")
            digest.update(relative)
            continue
        _require_regular_file(path, label="staging tree entry")
        payload = path.read_bytes()
        digest.update(b"F")
        digest.update(relative)
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
    return "sha256:" + digest.hexdigest()


def _rewrite_staging_paths(value: Any, destinations: dict[str, str]) -> Any:
    if isinstance(value, str):
        return destinations.get(value, value)
    if isinstance(value, list):
        return [_rewrite_staging_paths(item, destinations) for item in value]
    if isinstance(value, dict):
        return {key: _rewrite_staging_paths(item, destinations) for key, item in value.items()}
    return value


def ingest_staged_evidence(
    staging_root: Path,
    staging_index_path: Path,
    requested_release_root: Path,
    scope: dict[str, Any],
    *,
    expected_device: str,
    scope_catalog: dict[str, Any] | None = None,
) -> StagedEvidenceResult:
    """Copy hash-bound evidence into a private prepublication bundle.

    This is intentionally an ingest primitive: it never runs raw producers and
    never writes, verifies, or publishes a DoD record.  The retained hidden
    directory must be completed and verified by an external orchestrator before
    any no-replace rename to ``requested_release_root``.
    """

    staging_root = staging_root.resolve()
    requested_release_root = requested_release_root.resolve()
    if not staging_root.is_dir():
        raise ValueError(f"staging root is not a directory: {staging_root}")
    if requested_release_root.exists():
        raise ValueError(f"requested release bundle already exists: {requested_release_root}")
    validate_scope(scope)
    if scope["device_scope"]["resolved"] != expected_device:
        raise ValueError("scope device does not match the staged production lane")
    _, staging_index_relative = _safe_relative_file(
        staging_root,
        staging_index_path.relative_to(staging_root).as_posix(),
        label="staging index",
    )
    index_bytes = staging_index_path.read_bytes()
    try:
        index = json.loads(index_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"staging index is not valid UTF-8 JSON: {exc}") from exc
    required_index_keys = {
        "schema", "lane", "scope_id", "runtime_fullmag_commit", "runtime_build_id",
        "source_manifest_path", "source_manifest_sha256", "artifacts", "evidence_manifest",
    }
    if not isinstance(index, dict) or set(index) != required_index_keys:
        raise ValueError("staging index must be a closed frequency-domain staging object")
    if index["schema"] != STAGING_INDEX_SCHEMA:
        raise ValueError("staging index has an unsupported schema")
    if index["lane"] != expected_device:
        raise ValueError("staging index lane does not match the requested production lane")
    target_scope_id = scope_id_for(scope)
    if index["scope_id"] != target_scope_id:
        raise ValueError("staging index scope_id does not match the validated scope")
    if index["runtime_fullmag_commit"] != scope["runtime_scope"]["fullmag_commit"]:
        raise ValueError("staging index runtime commit does not match the validated scope")
    if index["runtime_build_id"] != scope["runtime_scope"]["build_id"]:
        raise ValueError("staging index runtime build ID does not match the validated scope")
    canonical_catalog = {
        "schema": CATALOG_SCHEMA,
        "scope_schema": SCHEMA,
        "scopes": {target_scope_id: scope},
    }
    catalog = canonical_catalog if scope_catalog is None else scope_catalog
    catalog_sha256 = validate_scope_catalog(catalog)
    if canonical_json_bytes(catalog) != canonical_json_bytes(canonical_catalog):
        raise ValueError(
            "evidence ingest requires the canonical single-scope catalog "
            "that the validation-bundle writer will publish"
        )
    artifacts = index["artifacts"]
    if not isinstance(artifacts, list) or not artifacts:
        raise ValueError("staging index artifacts must be a non-empty array")
    evidence_manifest = index["evidence_manifest"]
    if not isinstance(evidence_manifest, dict) or evidence_manifest.get("schema") != EVIDENCE_MANIFEST_SCHEMA:
        raise ValueError("staging index evidence_manifest has an unsupported schema")

    source_manifest_sha256 = index["source_manifest_sha256"]
    if not isinstance(source_manifest_sha256, str) or SHA256_ID.fullmatch(source_manifest_sha256) is None:
        raise ValueError("staging source manifest sha256 must be a Sha256Id")
    source_manifest, source_manifest_relative = _safe_relative_file(
        staging_root,
        index["source_manifest_path"],
        label="staging source manifest",
    )
    if _sha256_bytes(source_manifest.read_bytes()) != source_manifest_sha256:
        raise ValueError("staging source manifest hash does not match the index")
    try:
        source_manifest_value = json.loads(source_manifest.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"staging source manifest is not valid UTF-8 JSON: {exc}") from exc
    required_source_manifest_keys = {
        "schema", "scope_id", "runtime_fullmag_commit", "runtime_build_id",
        "artifacts", "verified_coverage_of",
    }
    if not isinstance(source_manifest_value, dict) or set(source_manifest_value) != required_source_manifest_keys:
        raise ValueError("staging source manifest must be a closed object")
    if source_manifest_value["schema"] != SOURCE_MANIFEST_SCHEMA:
        raise ValueError("staging source manifest has an unsupported schema")
    if source_manifest_value["scope_id"] != target_scope_id:
        raise ValueError("staging source manifest scope_id does not match the target scope")
    if source_manifest_value["runtime_fullmag_commit"] != scope["runtime_scope"]["fullmag_commit"]:
        raise ValueError("staging source manifest runtime commit does not match the target scope")
    if source_manifest_value["runtime_build_id"] != scope["runtime_scope"]["build_id"]:
        raise ValueError("staging source manifest runtime build ID does not match the target scope")
    _validate_binding_covers_scope(
        source_manifest_value["verified_coverage_of"],
        catalog,
        CATALOG_URI,
        catalog_sha256,
        target_scope_id,
    )
    source_revisions: dict[str, str] = {}
    raw_source_revisions = source_manifest_value["artifacts"]
    if not isinstance(raw_source_revisions, list) or not raw_source_revisions:
        raise ValueError("staging source manifest artifacts must be a non-empty array")
    for raw_revision in raw_source_revisions:
        if not isinstance(raw_revision, dict) or set(raw_revision) != {"path", "artifact_revision"}:
            raise ValueError("staging source manifest artifact revision must be a closed object")
        relative = raw_revision["path"]
        revision = raw_revision["artifact_revision"]
        if not isinstance(relative, str) or not relative or Path(relative).is_absolute() or ".." in Path(relative).parts:
            raise ValueError("staging source manifest artifact path must be safe and relative")
        if relative in source_revisions:
            raise ValueError("staging source manifest must not contain duplicate artifact paths")
        if not isinstance(revision, str) or SHA256_ID.fullmatch(revision) is None:
            raise ValueError("staging source manifest artifact revision must be a Sha256Id")
        source_revisions[relative] = revision

    required_artifact_keys = {
        "path", "sha256", "size_bytes", "artifact_revision",
        "producer_command", "producer_exit_code",
        "scope_id", "runtime_fullmag_commit", "runtime_build_id", "sidecar_path", "sidecar_sha256",
    }
    prepared_artifacts: list[tuple[dict[str, Any], Path, str]] = []
    seen_paths: set[str] = set()
    claimed_paths: list[tuple[Path, str]] = []

    def claim_path(relative: str, owner: str) -> None:
        candidate = Path(relative)
        for claimed, claimed_owner in claimed_paths:
            if candidate == claimed or candidate in claimed.parents or claimed in candidate.parents:
                raise ValueError(
                    f"staging path ownership overlap: {owner} overlaps {claimed_owner}"
                )
        claimed_paths.append((candidate, owner))

    claim_path(staging_index_relative, "the staging index")
    claim_path(source_manifest_relative, "the source manifest")
    for raw_artifact in artifacts:
        if not isinstance(raw_artifact, dict) or set(raw_artifact) != required_artifact_keys:
            raise ValueError("staging artifact entry must be a closed object")
        source, relative = _safe_relative_artifact(staging_root, raw_artifact["path"])
        if relative in seen_paths:
            raise ValueError("staging index artifacts must not contain duplicate paths")
        seen_paths.add(relative)
        claim_path(relative, f"artifact {relative!r}")
        sidecar_path = raw_artifact["sidecar_path"]
        sidecar_sha256 = raw_artifact["sidecar_sha256"]
        if source.is_file() and source.suffix.lower() == ".json":
            if sidecar_path is not None or sidecar_sha256 is not None:
                raise ValueError("JSON staging artifacts must use top-level bindings, not sidecars")
        else:
            expected_sidecar = relative + ".validation_manifest.v1.json"
            if sidecar_path != expected_sidecar:
                raise ValueError("non-JSON staging artifacts must use the deterministic sidecar path")
            claim_path(expected_sidecar, f"sidecar for artifact {relative!r}")
        prepared_artifacts.append((raw_artifact, source, relative))
    if seen_paths != set(source_revisions):
        raise ValueError("staging source manifest artifact set does not match the staging index")

    staging_digest_before = _staging_tree_digest(staging_root)
    requested_release_root.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(
        tempfile.mkdtemp(
            prefix=f".{requested_release_root.name}.prepublish-",
            dir=requested_release_root.parent,
        )
    )
    try:
        destinations: dict[str, str] = {}
        final_sidecars: list[tuple[Path, Path, str]] = []
        for raw_artifact, source, relative in prepared_artifacts:
            digest = raw_artifact["sha256"]
            if not isinstance(digest, str) or SHA256_ID.fullmatch(digest) is None:
                raise ValueError("staging artifact sha256 must be a Sha256Id")
            revision = raw_artifact["artifact_revision"]
            if not isinstance(revision, str) or SHA256_ID.fullmatch(revision) is None:
                raise ValueError("staging artifact revision must be a Sha256Id")
            if revision != digest:
                raise ValueError("staging artifact revision does not match its indexed digest")
            if source_revisions.get(relative) != revision:
                raise ValueError("staging source manifest artifact revision does not match the index")
            size = raw_artifact["size_bytes"]
            if isinstance(size, bool) or not isinstance(size, int) or size < 0:
                raise ValueError("staging artifact size_bytes must be a non-negative integer")
            command = raw_artifact["producer_command"]
            if not isinstance(command, list) or not command or any(not isinstance(part, str) or not part for part in command):
                raise ValueError("staging artifact producer_command must be a non-empty argv array")
            if raw_artifact["producer_exit_code"] != 0:
                raise ValueError("staging artifact producer_exit_code must be zero")
            if raw_artifact["scope_id"] != target_scope_id:
                raise ValueError("staging artifact scope_id does not match the validated scope")
            if raw_artifact["runtime_fullmag_commit"] != scope["runtime_scope"]["fullmag_commit"]:
                raise ValueError("staging artifact runtime commit does not match the validated scope")
            if raw_artifact["runtime_build_id"] != scope["runtime_scope"]["build_id"]:
                raise ValueError("staging artifact runtime build ID does not match the validated scope")
            destination_relative = (Path("evidence") / relative).as_posix()
            if source.is_dir():
                _copy_hash_bound_zarr(source, temporary / destination_relative, digest, size)
            else:
                _copy_hash_bound_file(source, temporary / destination_relative, digest, size)
            destinations[relative] = destination_relative
            sidecar_path = raw_artifact["sidecar_path"]
            sidecar_sha256 = raw_artifact["sidecar_sha256"]
            if source.is_file() and source.suffix.lower() == ".json":
                try:
                    json_value = json.loads(source.read_text(encoding="utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise ValueError(f"JSON staging artifact is not valid UTF-8 JSON: {exc}") from exc
                if not isinstance(json_value, dict) or "verified_coverage_of" not in json_value:
                    raise ValueError("JSON staging artifact is missing top-level verified_coverage_of")
                _validate_binding_covers_scope(
                    json_value["verified_coverage_of"],
                    catalog,
                    CATALOG_URI,
                    catalog_sha256,
                    target_scope_id,
                )
                continue
            if not isinstance(sidecar_sha256, str) or SHA256_ID.fullmatch(sidecar_sha256) is None:
                raise ValueError("non-JSON staging artifacts require a sidecar Sha256Id")
            sidecar, sidecar_relative = _safe_relative_file(staging_root, sidecar_path, label="staging artifact sidecar")
            try:
                sidecar_value = json.loads(sidecar.read_text(encoding="utf-8"))
                validate_artifact_sidecar(
                    source,
                    sidecar,
                    sidecar_value,
                    catalog,
                    CATALOG_URI,
                    catalog_sha256,
                    relative,
                    target_scope_id,
                )
            except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
                raise ValueError(f"staging artifact sidecar is invalid: {exc}") from exc
            _copy_hash_bound_file(
                sidecar,
                temporary / "evidence" / sidecar_relative,
                sidecar_sha256,
                len(sidecar.read_bytes()),
            )
            copied_sidecar = temporary / "evidence" / sidecar_relative
            copied_sidecar_value = json.loads(copied_sidecar.read_text(encoding="utf-8"))
            copied_sidecar_value["artifact_uri"] = destination_relative
            _json_dump(copied_sidecar, copied_sidecar_value)
            validate_artifact_sidecar(
                temporary / destination_relative,
                copied_sidecar,
                copied_sidecar_value,
                catalog,
                CATALOG_URI,
                catalog_sha256,
                destination_relative,
                target_scope_id,
            )
            final_sidecars.append(
                (temporary / destination_relative, copied_sidecar, destination_relative)
            )
            destinations[sidecar_relative] = (Path("evidence") / sidecar_relative).as_posix()
        source_manifest_destination = temporary / "evidence" / source_manifest_relative
        _copy_hash_bound_file(
            source_manifest,
            source_manifest_destination,
            source_manifest_sha256,
            len(source_manifest.read_bytes()),
        )
        destinations[source_manifest_relative] = (
            Path("evidence") / source_manifest_relative
        ).as_posix()
        _json_dump(
            temporary / "evidence_manifest.v1.json",
            _rewrite_staging_paths(evidence_manifest, destinations),
        )
        for copied_artifact, copied_sidecar, destination_relative in final_sidecars:
            validate_artifact_sidecar(
                copied_artifact,
                copied_sidecar,
                json.loads(copied_sidecar.read_text(encoding="utf-8")),
                catalog,
                CATALOG_URI,
                catalog_sha256,
                destination_relative,
                target_scope_id,
            )
        if _staging_tree_digest(staging_root) != staging_digest_before or staging_index_path.read_bytes() != index_bytes:
            raise ValueError("staging changed during evidence ingest")
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return StagedEvidenceResult(
        prepublish_bundle_root=temporary.as_posix(),
        evidence_manifest_path=(temporary / "evidence_manifest.v1.json").as_posix(),
        source_manifest_path=source_manifest_destination.as_posix(),
    )


def _zarr_tree_digest(path: Path) -> str:
    return _safe_zarr_tree_digest(path)


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
    scope_id: str,
) -> None:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"JSON evidence must be an object: {path}")
    if "verified_coverage_of" in value:
        _validate_binding_covers_scope(
            value["verified_coverage_of"],
            catalog,
            CATALOG_URI,
            catalog_sha256,
            scope_id,
        )
        return
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
            _bind_json_artifact(path, binding, catalog, catalog_sha256, scope_id)
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
