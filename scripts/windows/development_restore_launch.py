"""Prepare a verified capsule for a fresh managed development API process.

This module only joins already-verified authoring and runtime inputs into the
private pre-listener API envelope. It does not launch a process, mutate a
runtime lease, or mark a handoff receipt restored.
"""

from __future__ import annotations

import os
from pathlib import Path
import re
from typing import Any, Mapping

from windows import development_handoff as capsule
from windows import development_scene_handoff
from windows import runtime_bundle


PRELISTEN_RESTORE_SCHEMA = "fullmag.development-prelisten-restore.v1"
STORAGE_PROFILE = "windows-native-fdm-cpu-dev"
_BUILD_ID = re.compile(r"^[A-Za-z0-9.\-+]{1,128}$")
_WORKTREE_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")


def _same_path(left: Path, right: Path) -> bool:
    return os.path.normcase(os.path.abspath(os.fspath(left))) == os.path.normcase(
        os.path.abspath(os.fspath(right))
    )


def _verified_workspace(repo_root: str) -> tuple[dict[str, Any], Path]:
    """Resolve this registered worktree's development runtime without creating it."""
    try:
        layout = capsule._STORAGE.resolve_layout(repo_root, STORAGE_PROFILE)
    except (capsule._STORAGE.StorageError, OSError, TypeError, ValueError) as error:
        raise capsule.HandoffError(f"Cannot resolve development restore workspace: {error}") from error

    # The scene loader checks the storage marker and active worktree registry.
    # Reuse its authority boundary, then ensure it resolved the same roots as
    # the layout used to pin the candidate namespace.
    _, runtime = development_scene_handoff._roots(repo_root)
    expected_store = capsule._validate_runtime_root(layout["storage_root"])
    expected_runtime = capsule._validate_runtime_root(layout["runtime_root"])
    if not _same_path(runtime, expected_runtime):
        raise capsule.HandoffError("Resolved scene handoff runtime differs from the development workspace runtime")
    capsule._contained_path(runtime, expected_store, "resolved development restore runtime")

    worktree_id = layout.get("worktree_id")
    if not isinstance(worktree_id, str) or not _WORKTREE_ID.fullmatch(worktree_id):
        raise capsule.HandoffError("Resolved development worktree identity is invalid")
    return layout, runtime


def prepare_development_restore_launch(
    repo_root: str,
    handoff_id: str,
    expected_binding: Mapping[str, Any],
    candidate_bundle_root: str | os.PathLike[str],
) -> dict[str, Any]:
    """Prepare private restore metadata from a verified capsule and bundle.

    ``expected_binding`` must be supplied by the runtime manager that owns the
    existing API session. It is never read from the UI or inferred from the
    capsule. The capsule's ``target_build_id`` is the watcher build-manifest
    digest; the API envelope's target id is the product version because the
    managed API exposes that value as its current build identity.

    An empty-workspace handoff returns no pre-listener envelope. Its caller
    must still verify that the new API has no session and accept the new API
    pin, restore the UI payload, and only then record a restored receipt.
    """
    layout, runtime_root = _verified_workspace(repo_root)

    # This verifies the caller's binding, capsule hashes/assets and the staged
    # receipt state, then structurally rebases declared paths onto capsule
    # copies. It does not mutate the receipt.
    loaded = development_scene_handoff.load_scene_handoff(
        repo_root, handoff_id, expected_binding
    )

    try:
        manifest, _checks = runtime_bundle.validate_bundle(
            candidate_bundle_root, runtime_root, "dev"
        )
    except (runtime_bundle.BundleError, OSError, TypeError, ValueError) as error:
        raise capsule.HandoffError(f"Development restore candidate failed bundle verification: {error}") from error

    source = manifest.get("source")
    if not isinstance(source, dict):
        raise capsule.HandoffError("Verified development candidate has no source identity")
    if source.get("workspace_namespace") != layout["worktree_id"]:
        raise capsule.HandoffError("Development candidate belongs to a different workspace namespace")

    binding = loaded["binding"]
    if binding["target_build_id"] != source.get("manifest_sha256"):
        raise capsule.HandoffError(
            "Staged handoff target does not match the verified development candidate manifest"
        )

    build_version = source.get("build_version")
    target_build_id = build_version.get("product_version") if isinstance(build_version, dict) else None
    if not isinstance(target_build_id, str) or not _BUILD_ID.fullmatch(target_build_id):
        raise capsule.HandoffError("Verified development candidate has no valid API build identity")
    target_source_sha256 = source.get("backend_source_sha256")
    if not isinstance(target_source_sha256, str) or not runtime_bundle._is_sha256(target_source_sha256):
        raise capsule.HandoffError("Verified development candidate has no valid backend source digest")

    empty_workspace = loaded["schema"] == capsule.EMPTY_WORKSPACE_SCHEMA
    if empty_workspace:
        envelope = None
        workspace_state = "no_session"
    else:
        envelope = {
            "schema": PRELISTEN_RESTORE_SCHEMA,
            "target_build_id": target_build_id,
            "target_source_sha256": target_source_sha256,
            "old_session_id": binding["session_id"],
            "scene_document": loaded["scene"],
        }
        workspace_state = "session"
    return {
        "envelope": envelope,
        "workspace_state": workspace_state,
        "editor": loaded["editor"],
        "workspace": loaded["workspace"],
        "project_document": loaded["project_document"],
        "handoff": {
            "handoff_id": loaded["handoff_id"],
            "snapshot_sha256": loaded["snapshot_sha256"],
        },
        "candidate": {
            "bundle_id": manifest["bundle_id"],
            "bundle_root": str(Path(candidate_bundle_root)),
            "workspace_namespace": source["workspace_namespace"],
            "profile": manifest["profile"],
            "manifest_sha256": source["manifest_sha256"],
            "backend_source_sha256": target_source_sha256,
        },
    }


__all__ = ["PRELISTEN_RESTORE_SCHEMA", "prepare_development_restore_launch"]
