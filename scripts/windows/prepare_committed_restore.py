"""Read-only restore preparation bound to an owner-verified durable cold commit.

The process owner must prove old API exit and supply its pinned store binding,
commit digest, nonce and staged binding. This helper never releases admission,
starts a process or marks a capsule restored.
"""
from __future__ import annotations

import argparse
from datetime import datetime
import os
from pathlib import Path
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from windows import development_handoff as capsule
from windows import development_restore_launch as restore
from windows import development_scene_handoff as semantic
from windows.accepted_store_identity import store_binding

REQUEST_SCHEMA = "fullmag.development-committed-restore-request.v1"
RESULT_SCHEMA = "fullmag.development-committed-restore-preparation.v1"
MAX_REQUEST_BYTES = 16 * 1024
MAX_RESULT_BYTES = 128 * 1024 * 1024
FIELDS = frozenset({"schema", "accepted_store_scope", "accepted_store_binding", "commit_sha256",
                   "acquisition_nonce", "binding", "candidate_bundle_root", "candidate_manifest_sha256"})
COMMIT_FIELDS = frozenset({"schema", "api_instance_id", "acquisition_nonce", "handoff_id",
                          "snapshot_sha256", "target_build_id", "accepted_store_binding", "fence", "created_at"})
FENCE_FIELDS = frozenset({"schema", "owner_token", "nonce", "created_at"})


def canonical_uuid(value):
    if not isinstance(value, str):
        raise capsule.HandoffError("Committed restore UUID is invalid")
    try:
        parsed = uuid.UUID(value)
    except ValueError as error:
        raise capsule.HandoffError("Committed restore UUID is invalid") from error
    if not parsed.int or str(parsed) != value:
        raise capsule.HandoffError("Committed restore UUID is not canonical")


def digest(value):
    if not isinstance(value, str) or not capsule._SHA256.fullmatch(value):
        raise capsule.HandoffError("Committed restore digest is invalid")


def utc_timestamp(value):
    if not isinstance(value, str):
        raise capsule.HandoffError("Committed restore timestamp is invalid")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise capsule.HandoffError("Committed restore timestamp is invalid") from error
    if parsed.tzinfo is None or parsed.utcoffset().total_seconds() != 0:
        raise capsule.HandoffError("Committed restore timestamp is not UTC")


def require_cold_store(store):
    services = store / "runtime-services"
    if os.path.lexists(services):
        capsule._require_directory(services, store, "committed restore service directory")
    for name in ("APPLICATION.json", "OWNER.lock", "OWNER.json", "LAUNCH.json"):
        try:
            os.lstat(services / name)
        except FileNotFoundError:
            continue
        except OSError as error:
            raise capsule.HandoffError("Committed restore service metadata outcome is unknown") from error
        raise capsule.HandoffError("Committed restore store has resident service metadata")


def prepare_request(repo_root, request):
    capsule._exact_keys(request, FIELDS, "committed restore request")
    if request["schema"] != REQUEST_SCHEMA:
        raise capsule.HandoffError("Unknown committed restore request")
    for field in ("accepted_store_binding", "commit_sha256", "candidate_manifest_sha256"):
        digest(request[field])
    canonical_uuid(request["acquisition_nonce"])
    scope = request["accepted_store_scope"]
    if scope is not None:
        canonical_uuid(scope)
    binding = capsule._validate_binding(request["binding"],
        allow_empty_session=isinstance(request["binding"], dict) and request["binding"].get("session_id") is None)
    layout = capsule._STORAGE.resolve_layout(repo_root, restore.STORAGE_PROFILE)
    storage, runtime = semantic._roots(repo_root)
    runs = capsule._validate_runtime_root(layout["runs_root"])
    expected_runs = storage / "runs" / layout["worktree_id"]
    if not runs.samefile(expected_runs):
        raise capsule.HandoffError("Committed restore runs namespace differs")
    store = runs / "session-store" if scope is None else runs / "workspaces" / scope / "session-store"
    store = capsule._validate_runtime_root(store)
    capsule._contained_path(store, runs, "committed restore accepted store")
    if store_binding(store) != request["accepted_store_binding"]:
        raise capsule.HandoffError("Committed restore actual store binding differs from owner pin")
    require_cold_store(store)
    commit_path = store / "development" / "HANDOFF-COMMIT.json"
    fence_path = store / "development" / "ADMISSION-FENCE.json"
    commit_bytes = capsule._read_limited(commit_path, store, "committed restore marker", 16 * 1024)
    if capsule._sha256(commit_bytes) != request["commit_sha256"]:
        raise capsule.HandoffError("Committed restore marker differs from owner pin")
    record = capsule._strict_json(commit_bytes, "committed restore marker")
    capsule._exact_keys(record, COMMIT_FIELDS, "committed restore marker")
    fence = capsule._strict_json(capsule._read_limited(fence_path, store, "committed restore fence", 4096),
                                 "committed restore fence")
    capsule._exact_keys(fence, FENCE_FIELDS, "committed restore fence")
    if record["schema"] != "fullmag.development-handoff-commit.v1" or fence["schema"] != "fullmag.development-admission-fence.v1":
        raise capsule.HandoffError("Committed restore store schema is invalid")
    for field in ("api_instance_id", "acquisition_nonce", "handoff_id"):
        canonical_uuid(record[field])
    canonical_uuid(fence["nonce"])
    if (not isinstance(fence["owner_token"], str) or len(fence["owner_token"]) != 32
            or any(c not in "0123456789abcdef" for c in fence["owner_token"])):
        raise capsule.HandoffError("Committed restore fence owner is invalid")
    utc_timestamp(fence["created_at"])
    utc_timestamp(record["created_at"])
    for field in ("snapshot_sha256", "target_build_id", "accepted_store_binding"):
        digest(record[field])
    if (record["fence"] != fence or fence["nonce"] != request["acquisition_nonce"]
            or record["acquisition_nonce"] != request["acquisition_nonce"]
            or record["api_instance_id"] != binding["api_instance_id"]
            or record["target_build_id"] != binding["target_build_id"]
            or record["accepted_store_binding"] != request["accepted_store_binding"]):
        raise capsule.HandoffError("Committed restore store does not match owner proof")
    candidate = request["candidate_bundle_root"]
    if not isinstance(candidate, str):
        raise capsule.HandoffError("Committed restore candidate is invalid")
    candidate_path = Path(candidate)
    candidate_manifest = candidate_path / "manifest.json"
    manifest_bytes = capsule._read_limited(candidate_manifest, runtime, "committed restore candidate", 256 * 1024)
    if capsule._sha256(manifest_bytes) != request["candidate_manifest_sha256"]:
        raise capsule.HandoffError("Committed restore candidate manifest changed")
    prepared = restore.prepare_development_restore_launch(repo_root, record["handoff_id"], binding, candidate)
    if prepared["handoff"]["snapshot_sha256"] != record["snapshot_sha256"]:
        raise capsule.HandoffError("Committed restore capsule differs from durable acceptance")
    if (capsule._read_limited(commit_path, store, "committed restore marker", 16 * 1024) != commit_bytes
            or capsule._strict_json(capsule._read_limited(fence_path, store, "committed restore fence", 4096), "fence") != fence
            or capsule._read_limited(candidate_manifest, runtime, "committed restore candidate", 256 * 1024) != manifest_bytes):
        raise capsule.HandoffError("Committed restore inputs changed during preparation")
    require_cold_store(store)
    if store_binding(store) != request["accepted_store_binding"]:
        raise capsule.HandoffError("Committed restore actual store identity changed")
    if prepared["envelope"] is not None:
        capsule._canonical_json(prepared["envelope"], "prelisten restore envelope", capsule.MAX_SNAPSHOT_BYTES)
    return {"schema": RESULT_SCHEMA, "commit_sha256": request["commit_sha256"],
            "accepted_store_binding": request["accepted_store_binding"], "binding": binding,
            "candidate_manifest_sha256": request["candidate_manifest_sha256"],
            "preparation": prepared}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True)
    args = parser.parse_args(argv)
    try:
        if os.environ.get("FULLMAG_NATIVE_RUNTIME_ACTIVE") != "1" or os.environ.get("FULLMAG_STORAGE_PROFILE") != restore.STORAGE_PROFILE:
            raise capsule.HandoffError("Committed restore requires managed native dev")
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            raise capsule.HandoffError("Committed restore request exceeds limit")
        result = prepare_request(args.repo_root, capsule._strict_json(raw, "committed restore request"))
        sys.stdout.buffer.write(capsule._canonical_json(result, "committed restore preparation", MAX_RESULT_BYTES) + b"\n")
        sys.stdout.buffer.flush()
        return 0
    except (capsule.HandoffError, capsule._STORAGE.StorageError, OSError, ValueError, TypeError, RecursionError):
        print("Committed development restore preparation failed", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
