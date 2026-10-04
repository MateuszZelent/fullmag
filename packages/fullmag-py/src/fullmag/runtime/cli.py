from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from pathlib import Path
from typing import Sequence

from fullmag._core import extract_fem_mesh_ir, resample_fem_to_fdm_grid, run_problem_json
from fullmag.model import BackendTarget, ExecutionMode, ExecutionPrecision
from fullmag.model.output_storage import OutputStorage
from fullmag.model.study import Eigenmodes, FrequencyResponse, Relaxation
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.simulation import Simulation, result_from_run_payload


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fullmag-python",
        description="Legacy Python-owned launcher kept for direct package use and testing.",
    )
    parser.add_argument(
        "script",
        help="Path to a Python script exposing build(), top-level problem, or flat fm.run()/fm.relax().",
    )
    parser.add_argument(
        "--backend",
        choices=[target.value for target in BackendTarget],
        help="Requested backend target. If omitted, use the script runtime policy.",
    )
    parser.add_argument(
        "--mode",
        choices=[mode.value for mode in ExecutionMode],
        help="Execution mode. If omitted, use the script runtime policy.",
    )
    parser.add_argument(
        "--precision",
        choices=[precision.value for precision in ExecutionPrecision],
        help="Requested execution precision. If omitted, use the script runtime policy.",
    )
    parser.add_argument(
        "--output-dir",
        help="Explicit result directory override; defaults to authored storage or a script-derived sibling.",
    )
    parser.add_argument("--temp-dir", help="Parent directory for private run scratch.")
    parser.add_argument(
        "--data-format",
        choices=("zarr", "hdf5", "h5"),
        help="Override the authored result format.",
    )
    parser.add_argument(
        "--temp-cleanup",
        choices=("on_success", "always", "never"),
        help="Override the private-scratch cleanup policy.",
    )
    parser.add_argument(
        "--existing-output",
        choices=("timestamp", "error"),
        help="Override behavior when the requested result path already exists.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print machine-readable run summary as JSON.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)

    try:
        loaded = load_problem_from_script(Path(args.script))
        simulation = Simulation(
            loaded.problem,
            backend=args.backend,
            mode=args.mode,
            precision=args.precision,
        )
        authored_storage = loaded.problem.runtime_metadata.get("output_storage")
        storage = (
            OutputStorage.from_ir(authored_storage)
            if isinstance(authored_storage, dict)
            else OutputStorage()
        )
        effective_format = args.data_format or storage.data_format
        if args.data_format is None and not isinstance(authored_storage, dict):
            authored_formats = {
                stage.autosave.format
                for stage in loaded.stages
                if stage.autosave is not None and stage.autosave.format in {"zarr", "hdf5"}
            }
            if len(authored_formats) > 1:
                raise ValueError("script stages declare conflicting primary autosave formats")
            if authored_formats:
                effective_format = authored_formats.pop()
        if args.output_dir is not None:
            base_output_dir = Path(args.output_dir).expanduser().absolute()
        elif storage.output_dir is not None:
            authored_output_dir = Path(storage.output_dir).expanduser()
            base_output_dir = (
                authored_output_dir
                if authored_output_dir.is_absolute()
                else (loaded.source_path.parent / authored_output_dir)
            ).absolute()
        else:
            base_output_dir = loaded.source_path.with_suffix(
                ".zarr" if effective_format == "zarr" else ".results"
            )
        if loaded.stages and loaded.auto_execute_stages:
            base_output_dir = _reserve_stage_sequence_root(
                base_output_dir, existing_output=args.existing_output or storage.existing_output,
            )
            if effective_format == "zarr":
                (base_output_dir / ".zgroup").write_text(
                    json.dumps({"zarr_format": 2}), encoding="utf-8"
                )
                (base_output_dir / ".zattrs").write_text(
                    json.dumps({"schema_version": "fullmag.project_results.v1"}),
                    encoding="utf-8",
                )
            aggregate_payload: dict[str, object] = {
                "status": "completed",
                "steps": [],
                "final_magnetization": None,
            }
            final_magnetization = None
            previous_fem_mesh_ir: dict[str, object] | None = None
            step_offset = 0
            time_offset = 0.0
            stage_manifest: list[dict[str, object]] = []
            stage_storage: list[dict[str, object]] = []
            study_pipeline = loaded.study_pipeline_document()

            for index, stage in enumerate(loaded.stages, start=1):
                until_seconds = _resolve_until_seconds(stage.problem.study, stage.default_until_seconds)
                if until_seconds is None:
                    print(
                        "fullmag run failed: no stop time provided. Define DEFAULT_UNTIL in the script "
                        "for time-evolution runs.",
                        file=sys.stderr,
                    )
                    return 2
                ir = stage.to_ir(
                    requested_backend=simulation.backend,
                    execution_mode=simulation.mode,
                    execution_precision=simulation.precision,
                    script_source=loaded.script_source,
                    source_root=loaded.source_path.parent,
                    source_stem=loaded.source_path.stem,
                    until_seconds=until_seconds,
                    study_pipeline=study_pipeline,
                    stage_start_time_s=time_offset,
                )
                if final_magnetization is not None:
                    # Check for cross-backend FEM→FDM state transfer.
                    if previous_fem_mesh_ir is not None:
                        transfer_result = resample_fem_to_fdm_grid(
                            previous_fem_mesh_ir,
                            final_magnetization,
                            ir,
                        )
                        if transfer_result is not None:
                            target_grid = _require_target_grid_identity(transfer_result)
                            print(
                                f"fullmag: FEM→FDM state transfer: "
                                f"{transfer_result['n_located']}/{transfer_result['n_total']} cells "
                                f"interpolated, {transfer_result['n_outside']} outside "
                                f"(grid={target_grid['grid_fingerprint']})",
                                file=sys.stderr,
                            )
                            _apply_continuation_initial_state(ir, transfer_result["values"])
                        else:
                            _apply_continuation_initial_state(ir, final_magnetization)
                    else:
                        _apply_continuation_initial_state(ir, final_magnetization)
                stage_output_dir = (
                    base_output_dir
                    if len(loaded.stages) == 1
                    else _stage_output_dir(
                        base_output_dir,
                        stage_index=index,
                        stage_total=len(loaded.stages),
                        entrypoint_kind=stage.entrypoint_kind,
                        data_format=effective_format,
                    )
                )
                run_payload = run_problem_json(
                    ir,
                    until_seconds,
                    str(stage_output_dir),
                    temp_dir=args.temp_dir,
                    data_format=args.data_format,
                    temp_cleanup=args.temp_cleanup,
                    existing_output=args.existing_output,
                )
                if run_payload is None:
                    print(
                        "Native runner (_fullmag_core) is not installed. "
                        "Build it with maturin in crates/fullmag-py-core to enable execution.",
                        file=sys.stderr,
                    )
                    return 2
                offset_steps = []
                for step in run_payload.get("steps", []):
                    adjusted = dict(step)
                    adjusted["step"] = int(step.get("step", 0)) + step_offset
                    adjusted["time"] = float(step.get("time", 0.0))
                    offset_steps.append(adjusted)
                aggregate_payload["steps"].extend(offset_steps)
                final_magnetization = run_payload.get("final_magnetization")
                aggregate_payload["final_magnetization"] = final_magnetization
                resolved_storage = run_payload.get("resolved_output_storage")
                if isinstance(resolved_storage, dict):
                    stage_storage.append(resolved_storage)
                # Track FEM mesh for potential cross-backend transfer in next stage.
                previous_fem_mesh_ir = extract_fem_mesh_ir(ir)
                stage_manifest.append(
                    {
                        "index": index,
                        "entrypoint_kind": stage.entrypoint_kind,
                        "until_seconds": until_seconds,
                        "output_dir": str(stage_output_dir),
                    }
                )
                if offset_steps:
                    step_offset = int(offset_steps[-1]["step"])
                    time_offset = float(offset_steps[-1]["time"])
            _write_stage_sequence_manifest(base_output_dir, stage_manifest)
            aggregate_payload["output_dir"] = str(base_output_dir)
            aggregate_payload["stage_output_storage"] = stage_storage
        else:
            until_seconds = _resolve_until_seconds(loaded.problem.study, loaded.default_until_seconds)
            if until_seconds is None:
                if loaded.stages and not loaded.auto_execute_stages:
                    print(
                        "fullmag run failed: script declares study stages but does not auto-execute them. "
                        "Use the interactive UI and click Compute, or use imperative fm.run()/fm.relax().",
                        file=sys.stderr,
                    )
                    return 2
                print(
                    "fullmag run failed: no stop time provided. Define DEFAULT_UNTIL in the script "
                    "for time-evolution runs.",
                    file=sys.stderr,
                )
                return 2
            ir = loaded.to_ir(
                requested_backend=simulation.backend,
                execution_mode=simulation.mode,
                execution_precision=simulation.precision,
            )
            aggregate_payload = run_problem_json(
                ir,
                until_seconds,
                args.output_dir,
                temp_dir=args.temp_dir,
                data_format=args.data_format,
                temp_cleanup=args.temp_cleanup,
                existing_output=args.existing_output,
            )
            if aggregate_payload is None:
                print(
                    "Native runner (_fullmag_core) is not installed. "
                    "Build it with maturin in crates/fullmag-py-core to enable execution.",
                    file=sys.stderr,
                )
                return 2

        result = result_from_run_payload(
            aggregate_payload,
            backend=simulation.backend,
            mode=simulation.mode,
            precision=simulation.precision,
            output_dir=(
                aggregate_payload.get("output_dir")
                if isinstance(aggregate_payload.get("output_dir"), str)
                else (
                    aggregate_payload.get("resolved_output_storage", {}).get("output_dir")
                    if isinstance(aggregate_payload.get("resolved_output_storage"), dict)
                    else args.output_dir
                )
            ),
        )
    except Exception as exc:
        print(f"fullmag run failed: {exc}", file=sys.stderr)
        return 1

    summary = build_summary(
        script_path=str(loaded.source_path),
        problem_name=loaded.problem.name,
        result=result,
    )
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print_human_summary(summary)

    return 0 if result.status == "completed" else 1


def _resolve_until_seconds(study, default_until_seconds: float | None) -> float | None:
    if default_until_seconds is not None:
        return default_until_seconds
    if isinstance(study, Relaxation):
        if study.max_physical_time_s is not None:
            return study.max_physical_time_s
        if study.max_pseudotime_s is not None:
            return study.max_pseudotime_s
        return float("inf")
    if isinstance(study, (Eigenmodes, FrequencyResponse)):
        return 0.0
    return None


def _apply_continuation_initial_state(ir: dict[str, object], final_magnetization) -> None:
    magnets = ir.get("magnets")
    if not isinstance(magnets, list) or len(magnets) != 1:
        raise RuntimeError(
            "multi-stage flat scripts currently require exactly one magnet"
        )
    magnets[0]["initial_magnetization"] = {
        "kind": "sampled_field",
        "values": final_magnetization,
    }


def _require_target_grid_identity(
    transfer_result: dict[str, object],
) -> dict[str, object]:
    target_grid = transfer_result.get("target_grid")
    if not isinstance(target_grid, dict):
        raise RuntimeError(
            "FEM→FDM state transfer requires canonical target grid identity from the native bridge"
        )
    origin = target_grid.get("origin_m")
    counts = target_grid.get("counts")
    cell = target_grid.get("cell_m")
    fingerprint = target_grid.get("grid_fingerprint")
    valid_origin = (
        isinstance(origin, list)
        and len(origin) == 3
        and all(isinstance(value, (int, float)) and math.isfinite(value) for value in origin)
    )
    valid_counts = (
        isinstance(counts, list)
        and len(counts) == 3
        and all(isinstance(value, int) and value > 0 for value in counts)
    )
    valid_cell = (
        isinstance(cell, list)
        and len(cell) == 3
        and all(
            isinstance(value, (int, float)) and math.isfinite(value) and value > 0
            for value in cell
        )
    )
    valid_fingerprint = isinstance(fingerprint, str) and len(fingerprint) == 64
    if not (valid_origin and valid_counts and valid_cell and valid_fingerprint):
        raise RuntimeError(
            "FEM→FDM state transfer received invalid canonical target grid identity"
        )
    return target_grid


def _reserve_stage_sequence_root(base: Path, *, existing_output: str) -> Path:
    """Reserve a fresh sequence root without changing an earlier project's files."""
    if existing_output not in {"timestamp", "error"}:
        raise ValueError("existing_output must be 'timestamp' or 'error'")
    if ".." in base.parts:
        raise ValueError("output path must not contain '..' components")
    base = base.expanduser().absolute()
    # Check the original path before resolving it: a junction must not hide
    # another project's ownership. Each stage performs the native lease checks.
    for ancestor in (base, *base.parents):
        try:
            attributes = ancestor.lstat()
        except FileNotFoundError:
            continue
        if ancestor.is_symlink() or getattr(attributes, "st_file_attributes", 0) & 0x400:
            raise ValueError(f"output path contains a link/reparse point: {ancestor}")
    base.parent.mkdir(parents=True, exist_ok=True)
    suffix = ".zarr" if base.name.endswith(".zarr") else ""
    stem = base.name[:-len(suffix)] if suffix else base.name
    run_id = f"py-sequence-{time.time_ns()}-{os.getpid()}"
    candidate = base
    for attempt in range(100):
        try:
            candidate.mkdir(exist_ok=False)
            return candidate
        except FileExistsError:
            if existing_output == "error":
                raise FileExistsError(f"result location already exists: {candidate}") from None
            candidate = base.parent / f"{stem}-{run_id}-{attempt}{suffix}"
    raise FileExistsError("unable to reserve a fresh sequence root after 100 attempts")


def _stage_output_dir(
    base_output_dir: Path,
    *,
    stage_index: int,
    stage_total: int,
    entrypoint_kind: str,
    data_format: str,
) -> Path:
    width = max(2, len(str(stage_total)))
    safe_kind = re.sub(r"[^a-z0-9]+", "_", entrypoint_kind.lower()).strip("_") or "stage"
    suffix = ".zarr" if data_format == "zarr" else ".results"
    return base_output_dir / f"stage_{stage_index:0{width}d}_{safe_kind}{suffix}"


def _write_stage_sequence_manifest(
    base_output_dir: Path,
    stages: list[dict[str, object]],
) -> None:
    manifest_path = base_output_dir / "sequence_manifest.json"
    payload = {
        "kind": "flat_sequence",
        "stages": stages,
    }
    with manifest_path.open("x", encoding="utf-8") as manifest_file:
        manifest_file.write(json.dumps(payload, indent=2))


def build_summary(*, script_path: str, problem_name: str, result) -> dict[str, object]:
    final_step = result.steps[-1] if result.steps else None
    return {
        "script_path": script_path,
        "problem_name": problem_name,
        "status": result.status,
        "backend": result.backend.value,
        "mode": result.mode.value,
        "precision": result.precision.value,
        "total_steps": len(result.steps),
        "final_time": final_step.time if final_step is not None else None,
        "final_E_ex": final_step.e_ex if final_step is not None else None,
        "final_E_demag": final_step.e_demag if final_step is not None else None,
        "final_E_ext": final_step.e_ext if final_step is not None else None,
        "final_E_total": final_step.e_total if final_step is not None else None,
        "output_dir": result.output_dir,
        "notes": list(result.notes),
    }


def print_human_summary(summary: dict[str, object]) -> None:
    print("fullmag run summary")
    print(f"- script: {summary['script_path']}")
    print(f"- problem: {summary['problem_name']}")
    print(
        f"- execution: backend={summary['backend']} mode={summary['mode']} "
        f"precision={summary['precision']}"
    )
    print(f"- status: {summary['status']}")
    print(f"- total_steps: {summary['total_steps']}")
    if summary["final_time"] is not None:
        print(f"- final_time: {summary['final_time']:.6e} s")
    if summary["final_E_ex"] is not None:
        print(f"- final_E_ex: {summary['final_E_ex']:.6e} J")
    if summary["final_E_demag"] is not None:
        print(f"- final_E_demag: {summary['final_E_demag']:.6e} J")
    if summary["final_E_ext"] is not None:
        print(f"- final_E_ext: {summary['final_E_ext']:.6e} J")
    if summary["final_E_total"] is not None:
        print(f"- final_E_total: {summary['final_E_total']:.6e} J")
    if summary["output_dir"]:
        print(f"- output_dir: {summary['output_dir']}")
    for note in summary["notes"]:
        print(f"- note: {note}")


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
