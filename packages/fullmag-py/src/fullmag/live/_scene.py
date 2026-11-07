"""Scene snapshots of the live world and their translation into transactions.

The live mode reuses the canonical converters of ``fullmag script.py``
(``export_builder_draft`` and ``build_scene_document_from_builder``), so a
scene built cell by cell is the same document the capture path would produce
for the same definitions (ADR 0068 D1/D2, spec §5.2).
"""
from __future__ import annotations

import copy
from pathlib import Path
from typing import Any, Mapping, Optional

__all__ = ["SceneNotReady", "build_world_scene", "plan_transactions", "merge_patch_diff"]

# Keys that belong to the editor or the server, not to the authored model.
_IGNORED_TOP_LEVEL = frozenset({"revision", "editor"})
_MISSING = object()
# Fields of MaterialPropertiesPatchRequest (crates/fullmag-api, apply_material_patch_to_asset).
_PATCHABLE_MATERIAL_PROPERTIES = frozenset({"Ms", "Aex", "alpha", "Dind", "Dbulk"})


class SceneNotReady(Exception):
    """The world cannot yet be lowered to a scene (e.g. a magnet without ``Ms``)."""


def build_world_scene(source_path: Path) -> dict[str, Any]:
    """Lower the current flat-script world to a SceneDocument without running anything."""
    from fullmag import world
    from fullmag.runtime.loader import LoadedProblem, LoadedStage
    from fullmag.runtime.scene_document import build_scene_document_from_builder
    from fullmag.runtime.script_builder import export_builder_draft

    state = world._state
    if not (state._magnets or state._auxiliary_geometries):
        raise SceneNotReady("no geometry defined yet")
    try:
        problem = world._build_problem()
    except ValueError as error:
        raise SceneNotReady(str(error)) from error
    stages = tuple(
        LoadedStage(
            problem=stage.problem,
            entrypoint_kind=stage.entrypoint_kind,
            default_until_seconds=stage.default_until_seconds,
            action=stage.action,
            stage_id=stage.stage_id,
        )
        for stage in state._live_stages
    )
    if stages:
        # Actions issued so far, authored like the stages `fullmag script.py` captures.
        loaded = LoadedProblem(
            problem=stages[-1].problem,
            source_path=source_path,
            script_source="",
            entrypoint_kind="flat_sequence" if len(stages) > 1 else stages[-1].entrypoint_kind,
            default_until_seconds=stages[-1].default_until_seconds,
            stages=stages,
            workspace_problem=problem,
            auto_execute_stages=True,
        )
    else:
        loaded = LoadedProblem(
            problem=problem,
            source_path=source_path,
            script_source="",
            entrypoint_kind="flat_workspace",
            workspace_problem=problem,
        )
    scene = build_scene_document_from_builder(export_builder_draft(loaded))
    _trim_pipeline_run_payloads(scene)
    return scene


# The server's run primitive accepts only its duration; solver, sampling and
# autosave are configured on the study (validate_pipeline_run_primitive_payload
# in fullmag-application). The shared Python exporter still emits the full
# stage draft for run nodes, so the live scene keeps only the accepted keys.
_PIPELINE_RUN_PAYLOAD_KEYS = (
    "interactive_session_requested",
    "wait_for_solve",
    "kind",
    "entrypoint_kind",
    "stage_id",
    "until_seconds",
    "output_every_seconds",
    "autosave",
)


def _trim_pipeline_run_payloads(scene: dict[str, Any]) -> None:
    pipeline = scene.get("study", {}).get("study_pipeline")
    if not isinstance(pipeline, dict):
        return
    for node in pipeline.get("nodes") or []:
        payload = node.get("payload")
        if node.get("stage_kind") == "run" and isinstance(payload, dict):
            node["payload"] = {key: payload[key] for key in _PIPELINE_RUN_PAYLOAD_KEYS if key in payload}


def merge_patch_diff(before: Any, after: Any) -> Any:
    """Return the RFC 7386 merge patch turning ``before`` into ``after``.

    Arrays and scalars are replaced wholesale; removed object keys become ``null``.
    Returns :data:`_MISSING` when nothing changed.
    """
    if isinstance(before, Mapping) and isinstance(after, Mapping):
        patch: dict[str, Any] = {}
        for key in before.keys() - after.keys():
            patch[key] = None
        for key, value in after.items():
            if key not in before:
                patch[key] = copy.deepcopy(value)
                continue
            child = merge_patch_diff(before[key], value)
            if child is not _MISSING:
                patch[key] = child
        return patch if patch else _MISSING
    if before == after and type(before) is type(after):
        return _MISSING
    if after is None:
        # A merge patch cannot set a value to null inside an object; replace the parent instead.
        raise _NullValue()
    return copy.deepcopy(after)


class _NullValue(Exception):
    pass


def plan_transactions(
    before: Optional[Mapping[str, Any]],
    after: Mapping[str, Any],
    base_revision: Optional[int],
) -> list[dict[str, Any]]:
    """Translate a scene change into the authoring transactions to commit, in order.

    * no previous baseline: one ``replace_scene`` (attaching to the session);
    * only one material's ``properties`` changed: ``patch_material`` (keeps the
      server's interfacial/bulk DMI synchronisation);
    * a changed ``study.execution_profile``: ``assign_study_execution``, which
      the server requires instead of a recursive merge;
    * anything else: one ``merge_patch`` with the RFC 7386 difference.
    """
    authored_after = _authored(after)
    if before is None:
        return [_with_revision({"kind": "replace_scene", "scene": dict(after)}, base_revision)]
    authored_before = _authored(before)
    if authored_before == authored_after:
        return []
    material = _single_material_property_patch(authored_before, authored_after)
    if material is not None:
        return [_with_revision(material, base_revision)]
    transactions: list[dict[str, Any]] = []
    before_profile = (authored_before.get("study") or {}).get("execution_profile")
    after_profile = (authored_after.get("study") or {}).get("execution_profile")
    if before_profile != after_profile and after_profile is not None:
        transactions.append(
            {
                "kind": "assign_study_execution",
                "execution_profile": after_profile,
                "execution_layers": (authored_after.get("study") or {}).get("execution_layers") or [],
            }
        )
        authored_before = copy.deepcopy(authored_before)
        authored_before.setdefault("study", {})["execution_profile"] = after_profile
        if "execution_layers" in (authored_after.get("study") or {}):
            authored_before["study"]["execution_layers"] = authored_after["study"]["execution_layers"]
    try:
        patch = merge_patch_diff(authored_before, authored_after)
    except _NullValue:
        return [_with_revision({"kind": "replace_scene", "scene": dict(after)}, base_revision)]
    if patch is not _MISSING:
        transactions.append({"kind": "merge_patch", "merge_patch": patch})
    if transactions:
        # Only the first transaction can name a known base; later ones chain on the server.
        transactions[0] = _with_revision(transactions[0], base_revision)
    return transactions


def _authored(scene: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in scene.items() if key not in _IGNORED_TOP_LEVEL}


def _with_revision(transaction: dict[str, Any], base_revision: Optional[int]) -> dict[str, Any]:
    if base_revision is not None:
        transaction["base_revision"] = base_revision
    return transaction


def _single_material_property_patch(before: Mapping[str, Any], after: Mapping[str, Any]) -> Optional[dict[str, Any]]:
    changed = [key for key in before.keys() | after.keys() if before.get(key) != after.get(key)]
    if changed != ["materials"]:
        return None
    old = {item.get("id"): item for item in before.get("materials") or []}
    new = {item.get("id"): item for item in after.get("materials") or []}
    if old.keys() != new.keys():
        return None
    diffs = [identifier for identifier in new if old[identifier] != new[identifier]]
    if len(diffs) != 1:
        return None
    identifier = diffs[0]
    old_item, new_item = old[identifier], new[identifier]
    if {k for k in old_item.keys() | new_item.keys() if old_item.get(k) != new_item.get(k)} != {"properties"}:
        return None
    old_props, new_props = old_item.get("properties") or {}, new_item.get("properties") or {}
    if old_props.keys() != new_props.keys():
        return None
    patch = {key: value for key, value in new_props.items() if old_props.get(key) != value}
    if not patch.keys() <= _PATCHABLE_MATERIAL_PROPERTIES:
        return None
    if any(value is None for value in patch.values()):
        # Clearing a property is not expressible as a material patch.
        return None
    return {"kind": "patch_material", "material_id": identifier, "patch": {"properties": patch}}
