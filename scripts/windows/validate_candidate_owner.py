"""Verify a sealed development candidate before trusting its API identity."""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import sys
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from windows import development_handoff as capsule
from windows import development_restore_launch as restore
from windows import runtime_bundle

REQUEST_SCHEMA = "fullmag.development-candidate-owner-request.v1"
ACK_SCHEMA = "fullmag.development-candidate-owner-ack.v1"
MAX_REQUEST_BYTES = 16 * 1024
MAX_MANIFEST_BYTES = 256 * 1024
FIELDS = frozenset({"schema", "storage_root", "worktree_id", "candidate_bundle_root", "candidate_manifest_sha256"})


def _manifest_bytes(root: Path) -> bytes:
    path = root / "manifest.json"
    runtime_bundle._require_regular_file(path, "candidate manifest", nonempty=True)
    with path.open("rb") as source:
        raw = source.read(MAX_MANIFEST_BYTES + 1)
    if len(raw) > MAX_MANIFEST_BYTES:
        raise capsule.HandoffError("Candidate manifest exceeds its limit")
    return raw


def validate_request(repo_root: str, request: Any) -> dict[str, Any]:
    capsule._exact_keys(request, FIELDS, "candidate owner request")
    if request["schema"] != REQUEST_SCHEMA:
        raise capsule.HandoffError("Unknown candidate owner schema")
    if any(not isinstance(request[key], str) for key in FIELDS):
        raise capsule.HandoffError("Candidate owner fields must be strings")
    digest = request["candidate_manifest_sha256"]
    if not capsule._SHA256.fullmatch(digest):
        raise capsule.HandoffError("Invalid candidate manifest digest")
    layout, runtime = restore._verified_workspace(repo_root)
    store = capsule._validate_runtime_root(layout["storage_root"])
    requested_store = capsule._validate_runtime_root(request["storage_root"])
    if not requested_store.samefile(store) or request["worktree_id"] != layout["worktree_id"]:
        raise capsule.HandoffError("Candidate owner belongs to another workspace")
    try:
        root = runtime_bundle._absolute_path(request["candidate_bundle_root"], "candidate bundle")
        root = runtime_bundle._require_directory(root, "candidate bundle")
        namespace = runtime_bundle._require_directory(runtime / "native-bundles", "candidate namespace")
        if not root.parent.samefile(namespace) or not runtime_bundle.BUNDLE_ID_RE.fullmatch(root.name):
            raise capsule.HandoffError("Candidate is outside the managed bundle namespace")
        # Rust canonical paths may carry the Windows extended-length prefix.
        # Validate both chains, then use the resolver's spelling consistently.
        resolved_root = runtime_bundle._require_directory(namespace / root.name, "resolved candidate bundle")
        if not root.samefile(resolved_root):
            raise capsule.HandoffError("Candidate differs from its resolved namespace")
        root = resolved_root
        raw = _manifest_bytes(root)
        if hashlib.sha256(raw).hexdigest() != digest:
            raise capsule.HandoffError("Candidate manifest digest mismatch")
        manifest, _checks = runtime_bundle.validate_bundle(root, runtime, "dev")
        source = manifest["source"]
        if source["workspace_namespace"] != layout["worktree_id"]:
            raise capsule.HandoffError("Candidate belongs to another worktree")
        if source["target_triple"] != "x86_64-pc-windows-msvc":
            raise capsule.HandoffError("Candidate is not a native Windows build")
        version = source["build_version"]["product_version"]
        if not isinstance(version, str) or not restore._BUILD_ID.fullmatch(version):
            raise capsule.HandoffError("Invalid candidate product version")
        if _manifest_bytes(root) != raw:
            raise capsule.HandoffError("Candidate manifest changed during verification")
    except runtime_bundle.BundleError as error:
        raise capsule.HandoffError("Candidate bundle verification failed") from error
    return {"schema": ACK_SCHEMA, "storage_root": str(store),
            "worktree_id": layout["worktree_id"], "candidate_bundle_id": manifest["bundle_id"],
            "candidate_manifest_sha256": digest, "git_commit": source["git_commit"],
            "source_snapshot_sha256": source["source_snapshot_sha256"],
            "backend_source_sha256": source["backend_source_sha256"], "product_version": version}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True)
    args = parser.parse_args()
    try:
        if os.environ.get("FULLMAG_NATIVE_RUNTIME_ACTIVE") != "1" or os.environ.get("FULLMAG_STORAGE_PROFILE") != restore.STORAGE_PROFILE:
            raise capsule.HandoffError("Candidate owner validation requires managed native dev")
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            raise capsule.HandoffError("Candidate owner request exceeds its limit")
        result = validate_request(args.repo_root, capsule._strict_json(raw, "candidate owner request"))
        sys.stdout.buffer.write(capsule._canonical_json(result, "candidate owner ACK", MAX_REQUEST_BYTES) + b"\n")
        return 0
    except (capsule.HandoffError, OSError, TypeError, ValueError, KeyError, RecursionError):
        print("Candidate owner validation failed", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
