from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Sequence

from fullmag.model import BackendTarget, ExecutionMode, ExecutionPrecision
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.simulation import Simulation


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m fullmag.runtime.helper",
        description="Internal helper for Rust-hosted Fullmag script execution.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    export_ir = subparsers.add_parser("export-ir", help="Load a Python script and print canonical ProblemIR.")
    export_ir.add_argument("--script", required=True, help="Path to Python script.")
    export_ir.add_argument(
        "--backend",
        choices=[target.value for target in BackendTarget],
        default=BackendTarget.AUTO.value,
    )
    export_ir.add_argument(
        "--mode",
        choices=[mode.value for mode in ExecutionMode],
        default=ExecutionMode.STRICT.value,
    )
    export_ir.add_argument(
        "--precision",
        choices=[precision.value for precision in ExecutionPrecision],
        default=ExecutionPrecision.DOUBLE.value,
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.command == "export-ir":
        loaded = load_problem_from_script(Path(args.script))
        simulation = Simulation(
            loaded.problem,
            backend=args.backend,
            mode=args.mode,
            precision=args.precision,
        )
        print(
            json.dumps(
                loaded.to_ir(
                    requested_backend=simulation.backend,
                    execution_mode=simulation.mode,
                    execution_precision=simulation.precision,
                )
            )
        )
        return 0

    parser.error(f"Unsupported helper command: {args.command}")
    return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
