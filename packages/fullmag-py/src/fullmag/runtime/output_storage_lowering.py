"""Normalize storage-backed stage outputs before a plan becomes immutable."""

from __future__ import annotations

import copy
import math
from collections.abc import Mapping
from typing import Any

from fullmag.model.output_storage import OutputStorage


def configure_scene_stage_autosaves(
    stages: object,
    output_storage: object,
    *,
    table_autosave: object = None,
) -> list[dict[str, object]]:
    if not isinstance(stages, list):
        raise ValueError("SceneDocument.study.stages must be a list")
    if output_storage is None:
        return copy.deepcopy(stages)
    storage = _storage(output_storage)
    configured: list[dict[str, object]] = []
    for index, raw_stage in enumerate(stages):
        if not isinstance(raw_stage, Mapping):
            raise ValueError(f"SceneDocument.study.stages[{index}] must be an object")
        configured.append(
            _configure_stage_mapping(
                raw_stage, storage, table_autosave=table_autosave
            )
        )
    return configured


def configure_study_pipeline_autosaves(
    pipeline: object,
    output_storage: object,
    *,
    table_autosave: object = None,
) -> dict[str, object] | None:
    if pipeline is None:
        return None
    if not isinstance(pipeline, Mapping):
        raise ValueError("SceneDocument.study.study_pipeline must be an object")
    result = copy.deepcopy(dict(pipeline))
    if output_storage is None:
        return result
    storage = _storage(output_storage)
    nodes = result.get("nodes")
    if nodes is None:
        return result
    if not isinstance(nodes, list):
        raise ValueError("SceneDocument.study.study_pipeline.nodes must be a list")

    def visit(entries: list[object]) -> None:
        for node in entries:
            if not isinstance(node, dict):
                continue
            if node.get("node_kind") == "group":
                children = node.get("children")
                if isinstance(children, list):
                    visit(children)
                continue
            payload = node.get("payload")
            if isinstance(payload, Mapping):
                node["payload"] = _configure_stage_mapping(
                    payload,
                    storage,
                    stage_kind=node.get("stage_kind"),
                    table_autosave=table_autosave,
                )

    visit(nodes)
    return result


def configure_problem_ir_autosave(
    ir: dict[str, object],
    output_storage: object,
    *,
    until_seconds: float | None,
    output_every_seconds: float | None = None,
) -> None:
    if output_storage is None:
        return
    storage = _storage(output_storage)
    study = ir.get("study")
    if not isinstance(study, dict):
        raise ValueError("ProblemIR.study must be an object")
    sampling = study.get("sampling")
    if not isinstance(sampling, dict):
        raise ValueError("ProblemIR.study.sampling must be an object")
    _configure_sampling(
        study.get("kind"),
        sampling,
        storage,
        until_seconds=until_seconds,
        output_every_seconds=output_every_seconds,
    )


def _storage(value: object) -> OutputStorage:
    if not isinstance(value, Mapping):
        raise ValueError("output_storage must be an object")
    return OutputStorage.from_ir(value)


def _configure_stage_mapping(
    raw_stage: Mapping[str, object],
    storage: OutputStorage,
    *,
    stage_kind: object = None,
    table_autosave: object = None,
) -> dict[str, object]:
    stage = copy.deepcopy(dict(raw_stage))
    kind = str(stage.get("kind") or stage_kind or stage.get("stage_kind") or "").lower()
    sampling = stage.get("sampling")
    if isinstance(sampling, dict):
        sampling = copy.deepcopy(sampling)
        stage["sampling"] = sampling
    else:
        sampling = {}
    stage_table = sampling.get("table_autosave", table_autosave)
    _configure_sampling(
        kind,
        sampling,
        storage,
        until_seconds=_positive_stage_time(stage.get("until_seconds")),
        output_every_seconds=_positive_stage_time(stage.get("output_every_seconds")),
        explicit_autosave=stage.get("autosave"),
        table_autosave=stage_table,
        set_stage_autosave=lambda policy: stage.__setitem__("autosave", policy),
    )
    return stage


def _configure_sampling(
    kind: object,
    sampling: dict[str, object],
    storage: OutputStorage,
    *,
    until_seconds: float | None,
    output_every_seconds: float | None = None,
    explicit_autosave: object = None,
    table_autosave: object = None,
    set_stage_autosave: Any = None,
) -> None:
    policy = explicit_autosave if explicit_autosave is not None else sampling.get("stage_autosave")
    if policy is not None:
        if not isinstance(policy, Mapping):
            raise ValueError("stage autosave policy must be an object")
        stage_format = policy.get("format")
        if stage_format is not None and stage_format != storage.data_format:
            raise ValueError(
                "stage autosave format conflicts with output_storage.data_format"
            )
        normalized = copy.deepcopy(dict(policy))
        if stage_format is None:
            normalized["format"] = storage.data_format
        if table_autosave is not None and normalized.get("table") is None:
            normalized["table"] = copy.deepcopy(table_autosave)
        if normalized != policy:
            if set_stage_autosave is not None:
                set_stage_autosave(normalized)
            else:
                sampling["stage_autosave"] = normalized
        return

    normalized_kind = str(kind or "").lower()
    if normalized_kind in {"relax", "relaxation"}:
        fields: list[dict[str, object]] = [
            {
                "kind": "field_autosave",
                "quantity": "magnetization",
                "every_steps": 100,
            }
        ]
    elif normalized_kind in {"run", "time_evolution", "time-evolution"}:
        fields = _existing_time_fields(sampling)
        if not fields:
            cadence = output_every_seconds or until_seconds
            if cadence is None or cadence <= 0:
                raise ValueError(
                    "time-evolution storage autosave requires a positive output cadence or until_seconds"
                )
            fields = [
                {
                    "kind": "field_autosave",
                    "quantity": "magnetization",
                    "every_seconds": cadence,
                }
            ]
    else:
        return

    autosave: dict[str, object] = {
        "kind": "stage_autosave",
        "target": "results",
        "layout": "separate",
        "format": storage.data_format,
        "table": copy.deepcopy(table_autosave),
        "fields": fields,
    }
    if set_stage_autosave is not None:
        set_stage_autosave(autosave)
    else:
        sampling["stage_autosave"] = autosave


def _existing_time_fields(sampling: Mapping[str, object]) -> list[dict[str, object]]:
    outputs = sampling.get("outputs")
    if not isinstance(outputs, list):
        return []
    fields: list[dict[str, object]] = []
    for output in outputs:
        if not isinstance(output, Mapping):
            continue
        if output.get("kind") not in {"field", "field_auto"}:
            continue
        quantity = output.get("name")
        if not isinstance(quantity, str) or not quantity.strip():
            continue
        field: dict[str, object] = {
            "kind": "field_autosave",
            "quantity": quantity,
        }
        every_seconds = _positive_number(output.get("every_seconds"))
        sample_period_policy = output.get("sample_period_policy")
        if every_seconds is not None:
            field["every_seconds"] = every_seconds
        elif isinstance(sample_period_policy, Mapping):
            field["sample_period_policy"] = copy.deepcopy(dict(sample_period_policy))
        else:
            continue
        fields.append(field)
    return fields


def _positive_stage_time(value: object) -> float | None:
    # Canonical authoring stages retain numeric literals as text, unlike IR.
    if isinstance(value, str):
        try:
            value = float(value)
        except ValueError:
            return None
    return _positive_number(value)


def _positive_number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(float(value)) and value > 0:
        return float(value)
    return None
