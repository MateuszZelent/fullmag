"""Lower an authored SceneDocument through the canonical Python DSL to ProblemIR."""

from __future__ import annotations

import copy
from dataclasses import replace
import tempfile
from pathlib import Path
from typing import Mapping

from fullmag.model import BackendTarget, ExecutionMode, ExecutionPrecision
from fullmag.model.constraints import FrozenSpins
from fullmag.model.selection import SelectionDefinition
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.script_builder import render_scene_document_as_script

_SCENE_DOCUMENT_FIELDS = frozenset(
    {
        "version",
        "revision",
        "scene",
        "universe",
        "objects",
        "materials",
        "magnetization_assets",
        "current_modules",
        "current_transports",
        "couplings",
        "field_drives",
        "monitors",
        "study",
        "outputs",
        "editor",
        "selections",
        "magnetization_constraints",
        "spin_torques",
        "spin_transports",
        "oersted_fields",
        # Read-only compatibility input accepted by the existing builder.
        "oersted_terms",
    }
)
_STUDY_FIELDS = frozenset(
    {
        "backend",
        "requested_backend",
        "requested_device",
        "requested_precision",
        "requested_mode",
        "requested_cpu_threads",
        "fem_demag_solver_policy",
        "exchange_enabled",
        "demag_enabled",
        "demag_realization",
        "fdm",
        "external_field",
        "rotated_interfacial_dmi",
        "solver",
        "universe_mesh",
        "shared_domain_mesh",
        "mesh_defaults",
        "mesh_interfaces",
        "stages",
        "study_pipeline",
        "table_autosave",
        "initial_state",
    }
)
_TABLE_AUTOSAVE_FIELDS = frozenset(
    {
        "kind",
        "table_id",
        "sample_period_s",
        "sample_period_policy",
        "resolved_sample_period_s",
        "every_steps",
        "quantities",
        "expressions",
    }
)


def scene_document_to_problem_ir(
    scene_document: Mapping[str, object],
    *,
    requested_backend: str,
    requested_device: str,
    requested_precision: str,
    requested_mode: str,
    source_root: str | Path | None = None,
) -> dict[str, object]:
    """Return the canonical ProblemIR for one captured SceneDocument.

    The generated script is deterministic and is loaded through the same public
    Python DSL path as user-authored scripts.  The SceneDocument remains the
    source of physical authoring; the separately captured execution request
    supplies the requested runtime policy.  Geometry assets are deliberately
    omitted here because preparation owns their independent producer receipts.
    """

    if not isinstance(scene_document, Mapping):
        raise TypeError("SceneDocument must be a JSON object")
    scene = dict(scene_document)
    _reject_unlowered_scene_fields(scene)

    device = str(requested_device).strip().lower()
    if device not in {"auto", "cpu", "gpu"}:
        raise ValueError("requested_device must be 'auto', 'cpu', or 'gpu'")

    study = scene.get("study")
    if not isinstance(study, dict):
        study = {}
    else:
        study = dict(study)
    backend = BackendTarget(requested_backend)
    mode = ExecutionMode(requested_mode)
    precision = ExecutionPrecision(requested_precision)
    study["backend"] = backend.value
    study["requested_backend"] = backend.value
    study["requested_device"] = device
    study["requested_precision"] = precision.value
    study["requested_mode"] = mode.value
    scene["study"] = study

    script_source = render_scene_document_as_script(scene)
    with tempfile.TemporaryDirectory(prefix="fullmag-scene-problem-ir-") as temporary:
        script_path = Path(temporary) / "scene_document.py"
        script_path.write_text(script_source, encoding="utf-8")
        loaded = load_problem_from_script(script_path, lightweight_assets=True)

        selections = scene.get("selections", [])
        if not isinstance(selections, list):
            raise ValueError("SceneDocument.selections must be a list")
        constraints = scene.get("magnetization_constraints", [])
        if not isinstance(constraints, list):
            raise ValueError("SceneDocument.magnetization_constraints must be a list")

        typed_selections = tuple(SelectionDefinition.from_ir(item) for item in selections)
        typed_constraints = tuple(FrozenSpins.from_ir(item) for item in constraints)
        study_pipeline = study.get("study_pipeline")
        if study_pipeline is not None and not isinstance(study_pipeline, Mapping):
            raise ValueError("SceneDocument.study.study_pipeline must be an object")

        def attach_scene_semantics(problem):
            runtime_metadata = dict(problem.runtime_metadata)
            if isinstance(study_pipeline, Mapping):
                pipeline = copy.deepcopy(dict(study_pipeline))
                runtime_metadata["study_pipeline"] = pipeline
                if (
                    runtime_metadata.get("interactive_session_requested") is True
                    and _has_enabled_study_pipeline_node(pipeline.get("nodes"))
                ):
                    # The public DSL raises this gate when an executable stage is
                    # authored in an interactive session. SceneDocument already
                    # stores the canonical pipeline, although its bootstrap script
                    # only materializes the typed Problem needed by the writer.
                    runtime_metadata["wait_for_solve"] = True
            return replace(
                problem,
                runtime_metadata=runtime_metadata,
                selections=typed_selections,
                magnetization_constraints=typed_constraints,
            )

        loaded = replace(
            loaded,
            problem=attach_scene_semantics(loaded.problem),
            workspace_problem=(
                attach_scene_semantics(loaded.workspace_problem)
                if loaded.workspace_problem is not None
                else None
            ),
        )
        return loaded.to_ir(
            requested_backend=backend,
            execution_mode=mode,
            execution_precision=precision,
            include_geometry_assets=False,
            runtime_device_override=device if device in {"cpu", "gpu"} else None,
            source_root=source_root,
        )


def _has_enabled_study_pipeline_node(nodes: object) -> bool:
    if not isinstance(nodes, list):
        return False
    for node in nodes:
        if not isinstance(node, Mapping) or node.get("enabled", True) is False:
            continue
        if node.get("node_kind") == "group":
            if _has_enabled_study_pipeline_node(node.get("children")):
                return True
        elif node.get("node_kind") in {"primitive", "macro"}:
            return True
    return False


def _reject_unlowered_scene_fields(scene: Mapping[str, object]) -> None:
    version = scene.get("version", "scene.v2")
    if version != "scene.v2":
        raise ValueError(
            f"scene_document_version_not_supported: expected scene.v2, got {version!r}"
        )

    unknown_scene_fields = set(scene) - _SCENE_DOCUMENT_FIELDS
    if unknown_scene_fields:
        names = ", ".join(sorted(str(name) for name in unknown_scene_fields))
        raise ValueError(f"scene_document_unlowered_fields: {names}")

    outputs = scene.get("outputs")
    if outputs is not None and not isinstance(outputs, Mapping):
        raise ValueError("SceneDocument.outputs must be an object")
    if isinstance(outputs, Mapping):
        unknown_output_fields = set(outputs) - {"items"}
        if unknown_output_fields:
            names = ", ".join(sorted(str(name) for name in unknown_output_fields))
            raise ValueError(f"scene_document_unlowered_output_fields: {names}")
        items = outputs.get("items", [])
        if not isinstance(items, list):
            raise ValueError("SceneDocument.outputs.items must be a list")
        if items:
            raise ValueError("scene_document_outputs_not_supported: outputs.items")

    study = scene.get("study")
    if study is not None and not isinstance(study, Mapping):
        raise ValueError("SceneDocument.study must be an object")
    if isinstance(study, Mapping):
        unknown_study_fields = set(study) - _STUDY_FIELDS
        if unknown_study_fields:
            names = ", ".join(sorted(str(name) for name in unknown_study_fields))
            raise ValueError(f"scene_document_unlowered_study_fields: {names}")

        mesh_interfaces = study.get("mesh_interfaces", [])
        if not isinstance(mesh_interfaces, list):
            raise ValueError("SceneDocument.study.mesh_interfaces must be a list")
        if mesh_interfaces:
            raise ValueError(
                "scene_document_mesh_interfaces_not_supported: "
                "study.mesh_interfaces cannot be lowered to canonical Python yet"
            )

        table_autosave = study.get("table_autosave")
        if table_autosave is not None:
            if not isinstance(table_autosave, Mapping):
                raise ValueError("SceneDocument.study.table_autosave must be an object")
            unknown_table_fields = set(table_autosave) - _TABLE_AUTOSAVE_FIELDS
            if unknown_table_fields:
                names = ", ".join(sorted(str(name) for name in unknown_table_fields))
                raise ValueError(f"scene_document_unlowered_table_autosave_fields: {names}")
            if table_autosave.get("kind", "table_autosave") != "table_autosave":
                raise ValueError("scene_document_table_autosave_kind_not_supported")
            table_id = table_autosave.get("table_id", "default")
            if not isinstance(table_id, str) or not table_id.strip():
                raise ValueError("SceneDocument.study.table_autosave.table_id must be non-empty")

            every_steps = table_autosave.get("every_steps")
            sample_period = table_autosave.get("sample_period_s")
            sample_policy = table_autosave.get("sample_period_policy")
            requested_cadences = sum(
                value is not None
                for value in (every_steps, sample_period, sample_policy)
            )
            if requested_cadences != 1:
                raise ValueError(
                    "SceneDocument.study.table_autosave must declare exactly one "
                    "requested cadence"
                )
            if every_steps is not None and (
                isinstance(every_steps, bool)
                or not isinstance(every_steps, int)
                or every_steps <= 0
            ):
                raise ValueError(
                    "SceneDocument.study.table_autosave.every_steps must be a positive integer"
                )
            for key in ("quantities", "expressions"):
                values = table_autosave.get(key)
                if values is not None and (
                    not isinstance(values, list)
                    or any(not isinstance(value, str) for value in values)
                ):
                    raise ValueError(
                        f"SceneDocument.study.table_autosave.{key} must be a list of strings"
                    )

    if isinstance(study, Mapping):
        declared_universe = scene.get("universe")
        study_universe = study.get("universe_mesh")
        if (
            declared_universe is not None
            and study_universe is not None
            and declared_universe != study_universe
        ):
            raise ValueError(
                "scene_document_universe_conflict: universe and study.universe_mesh differ"
            )

    objects = scene.get("objects", [])
    if not isinstance(objects, list):
        raise ValueError("SceneDocument.objects must be a list")
    for index, raw_object in enumerate(objects):
        if not isinstance(raw_object, Mapping):
            raise ValueError(f"SceneDocument.objects[{index}] must be an object")
        if raw_object.get("region_overrides"):
            object_id = raw_object.get("id", index)
            raise ValueError(
                "scene_document_legacy_region_overrides_not_supported: "
                f"object {object_id!r} must be migrated to authored object regions"
            )


__all__ = ["scene_document_to_problem_ir"]
