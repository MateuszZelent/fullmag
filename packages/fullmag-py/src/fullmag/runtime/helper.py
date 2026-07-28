from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
from typing import Sequence

from fullmag._progress import emit_progress
from fullmag.model import BackendTarget, ExecutionMode, ExecutionPrecision
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.scene_document import (
    build_builder_from_scene_document,
    build_scene_document_from_builder,
    builder_overrides_from_scene_document,
)
from fullmag.runtime.script_builder import export_builder_draft, rewrite_loaded_problem_script


def _write_executed_problem_ir_identity(problem_ir: dict[str, object]) -> None:
    output = os.environ.get("FULLMAG_BENCH_EXECUTED_PROBLEM_IR_SHA256_FILE")
    if output is None:
        return
    canonical_bytes = json.dumps(
        problem_ir,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    problem_ir_sha256 = hashlib.sha256(canonical_bytes).hexdigest()
    path = Path(output)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(problem_ir_sha256 + "\n", encoding="ascii")
    os.replace(temporary, path)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m fullmag.runtime.helper",
        description="Internal helper for Rust-hosted Fullmag script execution.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    check_syntax = subparsers.add_parser(
        "check-syntax",
        help="Validate that a Python script is syntactically correct without executing it.",
    )
    check_syntax.add_argument("--script", required=True, help="Path to Python script.")

    export_ir = subparsers.add_parser("export-ir", help="Load a Python script and print canonical ProblemIR.")
    export_ir.add_argument("--script", required=True, help="Path to Python script.")
    export_ir.add_argument(
        "--backend",
        choices=[target.value for target in BackendTarget],
    )
    export_ir.add_argument(
        "--mode",
        choices=[mode.value for mode in ExecutionMode],
    )
    export_ir.add_argument(
        "--precision",
        choices=[precision.value for precision in ExecutionPrecision],
    )

    export_run_config = subparsers.add_parser(
        "export-run-config",
        help="Load a Python script and print canonical ProblemIR plus script-owned run defaults.",
    )
    export_run_config.add_argument("--script", required=True, help="Path to Python script.")
    export_run_config.add_argument(
        "--backend",
        choices=[target.value for target in BackendTarget],
    )
    export_run_config.add_argument(
        "--mode",
        choices=[mode.value for mode in ExecutionMode],
    )
    export_run_config.add_argument(
        "--precision",
        choices=[precision.value for precision in ExecutionPrecision],
    )
    export_run_config.add_argument(
        "--runtime-device",
        choices=["cpu", "gpu"],
        help="Explicit execution-device override supplied by the managed runtime launcher.",
    )
    export_run_config.add_argument(
        "--skip-geometry-assets",
        action="store_true",
        help="Export a lightweight IR without materializing geometry assets.",
    )

    rewrite_script = subparsers.add_parser(
        "rewrite-script",
        help="Render a canonical Python script from the model builder and optionally write it in place.",
    )
    rewrite_script.add_argument("--script", required=True, help="Path to Python script.")
    rewrite_script.add_argument(
        "--overrides-json",
        help="Path to a JSON file with UI-side builder overrides.",
    )
    rewrite_script.add_argument(
        "--write",
        action="store_true",
        help="Write the canonical script back to the original path.",
    )

    export_builder = subparsers.add_parser(
        "export-builder-draft",
        help="Load a script and export session-local builder draft state for the control room.",
    )
    export_builder.add_argument("--script", required=True, help="Path to Python script.")

    export_scene = subparsers.add_parser(
        "export-scene-document",
        help="Load a script and export the canonical SceneDocument authoring state.",
    )
    export_scene.add_argument("--script", required=True, help="Path to Python script.")

    rewrite_scene = subparsers.add_parser(
        "rewrite-scene-document",
        help="Render canonical Python from a SceneDocument and optionally write it in place.",
    )
    rewrite_scene.add_argument("--script", required=True, help="Path to Python script.")
    rewrite_scene.add_argument("--scene-json", required=True, help="Path to SceneDocument JSON.")
    rewrite_scene.add_argument(
        "--write",
        action="store_true",
        help="Write the canonical script back to the original path.",
    )

    read_state = subparsers.add_parser(
        "read-magnetization-state",
        help="Load a magnetization state file and print canonical JSON values.",
    )
    read_state.add_argument("--path", required=True, help="Path to the input state file.")
    read_state.add_argument("--format", default="auto", help="Input format: auto, json, zarr, or h5.")
    read_state.add_argument("--dataset", help="Optional dataset path for zarr/h5 inputs.")
    read_state.add_argument("--sample", type=int, default=-1, help="Sample index for [T,N,3] inputs.")

    convert_state = subparsers.add_parser(
        "convert-magnetization-state",
        help="Convert a magnetization state file between supported formats.",
    )
    convert_state.add_argument("--input-path", required=True, help="Path to the input state file.")
    convert_state.add_argument("--output-path", required=True, help="Path to the output state file.")
    convert_state.add_argument("--input-format", default="auto", help="Input format: auto, json, zarr, or h5.")
    convert_state.add_argument("--output-format", default="auto", help="Output format: auto, json, zarr, or h5.")
    convert_state.add_argument("--input-dataset", help="Optional dataset path for zarr/h5 inputs.")
    convert_state.add_argument("--output-dataset", default="values", help="Dataset path for zarr/h5 outputs.")
    convert_state.add_argument("--sample", type=int, default=-1, help="Sample index for [T,N,3] inputs.")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.command == "check-syntax":
        script_path = Path(args.script)
        source = script_path.read_text(encoding="utf-8")
        compile(source, str(script_path), "exec")
        print(json.dumps({"status": "ok", "script": str(script_path.resolve())}))
        return 0

    if args.command in {"export-ir", "export-run-config"}:
        emit_progress(f"Loading Python script {Path(args.script).name}")
        loaded = load_problem_from_script(
            Path(args.script),
            lightweight_assets=getattr(args, "skip_geometry_assets", False),
        )
        study_pipeline = loaded.study_pipeline_document()
        asset_cache = loaded.problem.geometry_asset_cache
        requested_backend = BackendTarget(args.backend) if args.backend is not None else None
        execution_mode = ExecutionMode(args.mode) if args.mode is not None else None
        execution_precision = (
            ExecutionPrecision(args.precision) if args.precision is not None else None
        )
        emit_progress("Building ProblemIR and realizing geometry assets")
        ir = loaded.to_ir(
            requested_backend=requested_backend,
            execution_mode=execution_mode,
            execution_precision=execution_precision,
            asset_cache=asset_cache,
            include_geometry_assets=not getattr(args, "skip_geometry_assets", False),
            runtime_device_override=getattr(args, "runtime_device", None),
        )
        _write_executed_problem_ir_identity(ir)
        shared_geometry_assets = copy.deepcopy(ir.get("geometry_assets"))
        if loaded.stages and shared_geometry_assets is not None:
            ir = copy.deepcopy(ir)
            ir["geometry_assets"] = None
        if args.command == "export-ir":
            print(json.dumps(ir))
            return 0

        stages = []
        device_override: str | None = None
        stage_start_time_s = 0.0
        for stage in loaded.stages or ():
            action_device = _change_device_action_device(stage.action)
            stage_device_override = (
                getattr(args, "runtime_device", None) or action_device or device_override
            )
            stage_ir = stage.to_ir(
                requested_backend=requested_backend,
                execution_mode=execution_mode,
                execution_precision=execution_precision,
                script_source=loaded.script_source,
                source_root=loaded.source_path.parent,
                asset_cache=asset_cache,
                include_geometry_assets=not getattr(args, "skip_geometry_assets", False),
                study_pipeline=study_pipeline,
                runtime_device_override=stage_device_override,
                stage_start_time_s=stage_start_time_s,
            )
            if action_device is not None:
                device_override = action_device
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

        print(
            json.dumps(
                {
                    "ir": ir,
                    "shared_geometry_assets": shared_geometry_assets,
                    "default_until_seconds": loaded.default_until_seconds,
                    "study_pipeline": study_pipeline,
                    "stages": stages,
                }
            )
        )
        emit_progress("Run configuration exported")
        return 0

    if args.command == "rewrite-script":
        emit_progress(f"Loading Python script {Path(args.script).name}")
        loaded = load_problem_from_script(Path(args.script), lightweight_assets=True)
        overrides = None
        if args.overrides_json:
            overrides = json.loads(Path(args.overrides_json).read_text(encoding="utf-8"))
        emit_progress("Rendering canonical Python from model builder")
        print(
            json.dumps(
                rewrite_loaded_problem_script(
                    loaded,
                    overrides=overrides,
                    write=bool(args.write),
                )
            )
        )
        emit_progress("Canonical script rewrite completed")
        return 0

    if args.command == "export-builder-draft":
        emit_progress(f"Loading Python script {Path(args.script).name}")
        loaded = load_problem_from_script(Path(args.script), lightweight_assets=True)
        print(json.dumps(export_builder_draft(loaded)))
        emit_progress("Builder draft exported")
        return 0

    if args.command == "export-scene-document":
        emit_progress(f"Loading Python script {Path(args.script).name}")
        loaded = load_problem_from_script(Path(args.script), lightweight_assets=True)
        print(json.dumps(build_scene_document_from_builder(export_builder_draft(loaded))))
        emit_progress("Scene document exported")
        return 0

    if args.command == "rewrite-scene-document":
        emit_progress(f"Loading Python script {Path(args.script).name}")
        loaded = load_problem_from_script(Path(args.script), lightweight_assets=True)
        scene_document = json.loads(Path(args.scene_json).read_text(encoding="utf-8"))
        _ = build_builder_from_scene_document(scene_document)
        emit_progress("Rendering canonical Python from SceneDocument")
        print(
            json.dumps(
                rewrite_loaded_problem_script(
                    loaded,
                    overrides=builder_overrides_from_scene_document(scene_document),
                    write=bool(args.write),
                )
            )
        )
        emit_progress("SceneDocument rewrite completed")
        return 0

    if args.command == "read-magnetization-state":
        from fullmag.init import load_magnetization

        state = load_magnetization(
            args.path,
            format=args.format,
            dataset=args.dataset,
            sample=args.sample,
        )
        print(
            json.dumps(
                {
                    "path": str(Path(args.path).resolve()),
                    "format": state.source_format or args.format,
                    "dataset": state.dataset,
                    "sample_index": state.sample_index,
                    "vector_count": len(state.values),
                    "values": [list(vector) for vector in state.values],
                }
            )
        )
        return 0

    if args.command == "convert-magnetization-state":
        from fullmag.init import convert_magnetization_state, load_magnetization

        output_path = convert_magnetization_state(
            args.input_path,
            args.output_path,
            input_format=args.input_format,
            output_format=args.output_format,
            input_dataset=args.input_dataset,
            output_dataset=args.output_dataset,
            sample=args.sample,
        )
        state = load_magnetization(
            output_path,
            format=args.output_format,
            dataset=args.output_dataset if args.output_format in {"zarr", "h5"} else None,
            sample=-1,
        )
        print(
            json.dumps(
                {
                    "output_path": str(Path(output_path).resolve()),
                    "format": state.source_format or args.output_format,
                    "dataset": state.dataset,
                    "vector_count": len(state.values),
                }
            )
        )
        return 0

    parser.error(f"Unsupported helper command: {args.command}")
    return 2


def _compact_stage_ir(
    ir: dict[str, object],
    *,
    shared_geometry_assets: object,
) -> dict[str, object]:
    compacted = copy.deepcopy(ir)
    if shared_geometry_assets is not None and compacted.get("geometry_assets") == shared_geometry_assets:
        compacted["geometry_assets"] = None
    return compacted


def _change_device_action_device(action: dict[str, object] | None) -> str | None:
    if not isinstance(action, dict) or action.get("kind") != "change_device":
        return None
    device = action.get("device")
    return device if isinstance(device, str) else None


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
