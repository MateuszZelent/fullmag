"""Read-only semantic validation for an API-owned cold handoff commit."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import sys
import uuid
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from windows import development_handoff as capsule
from windows import development_scene_handoff as semantic

REQUEST_SCHEMA = "fullmag.development-cold-handoff-validation-request.v1"
ACK_SCHEMA = "fullmag.development-cold-handoff-validation-ack.v1"
PROFILE = "windows-native-fdm-cpu-dev"
MAX_REQUEST_BYTES = 16 * 1024
MAX_ACK_BYTES = 16 * 1024
_REQUEST_FIELDS = frozenset(
    {"schema", "storage_root", "worktree_id", "handoff_id", "snapshot_sha256", "binding"}
)
_WORKTREE_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")


def validate_request(repo_root: str, request: Any) -> dict[str, Any]:
    """Load the capsule through the canonical Python verifier without mutation."""
    capsule._exact_keys(request, _REQUEST_FIELDS, "cold handoff validation request")
    if request["schema"] != REQUEST_SCHEMA:
        raise capsule.HandoffError("Unknown cold handoff validation request schema")

    storage_value = request["storage_root"]
    worktree_id = request["worktree_id"]
    handoff_id = request["handoff_id"]
    snapshot_sha256 = request["snapshot_sha256"]
    raw_binding = request["binding"]
    if not isinstance(storage_value, str) or not isinstance(worktree_id, str):
        raise capsule.HandoffError("Cold handoff storage identity is invalid")
    if not isinstance(handoff_id, str) or not isinstance(snapshot_sha256, str):
        raise capsule.HandoffError("Cold handoff reference is invalid")
    if not _WORKTREE_ID.fullmatch(worktree_id):
        raise capsule.HandoffError("Cold handoff worktree identity is invalid")
    if not capsule._SHA256.fullmatch(snapshot_sha256):
        raise capsule.HandoffError("Cold handoff snapshot digest is invalid")
    try:
        resolved_handoff = str(uuid.UUID(handoff_id))
    except (ValueError, TypeError, AttributeError) as error:
        raise capsule.HandoffError("Cold handoff ID is invalid") from error
    if resolved_handoff != handoff_id or resolved_handoff == "00000000-0000-0000-0000-000000000000":
        raise capsule.HandoffError("Cold handoff ID must be canonical and nonnil")
    if not isinstance(raw_binding, dict):
        raise capsule.HandoffError("Cold handoff binding is invalid")
    binding = capsule._validate_binding(
        raw_binding,
        allow_empty_session=raw_binding.get("session_id") is None,
    )

    try:
        layout = capsule._STORAGE.resolve_layout(repo_root, PROFILE)
        store, runtime = semantic._roots(repo_root)
        requested_storage = capsule._STORAGE.absolute(storage_value, "cold handoff storage root")
    except (capsule._STORAGE.StorageError, capsule.HandoffError, OSError, TypeError, ValueError) as error:
        raise capsule.HandoffError("Cold handoff managed storage could not be verified") from error

    if (
        not requested_storage.samefile(store)
        or Path(layout["storage_root"]).resolve() != store
        or layout.get("worktree_id") != worktree_id
        or Path(layout["runtime_root"]).resolve() != runtime
        or runtime != store / "runtimes" / worktree_id
    ):
        raise capsule.HandoffError("Cold handoff belongs to another storage root or worktree")

    expected_schema = (
        capsule.EMPTY_WORKSPACE_SCHEMA
        if binding["session_id"] is None
        else capsule.SCENE_ASSET_SCHEMA
    )
    loaded = semantic.load_scene_handoff(repo_root, handoff_id, binding)
    if (
        loaded.get("schema") != expected_schema
        or loaded.get("handoff_id") != handoff_id
        or loaded.get("snapshot_sha256") != snapshot_sha256
        or loaded.get("binding") != binding
        or loaded.get("receipt", {}).get("state") != "staged"
    ):
        raise capsule.HandoffError("Cold handoff capsule differs from its expected staged identity")
    assets = loaded.get("assets")
    if not isinstance(assets, list) or len(assets) > capsule.MAX_ASSET_COUNT:
        raise capsule.HandoffError("Cold handoff asset list is invalid")

    return {
        "schema": ACK_SCHEMA,
        "storage_root": str(store),
        "worktree_id": worktree_id,
        "handoff_id": handoff_id,
        "snapshot_sha256": snapshot_sha256,
        "binding": binding,
        "asset_count": len(assets),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True)
    args = parser.parse_args(argv)
    try:
        if (
            os.environ.get("FULLMAG_NATIVE_RUNTIME_ACTIVE") != "1"
            or os.environ.get("FULLMAG_STORAGE_PROFILE") != PROFILE
        ):
            raise capsule.HandoffError("Cold handoff validator requires managed native dev")
        data = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(data) > MAX_REQUEST_BYTES:
            raise capsule.HandoffError("Cold handoff validation request exceeds its limit")
        request = capsule._strict_json(data, "cold handoff validation request")
        result = validate_request(args.repo_root, request)
        encoded = capsule._canonical_json(result, "cold handoff validation ACK", MAX_ACK_BYTES)
        sys.stdout.buffer.write(encoded + b"\n")
        sys.stdout.buffer.flush()
        return 0
    except (capsule.HandoffError, OSError, TypeError, ValueError, RecursionError):
        print("Cold handoff semantic validation failed", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
