from __future__ import annotations

import importlib.util
import math
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from uuid import uuid4

from fullmag.model import Problem


@dataclass(frozen=True, slots=True)
class LoadedStage:
    problem: Problem
    entrypoint_kind: str
    default_until_seconds: float | None = None
    action: dict[str, object] | None = None
    stage_id: str | None = None
    output_every_seconds: float | None = None

    def to_ir(
        self,
        *,
        requested_backend,
        execution_mode,
        execution_precision,
        script_source: str,
        source_root: str | Path | None = None,
        asset_cache: dict[str, dict[str, object] | None] | None = None,
        include_geometry_assets: bool = True,
        study_pipeline: dict[str, object] | None = None,
        runtime_device_override: str | None = None,
        stage_start_time_s: float = 0.0,
    ) -> dict[str, object]:
        ir = self.problem.to_ir(
            requested_backend=requested_backend,
            execution_mode=execution_mode,
            execution_precision=execution_precision,
            script_source=script_source,
            source_root=source_root,
            entrypoint_kind=self.entrypoint_kind,
            asset_cache=asset_cache,
            include_geometry_assets=include_geometry_assets,
            study_pipeline=study_pipeline,
        )
        if self.stage_id is not None:
            runtime_metadata = ir.get("problem_meta", {}).get("runtime_metadata")
            if not isinstance(runtime_metadata, dict):
                raise ValueError("ProblemIR problem_meta.runtime_metadata must be an object")
            runtime_metadata["active_stage_id"] = self.stage_id
            if (
                not isinstance(stage_start_time_s, (int, float))
                or not math.isfinite(float(stage_start_time_s))
                or float(stage_start_time_s) < 0.0
            ):
                raise ValueError("stage_start_time_s must be finite and non-negative")
            runtime_metadata["stage_start_time_s"] = float(stage_start_time_s)
        if runtime_device_override is not None:
            apply_ir_runtime_device_override(ir, runtime_device_override)
        return ir


def apply_ir_runtime_device_override(ir: dict[str, object], device: str) -> None:
    problem_meta = ir.get("problem_meta")
    if not isinstance(problem_meta, dict):
        return
    runtime_metadata = problem_meta.get("runtime_metadata")
    if not isinstance(runtime_metadata, dict):
        return
    for runtime in _runtime_metadata_runtime_maps(runtime_metadata):
        runtime["device"] = device
        if device == "cpu":
            runtime["gpu_count"] = 0
            runtime["device_index"] = None
        elif device.startswith("cuda"):
            runtime["gpu_count"] = max(int(runtime.get("gpu_count") or 0), 1)
            runtime["device_index"] = _cuda_device_index(device)


def _runtime_metadata_runtime_maps(
    runtime_metadata: dict[str, object],
) -> tuple[dict[str, object], ...]:
    runtime_maps: list[dict[str, object]] = []
    runtime_selection = runtime_metadata.get("runtime_selection")
    if isinstance(runtime_selection, dict):
        runtime_maps.append(runtime_selection)
    model_builder = runtime_metadata.get("model_builder")
    if isinstance(model_builder, dict):
        problem = model_builder.get("problem")
        if isinstance(problem, dict):
            runtime = problem.get("runtime")
            if isinstance(runtime, dict):
                runtime_maps.append(runtime)
    return tuple(runtime_maps)


def _cuda_device_index(device: str) -> int | None:
    if not device.startswith("cuda:"):
        return None
    _, raw_index = device.split(":", 1)
    try:
        return int(raw_index)
    except ValueError:
        return None


@dataclass(frozen=True, slots=True)
class LoadedProblem:
    problem: Problem
    source_path: Path
    script_source: str
    entrypoint_kind: str
    default_until_seconds: float | None = None
    stages: tuple[LoadedStage, ...] = ()
    workspace_problem: Problem | None = None
    auto_execute_stages: bool = False

    def study_pipeline_document(self) -> dict[str, object] | None:
        from fullmag.runtime.script_builder import export_study_pipeline_document

        return export_study_pipeline_document(self)

    def to_ir(
        self,
        *,
        requested_backend,
        execution_mode,
        execution_precision,
        asset_cache: dict[str, dict[str, object] | None] | None = None,
        include_geometry_assets: bool = True,
    ) -> dict[str, object]:
        study_pipeline = self.study_pipeline_document()
        ir = self.problem.to_ir(
            requested_backend=requested_backend,
            execution_mode=execution_mode,
            execution_precision=execution_precision,
            script_source=self.script_source,
            source_root=self.source_path.parent,
            entrypoint_kind=self.entrypoint_kind,
            asset_cache=asset_cache,
            include_geometry_assets=include_geometry_assets,
            study_pipeline=study_pipeline,
        )
        if self.workspace_problem is None or self.workspace_problem == self.problem:
            return ir

        workspace_ir = self.workspace_problem.to_ir(
            requested_backend=requested_backend,
            execution_mode=execution_mode,
            execution_precision=execution_precision,
            script_source=self.script_source,
            source_root=self.source_path.parent,
            entrypoint_kind="flat_workspace",
            asset_cache=asset_cache,
            include_geometry_assets=False,
            study_pipeline=study_pipeline,
        )
        runtime_metadata = ir["problem_meta"]["runtime_metadata"]
        workspace_runtime_metadata = workspace_ir["problem_meta"]["runtime_metadata"]
        for key in ("model_builder", "script_sync", "domain_frame", "study_pipeline"):
            if key in workspace_runtime_metadata:
                runtime_metadata[key] = workspace_runtime_metadata[key]
        return ir


def load_problem_from_script(
    path: str | Path,
    *,
    lightweight_assets: bool = False,
) -> LoadedProblem:
    import fullmag.world as world

    source_path = Path(path).resolve()
    spec = importlib.util.spec_from_file_location(f"fullmag_user_script_{uuid4().hex}", source_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load script from {source_path}")

    module = importlib.util.module_from_spec(spec)
    world.begin_script_capture(source_path.parent)
    world.set_script_capture_lightweight_assets(lightweight_assets)
    try:
        spec.loader.exec_module(module)
        script_source = source_path.read_text(encoding="utf-8")
        workspace_problem = world.capture_workspace_problem()
        declared_stages = world.capture_declared_stages()
        captured_stages = world.finish_script_capture()
        if captured_stages:
            loaded_stages = tuple(
                LoadedStage(
                    problem=stage.problem,
                    entrypoint_kind=stage.entrypoint_kind,
                    default_until_seconds=stage.default_until_seconds,
                    action=stage.action,
                    stage_id=stage.stage_id,
                    output_every_seconds=stage.output_every_seconds,
                )
                for stage in captured_stages
            )
            final_stage = loaded_stages[-1]
            return LoadedProblem(
                problem=final_stage.problem,
                source_path=source_path,
                script_source=script_source,
                entrypoint_kind="flat_sequence" if len(loaded_stages) > 1 else final_stage.entrypoint_kind,
                default_until_seconds=final_stage.default_until_seconds,
                stages=loaded_stages,
                workspace_problem=workspace_problem,
                auto_execute_stages=True,
            )

        if declared_stages and workspace_problem is not None:
            loaded_stages = tuple(
                LoadedStage(
                    problem=stage.problem,
                    entrypoint_kind=stage.entrypoint_kind,
                    default_until_seconds=stage.default_until_seconds,
                    action=stage.action,
                    stage_id=stage.stage_id,
                    output_every_seconds=stage.output_every_seconds,
                )
                for stage in declared_stages
            )
            return LoadedProblem(
                problem=workspace_problem,
                source_path=source_path,
                script_source=script_source,
                entrypoint_kind="flat_workspace",
                default_until_seconds=None,
                stages=loaded_stages,
                workspace_problem=workspace_problem,
                auto_execute_stages=False,
            )

        if workspace_problem is not None:
            return LoadedProblem(
                problem=workspace_problem,
                source_path=source_path,
                script_source=script_source,
                entrypoint_kind="flat_workspace",
                default_until_seconds=None,
                stages=(),
                workspace_problem=workspace_problem,
            )

        problem, entrypoint_kind = _extract_problem(module)
        return LoadedProblem(
            problem=problem,
            source_path=source_path,
            script_source=script_source,
            entrypoint_kind=entrypoint_kind,
            default_until_seconds=_extract_default_until(module),
            stages=(),
        )
    finally:
        world.finish_script_capture()


def _extract_problem(module: ModuleType) -> tuple[Problem, str]:
    build = getattr(module, "build", None)
    if callable(build):
        problem = build()
        if not isinstance(problem, Problem):
            raise TypeError("build() must return a fullmag.Problem instance")
        return problem, "build"

    problem = getattr(module, "problem", None)
    if isinstance(problem, Problem):
        return problem, "problem"

    raise RuntimeError(
        "Script must define build() -> Problem, a top-level problem, or use flat fm.run()/fm.relax()"
    )


def _extract_default_until(module: ModuleType) -> float | None:
    for attr_name in ("DEFAULT_UNTIL", "default_until"):
        value = getattr(module, attr_name, None)
        if value is None:
            continue
        if not isinstance(value, (int, float)):
            raise TypeError(f"{attr_name} must be a positive number if defined")
        value = float(value)
        if value <= 0.0:
            raise ValueError(f"{attr_name} must be positive if defined")
        return value
    return None
