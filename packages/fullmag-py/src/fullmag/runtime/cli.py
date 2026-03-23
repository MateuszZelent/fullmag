from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Sequence

from fullmag._core import run_problem_json
from fullmag.model import BackendTarget, ExecutionMode, ExecutionPrecision
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.simulation import Simulation, result_from_run_payload


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fullmag-python",
        description="Legacy Python-owned launcher kept for direct package use and testing.",
    )
    parser.add_argument("script", help="Path to a Python script exposing build() or problem")
    parser.add_argument(
        "--until",
        type=float,
        required=True,
        help="Simulation stop time in seconds.",
    )
    parser.add_argument(
        "--backend",
        choices=[target.value for target in BackendTarget],
        default=BackendTarget.FDM.value,
        help="Requested backend target.",
    )
    parser.add_argument(
        "--mode",
        choices=[mode.value for mode in ExecutionMode],
        default=ExecutionMode.STRICT.value,
        help="Execution mode.",
    )
    parser.add_argument(
        "--precision",
        choices=[precision.value for precision in ExecutionPrecision],
        default=ExecutionPrecision.DOUBLE.value,
        help="Requested execution precision.",
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
        ir = loaded.to_ir(
            requested_backend=simulation.backend,
            execution_mode=simulation.mode,
            execution_precision=simulation.precision,
        )
        run_payload = run_problem_json(ir, args.until, args.output_dir)
        if run_payload is None:
            print(
                "Native runner (_fullmag_core) is not installed. "
                "Build it with maturin in crates/fullmag-py-core to enable execution.",
                file=sys.stderr,
            )
            return 2

        result = result_from_run_payload(
            run_payload,
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
    if summary["output_dir"]:
        print(f"- output_dir: {summary['output_dir']}")
    for note in summary["notes"]:
        print(f"- note: {note}")


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
