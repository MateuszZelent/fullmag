from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Sequence

from fullmag._core import run_problem_json
from fullmag.model import BackendTarget, ExecutionMode, ExecutionPrecision
from fullmag.model.study import Relaxation
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
        default="run_output",
        help="Artifact output directory.",
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
        if loaded.stages:
            aggregate_payload: dict[str, object] = {
                "status": "completed",
                "steps": [],
                "final_magnetization": None,
            }
            final_magnetization = None
            step_offset = 0
            time_offset = 0.0
            base_output_dir = Path(args.output_dir)
            base_output_dir.mkdir(parents=True, exist_ok=True)
            stage_manifest: list[dict[str, object]] = []

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
                )
                if final_magnetization is not None:
                    _apply_continuation_initial_state(ir, final_magnetization)
                stage_output_dir = _stage_output_dir(
                    base_output_dir,
                    stage_index=index,
                    stage_total=len(loaded.stages),
                    entrypoint_kind=stage.entrypoint_kind,
                )
                run_payload = run_problem_json(ir, until_seconds, str(stage_output_dir))
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
                    adjusted["time"] = float(step.get("time", 0.0)) + time_offset
                    offset_steps.append(adjusted)
                aggregate_payload["steps"].extend(offset_steps)
                final_magnetization = run_payload.get("final_magnetization")
                aggregate_payload["final_magnetization"] = final_magnetization
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
        else:
            until_seconds = _resolve_until_seconds(loaded.problem.study, loaded.default_until_seconds)
            if until_seconds is None:
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
            aggregate_payload = run_problem_json(ir, until_seconds, args.output_dir)
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
            output_dir=args.output_dir,
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
        fixed_timestep = study.dynamics.fixed_timestep
        adaptive_timestep = study.dynamics.adaptive_timestep
        initial_timestep = fixed_timestep
        if initial_timestep is None and adaptive_timestep is not None:
            initial_timestep = adaptive_timestep.dt_initial
        return (initial_timestep or 1e-13) * study.max_steps
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


def _stage_output_dir(
    base_output_dir: Path,
    *,
    stage_index: int,
    stage_total: int,
    entrypoint_kind: str,
) -> Path:
    width = max(2, len(str(stage_total)))
    safe_kind = re.sub(r"[^a-z0-9]+", "_", entrypoint_kind.lower()).strip("_") or "stage"
    return base_output_dir / f"stage_{stage_index:0{width}d}_{safe_kind}"


def _write_stage_sequence_manifest(
    base_output_dir: Path,
    stages: list[dict[str, object]],
) -> None:
    manifest_path = base_output_dir / "sequence_manifest.json"
    payload = {
        "kind": "flat_sequence",
        "stages": stages,
    }
    manifest_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


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
