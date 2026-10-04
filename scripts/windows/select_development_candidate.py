"""Seal the current managed native development build as a restart candidate."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from windows import development_handoff as capsule
from windows import development_restore_launch as restore
from windows import development_status
from windows import runtime_bundle
from windows.workspace_backend_identity import fingerprint


REQUEST_SCHEMA = "fullmag.development-ready-candidate-request.v1"
ACK_SCHEMA = "fullmag.development-ready-candidate-ack.v1"
MAX_REQUEST_BYTES = 4 * 1024
MAX_ACK_BYTES = 4 * 1024
MAX_STATUS_BYTES = 8 * 1024
MAX_BUILD_MANIFEST_BYTES = 256 * 1024
MAX_BUNDLE_MANIFEST_BYTES = 256 * 1024
STATUS_FRESHNESS_MS = 10_000
STATUS_FUTURE_TOLERANCE_MS = 5_000
COPY_HEADROOM_BYTES = 64 * 1024 * 1024
EXPECTED_BINARY_COUNT = 13
DIAGNOSTIC_STATUS_PROFILE = "development-backend-api-checks"
REQUEST_FIELDS = frozenset({"schema", "storage_root", "worktree_id", "generation_id"})
READY_STATUS_FIELDS = frozenset(
    {
        "schema",
        "generation_id",
        "worktree_id",
        "state",
        "source_sha256",
        "ready_build_id",
        "ready_source_sha256",
        "revision",
        "updated_unix_ms",
    }
)


def _samefile(left: Path, right: Path, label: str) -> bool:
    try:
        return left.samefile(right)
    except OSError as error:
        raise capsule.HandoffError(f"Cannot resolve {label}") from error


def _validate_request_document(request: Any) -> dict[str, str]:
    value = capsule._exact_keys(request, REQUEST_FIELDS, "ready candidate request")
    if value["schema"] != REQUEST_SCHEMA or any(
        not isinstance(value[field], str) for field in REQUEST_FIELDS
    ):
        raise capsule.HandoffError("Ready candidate request is invalid")
    if (
        development_status.GENERATION_ID.fullmatch(value["generation_id"]) is None
        or development_status.WORKTREE_ID.fullmatch(value["worktree_id"]) is None
    ):
        raise capsule.HandoffError("Ready candidate request pins are invalid")
    return value


def _validate_owner_pins(value: dict[str, str], generation_id: str, worktree_id: str) -> None:
    if value["generation_id"] != generation_id or value["worktree_id"] != worktree_id:
        raise capsule.HandoffError("Ready candidate request does not match the managed owner")


def _validate_ready_status_document(value: Any, now_ms: int | None = None) -> dict[str, Any]:
    value = capsule._exact_keys(
        value,
        READY_STATUS_FIELDS,
        "backend watcher status",
    )
    if value["schema"] != development_status.SCHEMA or value["state"] != "ready":
        raise capsule.HandoffError("Backend watcher is not ready")

    generation_id = value["generation_id"]
    worktree_id = value["worktree_id"]
    source_sha256 = value["source_sha256"]
    ready_build_id = value["ready_build_id"]
    ready_source_sha256 = value["ready_source_sha256"]
    if (
        not isinstance(generation_id, str)
        or development_status.GENERATION_ID.fullmatch(generation_id) is None
        or not isinstance(worktree_id, str)
        or development_status.WORKTREE_ID.fullmatch(worktree_id) is None
        or not isinstance(source_sha256, str)
        or development_status.SHA256.fullmatch(source_sha256) is None
        or not isinstance(ready_build_id, str)
        or development_status.SHA256.fullmatch(ready_build_id) is None
        or not isinstance(ready_source_sha256, str)
        or development_status.SHA256.fullmatch(ready_source_sha256) is None
        or ready_source_sha256 != source_sha256
    ):
        raise capsule.HandoffError("Backend watcher ready identity is invalid")

    revision = value["revision"]
    updated_unix_ms = value["updated_unix_ms"]
    if type(revision) is not int or revision <= 0:
        raise capsule.HandoffError("Backend watcher revision is invalid")
    if type(updated_unix_ms) is not int or updated_unix_ms < 0:
        raise capsule.HandoffError("Backend watcher timestamp is invalid")
    if now_ms is None:
        now_ms = int(time.time() * 1000)
    if updated_unix_ms < now_ms - STATUS_FRESHNESS_MS:
        raise capsule.HandoffError("Backend watcher status is stale")
    if updated_unix_ms > now_ms + STATUS_FUTURE_TOLERANCE_MS:
        raise capsule.HandoffError("Backend watcher timestamp is in the future")
    return value


def _read_ready_status(path: Path, storage_root: Path) -> dict[str, Any]:
    raw = capsule._read_limited(path, storage_root, "backend watcher status", MAX_STATUS_BYTES)
    return _validate_ready_status_document(capsule._strict_json(raw, "backend watcher status"))


def _validate_status_pins(value: dict[str, Any], generation_id: str, worktree_id: str) -> None:
    if value["generation_id"] != generation_id or value["worktree_id"] != worktree_id:
        raise capsule.HandoffError("Backend watcher status belongs to another generation")


def _status_identity(value: dict[str, Any]) -> dict[str, Any]:
    return {key: item for key, item in value.items() if key != "updated_unix_ms"}


def _validate_final_ready_identity(
    before: dict[str, Any], after: dict[str, Any], current_source_sha256: Any, ready_source_sha256: str
) -> None:
    if current_source_sha256 != ready_source_sha256 or _status_identity(after) != _status_identity(before):
        raise capsule.HandoffError("Ready candidate changed while it was being sealed")


def _validate_candidate_namespace(candidate_root: Path, bundles_root: Path) -> None:
    if (
        not candidate_root.parent.samefile(bundles_root)
        or runtime_bundle.BUNDLE_ID_RE.fullmatch(candidate_root.name) is None
    ):
        raise capsule.HandoffError("Sealed candidate is outside the native bundle namespace")


def _selected_status_path(layout: dict[str, Any], storage_root: Path, worktree_id: str) -> Path:
    if os.environ.get("FULLMAG_DEVELOPMENT_OWNER_PROBE") == "1":
        diagnostic_root = runtime_bundle._require_directory(
            storage_root / "builds" / worktree_id / DIAGNOSTIC_STATUS_PROFILE,
            "diagnostic backend status profile",
        )
        if _samefile(diagnostic_root, Path(layout["build_root"]), "diagnostic status profile"):
            raise capsule.HandoffError("Diagnostic backend status aliases the native watcher profile")
        return diagnostic_root / "backend-watch-status.json"
    return Path(layout["build_root"]) / "backend-watch-status.json"


def _source_inventory_bytes(
    build_root: Path,
    storage_root: Path,
    manifest_path: Path,
    expected_manifest_sha256: str,
) -> int:
    raw_manifest = capsule._read_limited(
        manifest_path, storage_root, "backend build manifest", MAX_BUILD_MANIFEST_BYTES
    )
    if hashlib.sha256(raw_manifest).hexdigest() != expected_manifest_sha256:
        raise capsule.HandoffError("Backend build manifest changed before storage preflight")
    try:
        manifest = json.loads(
            raw_manifest.decode("utf-8-sig"),
            object_pairs_hook=runtime_bundle._duplicate_rejecting_object,
        )
    except (UnicodeError, json.JSONDecodeError) as error:
        raise capsule.HandoffError("Backend build manifest is invalid") from error
    if not isinstance(manifest, dict):
        raise capsule.HandoffError("Backend build manifest is invalid")

    target_root_value = manifest.get("cargo_target_dir")
    target_triple = manifest.get("target_triple")
    if (
        not isinstance(target_root_value, str)
        or not isinstance(target_triple, str)
        or runtime_bundle.SAFE_COMPONENT_RE.fullmatch(target_triple) is None
        or manifest.get("compiler_profile") != "backend-dev"
    ):
        raise capsule.HandoffError("Backend build manifest has no supported dev inventory")
    target_root = runtime_bundle._absolute_path(target_root_value, "Cargo target directory")
    if not runtime_bundle._is_within(target_root, build_root, allow_equal=True):
        raise capsule.HandoffError("Cargo target directory is outside the managed build root")
    profile_dir = runtime_bundle._require_directory(
        target_root / target_triple / "backend-dev", "Cargo backend-dev profile"
    )

    if len(runtime_bundle.BINARY_NAMES) != EXPECTED_BINARY_COUNT:
        raise capsule.HandoffError("Native development executable inventory is unsupported")
    total = 0
    for name in runtime_bundle.BINARY_NAMES:
        info = runtime_bundle._require_regular_file(
            profile_dir / name, f"source executable {name}", nonempty=True
        )
        total += info.st_size
    return total


def validate_request(repo_root: str, request: Any) -> dict[str, str]:
    request = _validate_request_document(request)
    if os.environ.get("FULLMAG_NATIVE_RUNTIME_ACTIVE") != "1" or os.environ.get(
        "FULLMAG_STORAGE_PROFILE"
    ) != restore.STORAGE_PROFILE:
        raise capsule.HandoffError("Ready candidate selection requires managed native dev")

    generation_id = request["generation_id"]
    worktree_id = request["worktree_id"]
    _validate_owner_pins(
        request,
        os.environ.get("FULLMAG_DEVELOPMENT_BACKEND_GENERATION", ""),
        os.environ.get("FULLMAG_WORKTREE_ID", ""),
    )

    repo_path = runtime_bundle._require_directory(repo_root, "repository root").resolve(strict=True)
    layout, runtime_root = restore._verified_workspace(str(repo_path))
    resolved_repo = runtime_bundle._require_directory(layout["repo_root"], "registered repository root").resolve(
        strict=True
    )
    if not _samefile(repo_path, resolved_repo, "registered repository root"):
        raise capsule.HandoffError("Ready candidate repository is not the registered worktree")

    storage_root = capsule._validate_runtime_root(layout["storage_root"])
    requested_storage = capsule._validate_runtime_root(request["storage_root"])
    environment_storage = capsule._validate_runtime_root(
        os.environ.get("FULLMAG_PROJECT_STORAGE_ROOT", "")
    )
    if (
        not _samefile(requested_storage, storage_root, "requested storage root")
        or not _samefile(environment_storage, storage_root, "owner storage root")
        or layout.get("worktree_id") != worktree_id
    ):
        raise capsule.HandoffError("Ready candidate request belongs to another workspace")

    build_root = runtime_bundle._require_directory(layout["build_root"], "managed native build root").resolve(
        strict=True
    )
    runtime_root = runtime_bundle._require_directory(runtime_root, "managed native runtime root").resolve(
        strict=True
    )
    capsule._contained_path(build_root, storage_root, "managed native build root")
    capsule._contained_path(runtime_root, storage_root, "managed native runtime root")

    status_path = _selected_status_path(layout, storage_root, worktree_id)
    env_status_value = os.environ.get("FULLMAG_DEVELOPMENT_BACKEND_STATUS_FILE", "")
    env_status = runtime_bundle._absolute_path(env_status_value, "managed backend status path")
    runtime_bundle._check_path_chain(env_status, "managed backend status path")
    capsule._contained_path(status_path, storage_root, "backend watcher status")
    if not _samefile(env_status, status_path, "managed backend status path"):
        raise capsule.HandoffError("Managed backend status path differs from its registered build")

    status_before = _read_ready_status(status_path, storage_root)
    _validate_status_pins(status_before, generation_id, worktree_id)

    source_before = fingerprint(repo_path).get("sha256")
    if source_before != status_before["source_sha256"]:
        raise capsule.HandoffError("Current backend sources differ from the ready watcher status")

    manifest_path = runtime_bundle._absolute_path(
        build_root / "windows-runtime" / "build-manifest.json", "managed backend build manifest"
    )
    runtime_bundle._require_regular_file(manifest_path, "managed backend build manifest", nonempty=True)
    canonical_manifest = manifest_path.resolve(strict=True)
    if not _samefile(manifest_path, canonical_manifest, "managed backend build manifest"):
        raise capsule.HandoffError("Managed backend build manifest is not canonical")

    ready_identity = development_status.verified_build_identity(
        build_root, runtime_root, canonical_manifest, status_before["ready_source_sha256"]
    )
    if (
        ready_identity["ready_build_id"] != status_before["ready_build_id"]
        or ready_identity["ready_source_sha256"] != status_before["ready_source_sha256"]
    ):
        raise capsule.HandoffError("Backend build differs from the ready watcher identity")

    binary_bytes = _source_inventory_bytes(
        build_root,
        storage_root,
        canonical_manifest,
        status_before["ready_build_id"],
    )
    try:
        available_bytes = shutil.disk_usage(runtime_root).free
    except OSError as error:
        raise capsule.HandoffError("Cannot verify native runtime storage capacity") from error
    if available_bytes < binary_bytes + COPY_HEADROOM_BYTES:
        raise capsule.HandoffError("Insufficient free space to seal the ready development candidate")

    created = runtime_bundle.create_bundle(build_root, runtime_root, canonical_manifest, "dev")
    candidate_root = runtime_bundle._require_directory(created["bundle_root"], "ready candidate bundle")
    bundle_root = runtime_root / "native-bundles"
    runtime_bundle._require_directory(bundle_root, "native bundle root")
    _validate_candidate_namespace(candidate_root, bundle_root)

    candidate_manifest_path = candidate_root / "manifest.json"
    raw_manifest = capsule._read_limited(
        candidate_manifest_path, storage_root, "sealed candidate manifest", MAX_BUNDLE_MANIFEST_BYTES
    )
    candidate_manifest, _checks = runtime_bundle.validate_bundle(candidate_root, runtime_root, "dev")
    source = candidate_manifest.get("source")
    if (
        candidate_manifest.get("profile") != "dev"
        or not isinstance(source, dict)
        or source.get("workspace_namespace") != worktree_id
        or source.get("target_triple") != "x86_64-pc-windows-msvc"
        or source.get("manifest_sha256") != status_before["ready_build_id"]
        or source.get("backend_source_sha256") != status_before["ready_source_sha256"]
    ):
        raise capsule.HandoffError("Sealed candidate does not match the ready build identity")

    # The validator and bounded reads must observe one immutable manifest so
    # the ACK digest names the bundle that passed validation.
    if capsule._read_limited(
        candidate_manifest_path, storage_root, "sealed candidate manifest", MAX_BUNDLE_MANIFEST_BYTES
    ) != raw_manifest:
        raise capsule.HandoffError("Sealed candidate manifest changed during verification")

    source_after = fingerprint(repo_path).get("sha256")
    status_after = _read_ready_status(status_path, storage_root)
    _validate_status_pins(status_after, generation_id, worktree_id)
    _validate_final_ready_identity(
        status_before, status_after, source_after, status_before["ready_source_sha256"]
    )

    return {
        "schema": ACK_SCHEMA,
        "worktree_id": worktree_id,
        "generation_id": generation_id,
        "ready_build_id": status_before["ready_build_id"],
        "ready_source_sha256": status_before["ready_source_sha256"],
        "candidate_bundle_id": candidate_root.name,
        "candidate_manifest_sha256": hashlib.sha256(raw_manifest).hexdigest(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True)
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            raise capsule.HandoffError("Ready candidate request exceeds its limit")
        request = capsule._strict_json(raw, "ready candidate request")
        result = validate_request(args.repo_root, request)
        sys.stdout.buffer.write(capsule._canonical_json(result, "ready candidate ACK", MAX_ACK_BYTES) + b"\n")
        return 0
    except Exception:
        print("Ready candidate selection failed", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
