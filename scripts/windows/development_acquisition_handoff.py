"""Join an owner-acquired workspace, scoped UI payload and verified candidate.

This private manager boundary stages and reads back authoring data. It never
confirms acquisition liveness, stops an API, launches a replacement or marks
restoration complete. Those operations remain with the process owner.
"""

from __future__ import annotations

import json
from typing import Any, Mapping
import uuid

from windows import development_handoff as capsule
from windows import development_restore_launch as restore
from windows import development_scene_handoff as semantic
from windows import runtime_bundle


ACQUISITION_SCHEMA = "fullmag.development-authoring-acquisition.v1"
_SOURCE_FIELDS = frozenset({"api_instance_id", "generation_id", "source_build_id", "source_sha256"})
_FRONTEND_FIELDS = frozenset({"api_instance_id", "session_id", "session_epoch", "editor", "workspace", "project_document"})


class _NumberToken(str):
    """Retain the Rust producer's numeric spelling for its canonical hash."""


def _wire_bytes(value: Any) -> bytes:
    if isinstance(value, _NumberToken):
        return value.encode("ascii")
    if isinstance(value, list):
        return b"[" + b",".join(_wire_bytes(item) for item in value) + b"]"
    if isinstance(value, dict):
        return b"{" + b",".join(
            json.dumps(key, ensure_ascii=False).encode("utf-8") + b":" + _wire_bytes(value[key])
            for key in sorted(value)
        ) + b"}"
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


def _uuid(value: Any, label: str) -> None:
    try:
        parsed = uuid.UUID(value)
    except (ValueError, TypeError, AttributeError) as error:
        raise capsule.HandoffError(f"{label} must be a canonical UUID") from error
    if parsed.int == 0 or str(parsed) != value:
        raise capsule.HandoffError(f"{label} must be a nonnil canonical UUID")


def _acquired(data: bytes, expected_api: str) -> tuple[dict[str, Any], dict[str, Any]]:
    if not isinstance(data, bytes) or len(data) > capsule.MAX_SNAPSHOT_BYTES:
        raise capsule.HandoffError("Acquisition must be bounded UTF-8 JSON bytes")
    response = capsule._strict_json(data, "authoring acquisition")
    capsule._canonical_json(response, "authoring acquisition", capsule.MAX_SNAPSHOT_BYTES)
    capsule._exact_keys(response, frozenset({"schema", "nonce", "api_instance_id", "workspace"}), "authoring acquisition")
    if response["schema"] != ACQUISITION_SCHEMA or response["api_instance_id"] != expected_api:
        raise capsule.HandoffError("Acquisition does not match its owner API")
    _uuid(response["nonce"], "acquisition nonce")
    workspace = response["workspace"]
    if not isinstance(workspace, dict):
        raise capsule.HandoffError("Acquired workspace must be an object")
    if workspace.get("state") == "no_session":
        capsule._exact_keys(workspace, frozenset({"state", "session_epoch"}), "empty acquisition")
        identity = {"session_id": None, "session_epoch": workspace["session_epoch"]}
    elif workspace.get("state") == "session":
        capsule._exact_keys(workspace, frozenset({"state", "identity", "scene_sha256", "scene_document"}), "scene acquisition")
        identity = capsule._exact_keys(workspace["identity"], frozenset({"api_instance_id", "session_id", "session_epoch", "run_id", "scene_id"}), "scene identity")
        if identity["api_instance_id"] != expected_api:
            raise capsule.HandoffError("Acquired scene belongs to another API")
        for name in ("session_id", "scene_id"):
            if not isinstance(identity[name], str) or not identity[name] or identity[name].strip() != identity[name]:
                raise capsule.HandoffError("Acquired scene identity is invalid")
        if identity["run_id"] is not None and (
            not isinstance(identity["run_id"], str) or not identity["run_id"] or identity["run_id"].strip() != identity["run_id"]
        ):
            raise capsule.HandoffError("Acquired run identity is invalid")
        scene = workspace["scene_document"]
        if not isinstance(scene, dict) or not isinstance(scene.get("scene"), dict) or scene["scene"].get("id") != identity["scene_id"]:
            raise capsule.HandoffError("Acquired scene document identity does not match")
        # Python and Rust print floating exponents differently. Hash the exact
        # validated producer tokens, then preserve semantic JSON in the capsule.
        wire = json.loads(data.decode("utf-8"), object_pairs_hook=capsule._unique_object,
            parse_float=_NumberToken, parse_int=_NumberToken, parse_constant=capsule._reject_constant)
        if capsule._sha256(_wire_bytes(wire["workspace"]["scene_document"])) != workspace["scene_sha256"]:
            raise capsule.HandoffError("Acquired scene SHA256 does not match")
    else:
        raise capsule.HandoffError("Unknown acquired workspace state")
    epoch = identity["session_epoch"]
    if type(epoch) is not int or epoch < 0 or epoch > 2**64 - 1:
        raise capsule.HandoffError("Acquired session epoch is invalid")
    return workspace, identity


def stage_acquired_workspace(
    repo_root: str,
    acquisition_bytes: bytes,
    source_identity: Mapping[str, Any],
    candidate_bundle_root: str,
    frontend_payload: Mapping[str, Any],
) -> dict[str, Any]:
    """Stage/read back a capsule; caller must then confirm its live acquisition.

    Source identity belongs to the validated owner, not to the UI. The UI may
    supply only its scoped editor/workspace/project payload after draft guards.
    A staged result is not permission to shut down and is not a restored ACK.
    """
    source = capsule._exact_keys(source_identity, _SOURCE_FIELDS, "owner source identity")
    _uuid(source["api_instance_id"], "owner API")
    acquired, identity = _acquired(acquisition_bytes, source["api_instance_id"])
    frontend = capsule._exact_keys(frontend_payload, _FRONTEND_FIELDS, "frontend handoff payload")
    for field, expected in (("api_instance_id", source["api_instance_id"]),
                            ("session_id", identity["session_id"]),
                            ("session_epoch", identity["session_epoch"])):
        if type(frontend[field]) is not type(expected) or frontend[field] != expected:
            raise capsule.HandoffError("Frontend payload belongs to another API/session epoch")
    # Bound all caller data before any capsule creation.
    capsule._canonical_json(frontend, "frontend handoff payload", capsule.MAX_SNAPSHOT_BYTES)
    layout, runtime_root = restore._verified_workspace(repo_root)
    try:
        candidate, _ = runtime_bundle.validate_bundle(candidate_bundle_root, runtime_root, "dev")
    except (runtime_bundle.BundleError, OSError, TypeError, ValueError) as error:
        raise capsule.HandoffError("Acquisition candidate failed bundle verification") from error
    candidate_source = candidate["source"]
    if candidate_source.get("workspace_namespace") != layout["worktree_id"]:
        raise capsule.HandoffError("Acquisition candidate belongs to another workspace")
    target = candidate_source.get("manifest_sha256")
    if not isinstance(target, str) or not runtime_bundle._is_sha256(target):
        raise capsule.HandoffError("Acquisition candidate manifest identity is invalid")
    binding = {**source, "session_id": identity["session_id"],
               "session_epoch": identity["session_epoch"], "target_build_id": target}
    values = (frontend["editor"], frontend["workspace"], frontend["project_document"])
    if acquired["state"] == "no_session":
        reference = semantic.create_empty_workspace_handoff(repo_root, binding, *values)
        original_scene = None
    else:
        original_scene = acquired["scene_document"]
        reference = semantic.create_scene_handoff(repo_root, binding, original_scene, *values)
    loaded = semantic.load_scene_handoff(repo_root, reference["handoff_id"], binding)
    if loaded["snapshot_sha256"] != reference["snapshot_sha256"] or loaded["receipt"]["state"] != "staged":
        raise capsule.HandoffError("Staged acquisition capsule acknowledgement does not match")
    if loaded["source_scene"] != original_scene or any(
        loaded[field] != frontend[field] for field in ("editor", "workspace", "project_document")
    ):
        raise capsule.HandoffError("Staged acquisition capsule changed its authoring payload")
    return {"schema": "fullmag.development-acquisition-handoff.v1",
            "acquisition_nonce": capsule._strict_json(acquisition_bytes, "acquisition")["nonce"],
            "workspace_state": acquired["state"], "binding": binding, "handoff": reference}
