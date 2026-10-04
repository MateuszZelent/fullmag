"""Semantic SceneDocument persistence for controlled development restarts."""

from pathlib import Path
from typing import Any, Mapping

from windows import development_handoff as capsule
from windows.development_scene_assets import collect_scene_assets, _rebase_declared_scene_assets, SceneAssetError


def _roots(repo_root: str) -> tuple[Path, Path]:
    try:
        layout = capsule._STORAGE.resolve_layout(repo_root, "windows-native-fdm-cpu-dev")
    except (capsule._STORAGE.StorageError, OSError, ValueError) as error:
        raise capsule.HandoffError(f"Cannot resolve scene handoff storage: {error}") from error
    store = capsule._validate_runtime_root(layout["storage_root"])
    runtime = capsule._validate_runtime_root(layout["runtime_root"])
    capsule._contained_path(runtime, store, "resolved scene handoff runtime")
    # Resolution alone allows an uninitialized default root. Never bootstrap
    # storage or infer ownership while persisting/restoring a user's model.
    marker = capsule._strict_json(
        capsule._read_limited(store / ".fullmag-storage.json", store,
                              "scene handoff storage marker", capsule.MAX_RECEIPT_BYTES),
        "scene handoff storage marker",
    )
    if marker != {"schema": capsule._STORAGE.SCHEMA, "project_root": layout["project_root"]}:
        raise capsule.HandoffError("Scene handoff storage marker belongs to another project or schema")
    registry = capsule._strict_json(
        capsule._read_limited(store / "index" / f"{layout['worktree_id']}.json", store,
                              "scene handoff worktree registry", 1024 * 1024),
        "scene handoff worktree registry",
    )
    if (not isinstance(registry, dict)
            or registry.get("schema") != capsule._STORAGE.SCHEMA
            or registry.get("worktree_id") != layout["worktree_id"]
            or registry.get("repo_root") != layout["repo_root"]
            or not isinstance(registry.get("state"), str)
            or registry["state"] not in {"active", "wip"}
            or any(not isinstance(registry.get(field), str) or not registry[field].strip()
                   for field in ("task_id", "owner"))):
        raise capsule.HandoffError("Scene handoff requires a matching registered active worktree owner")
    return store, runtime


def _verify_prior_asset(runtime: Path, source: Path, digest: str) -> bool:
    """Permit repeated restarts only from an intact prior capsule owned by this root."""
    handoff_root = runtime / capsule.HANDOFF_DIRECTORY
    if not capsule._STORAGE.inside(source, handoff_root):
        return False
    relative = source.relative_to(handoff_root)
    if (len(relative.parts) != 3 or relative.parts[1] != "assets"
            or (source.stem != digest and source.name != digest)):
        raise capsule.HandoffError("Prior handoff reference is not a content-addressed asset")
    prior_id = relative.parts[0]
    snapshot_path = handoff_root / prior_id / "snapshot.json"
    document = capsule._strict_json(
        capsule._read_limited(snapshot_path, runtime, "prior handoff snapshot", capsule.MAX_SNAPSHOT_BYTES),
        "prior handoff snapshot",
    )
    if not isinstance(document, dict) or "binding" not in document:
        raise capsule.HandoffError("Prior handoff snapshot lacks its binding")
    prior = capsule.load_handoff(runtime, prior_id, document["binding"])
    if not any(asset["storage_path"] == str(source) and asset["sha256"] == digest
               for asset in prior["assets"]):
        raise capsule.HandoffError("Prior capsule does not claim the referenced asset")
    return True


def create_scene_handoff(
    repo_root: str,
    binding: Mapping[str, Any],
    scene: dict[str, Any],
    editor: Any,
    workspace: Any,
    project_document: Any,
) -> dict[str, str]:
    """Discover declared scene dependencies and stage their verified bytes.

    All file sources must already be in the configured project storage. This
    boundary neither imports unmanaged files nor shuts down a running process.
    """
    store, runtime = _roots(repo_root)
    capsule._validate_binding(binding)
    scene_copy = capsule._strict_json(
        capsule._canonical_json(scene, "scene handoff document", capsule.MAX_SNAPSHOT_BYTES),
        "scene handoff document",
    )
    try:
        references = collect_scene_assets(scene_copy)
    except SceneAssetError as error:
        raise capsule.HandoffError(str(error)) from error
    assets = []
    prior_ids = set()
    suffixes = {}
    remaining = capsule.MAX_HANDOFF_BYTES - capsule.MAX_SNAPSHOT_BYTES
    for reference in references:
        source = capsule._contained_path(reference["source_path"], store, "scene asset source")
        data = capsule._read_limited(source, store, "scene asset source", remaining)
        if not data:
            raise capsule.HandoffError("Referenced scene assets must not be empty")
        digest = capsule._sha256(data)
        remaining -= len(data)
        del data
        if _verify_prior_asset(runtime, source, digest):
            prior_ids.add(reference["asset_id"])
        suffixes[reference["asset_id"]] = source.suffix.lower()
        assets.append({**reference, "source_path": str(source), "sha256": digest})
    return capsule._stage_handoff(
        runtime, binding, scene_copy, editor, workspace, project_document,
        assets=assets, asset_source_root=store, verified_prior_assets=frozenset(prior_ids),
        capsule_schema=capsule.SCENE_ASSET_SCHEMA, asset_suffixes=suffixes,
    )


def create_empty_workspace_handoff(
    repo_root: str,
    binding: Mapping[str, Any],
    editor: Any,
    workspace: Any,
    project_document: Any,
) -> dict[str, str]:
    """Persist UI and project data for an acquired workspace with no session."""
    store, runtime = _roots(repo_root)
    normalized_binding = capsule._validate_binding(binding, allow_empty_session=True)
    if normalized_binding["session_id"] is not None:
        raise capsule.HandoffError("Empty-workspace handoff must not claim a session identity")
    return capsule._stage_handoff(
        runtime,
        normalized_binding,
        None,
        editor,
        workspace,
        project_document,
        assets=[],
        asset_source_root=store,
        capsule_schema=capsule.EMPTY_WORKSPACE_SCHEMA,
    )


def load_scene_handoff(
    repo_root: str,
    handoff_id: str,
    expected_binding: Mapping[str, Any],
) -> dict[str, Any]:
    """Verify a pending capsule and rebase all declared dependencies on its copies.

    The immutable source scene is retained separately for provenance. Returning
    this payload is not a restore acknowledgement; only the new process owner
    can publish the terminal receipt after installing the scene and listening.
    """
    _, runtime = _roots(repo_root)
    loaded = capsule.load_handoff(runtime, handoff_id, expected_binding)
    if loaded["receipt"]["state"] != "staged":
        raise capsule.HandoffError("Only a staged handoff can be consumed for restoration")
    if loaded["schema"] == capsule.EMPTY_WORKSPACE_SCHEMA:
        if loaded["scene"] is not None or loaded["assets"]:
            raise capsule.HandoffError("Verified empty-workspace handoff contains scene data")
        return {**loaded, "source_scene": None, "scene": None}
    try:
        references = collect_scene_assets(loaded["scene"])
        copied = {asset["asset_id"]: asset for asset in loaded["assets"]}
        for reference in references:
            asset = copied.get(reference["asset_id"])
            if asset is not None and Path(asset["storage_path"]).suffix.lower() != Path(reference["source_path"]).suffix.lower():
                raise capsule.HandoffError("Handoff asset lost its source format suffix; restage the source model")
        restored_scene = _rebase_declared_scene_assets(loaded["scene"], loaded["assets"])
    except SceneAssetError as error:
        raise capsule.HandoffError(str(error)) from error
    return {**loaded, "source_scene": loaded["scene"], "scene": restored_scene}
