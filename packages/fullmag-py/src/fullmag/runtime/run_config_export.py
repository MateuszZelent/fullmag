"""Build the canonical Python-side run configuration without executing it."""

from __future__ import annotations

import copy
from dataclasses import dataclass
from pathlib import Path

from fullmag.model import BackendTarget, ExecutionMode, ExecutionPrecision
from fullmag.runtime.loader import LoadedProblem, apply_ir_runtime_device_selection


@dataclass(frozen=True, slots=True)
class RunConfigExportOptions:
    """Execution and source options captured before serializing one run config."""

    requested_backend: BackendTarget | None = None
    execution_mode: ExecutionMode | None = None
    execution_precision: ExecutionPrecision | None = None
    runtime_device_override: str | None = None
    include_geometry_assets: bool = True
    source_root: Path | None = None
    source_stem: str | None = None
    study_pipeline: dict[str, object] | None = None


def export_run_config(
    loaded: LoadedProblem,
    ir: dict[str, object],
    *,
    options: RunConfigExportOptions,
) -> dict[str, object]:
    """Serialize one captured base IR and its canonical, ordered stage IRs.

    The caller owns loading and constructing the base IR. Each actual loaded
    stage is lowered once with the same execution and source options. No stage
    is inferred by cloning the base IR, and this function never starts a solver
    or writes result files.
    """

    if not isinstance(options, RunConfigExportOptions):
        raise TypeError("options must be RunConfigExportOptions")

    study_pipeline = (
        options.study_pipeline
        if options.study_pipeline is not None
        else loaded.study_pipeline_document()
    )
    asset_cache = loaded.problem.geometry_asset_cache
    source_root = options.source_root or loaded.source_path.parent
    source_stem = options.source_stem or loaded.source_path.stem

    ir, shared_geometry_assets = _prepare_run_config_geometry_assets(
        ir,
        has_stages=bool(loaded.stages),
    )
    requires_analytic_fdm_transport = _requires_analytic_fdm_transport_grid(ir)
    if requires_analytic_fdm_transport:
        # Solved-current FDM transport requires a common charge/spin grid;
        # a magnet-only FDM asset cannot represent its auxiliary domain.
        ir["geometry_assets"] = None
        shared_geometry_assets = None

    stages: list[dict[str, object]] = []
    script_device_override: str | None = None
    stage_start_time_s = 0.0
    for stage in loaded.stages or ():
        action_device = _change_device_action_device(stage.action)
        stage_ir = stage.to_ir(
            requested_backend=options.requested_backend,
            execution_mode=options.execution_mode,
            execution_precision=options.execution_precision,
            script_source=loaded.script_source,
            source_root=source_root,
            source_stem=source_stem,
            until_seconds=stage.default_until_seconds,
            asset_cache=asset_cache,
            include_geometry_assets=(
                options.include_geometry_assets
                and not requires_analytic_fdm_transport
            ),
            study_pipeline=study_pipeline,
            runtime_device_override=options.runtime_device_override,
            stage_start_time_s=stage_start_time_s,
            _copy_cached_geometry_assets=False,
        )
        authored_stage_device = action_device or script_device_override
        if authored_stage_device is not None:
            apply_ir_runtime_device_selection(stage_ir, authored_stage_device)
        if action_device is not None:
            script_device_override = action_device

        stages.append(
            {
                "ir": _compact_stage_ir(
                    stage_ir,
                    shared_geometry_assets=shared_geometry_assets,
                ),
                "default_until_seconds": stage.default_until_seconds,
                "entrypoint_kind": stage.entrypoint_kind,
                "action": stage.action,
            }
        )
        if stage.default_until_seconds is not None:
            stage_start_time_s += stage.default_until_seconds

    return {
        "ir": ir,
        "shared_geometry_assets": shared_geometry_assets,
        "default_until_seconds": loaded.default_until_seconds,
        "study_pipeline": study_pipeline,
        "stages": stages,
    }


def _compact_stage_ir(
    ir: dict[str, object],
    *,
    shared_geometry_assets: object,
) -> dict[str, object]:
    detached = dict(ir)
    if _geometry_assets_semantically_equal(
        detached.get("geometry_assets"),
        shared_geometry_assets,
    ):
        detached["geometry_assets"] = None
    return copy.deepcopy(detached)


def _prepare_run_config_geometry_assets(
    ir: dict[str, object],
    *,
    has_stages: bool,
) -> tuple[dict[str, object], object]:
    """Keep one asset owner unless compacted stage IRs need a shared copy."""
    if not has_stages:
        return ir, None

    shared_geometry_assets = ir.get("geometry_assets")
    if shared_geometry_assets is None:
        return ir, None

    detached_root = dict(ir)
    detached_root["geometry_assets"] = None
    return copy.deepcopy(detached_root), shared_geometry_assets


def _geometry_assets_semantically_equal(left: object, right: object) -> bool:
    if left is right:
        return True
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(
            _geometry_assets_semantically_equal(left[key], right[key])
            for key in left
        )
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(
            _geometry_assets_semantically_equal(left_value, right_value)
            for left_value, right_value in zip(left, right, strict=True)
        )
    if type(left) is not type(right):
        return False
    if left is None or isinstance(left, (bool, int, float, str)):
        return left == right
    return False


def _requires_analytic_fdm_transport_grid(ir: dict[str, object]) -> bool:
    """Return whether FDM transport must rebuild a common analytic grid."""
    problem_meta = ir.get("problem_meta")
    runtime_metadata = (
        problem_meta.get("runtime_metadata") if isinstance(problem_meta, dict) else None
    )
    runtime_selection = (
        runtime_metadata.get("runtime_selection")
        if isinstance(runtime_metadata, dict)
        else None
    )
    if (
        not isinstance(runtime_selection, dict)
        or runtime_selection.get("backend") != "fdm"
    ):
        return False
    graph = ir.get("physics_graph")
    modules = graph.get("modules") if isinstance(graph, dict) else None
    if not isinstance(modules, list):
        return False
    return any(
        isinstance(module, dict)
        and module.get("kind") == "spin_transport"
        and module.get("activation") == "active"
        for module in modules
    )


def _change_device_action_device(action: dict[str, object] | None) -> str | None:
    if not isinstance(action, dict) or action.get("kind") != "change_device":
        return None
    device = action.get("device")
    return device if isinstance(device, str) else None


__all__ = [
    "RunConfigExportOptions",
    "export_run_config",
    "_change_device_action_device",
    "_compact_stage_ir",
    "_geometry_assets_semantically_equal",
    "_prepare_run_config_geometry_assets",
    "_requires_analytic_fdm_transport_grid",
]
