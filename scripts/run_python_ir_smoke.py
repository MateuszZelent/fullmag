#!/usr/bin/env python3
"""Smoke test: serialize ProblemIR from Python, validate and plan via CLI.

Also tests the run-json command for the exchange-only executable example.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

from fullmag import Simulation, load_problem_from_script

ROOT = Path(__file__).resolve().parents[1]
EXECUTABLE_EXAMPLE = ROOT / "examples" / "exchange_relax.py"
SEMANTIC_EXAMPLE = ROOT / "examples" / "dw_track.py"


def run_cli(cli_path: Path, command: str, *extra_args: str) -> None:
    args = [str(cli_path), command, *extra_args]
    subprocess.run(args, cwd=ROOT, check=True)


def smoke_validate_and_plan(cli_path: Path, script: Path, combinations: list[tuple[str, str]]) -> None:
    """Validate and plan an IR for each backend/mode combination."""
    loaded = load_problem_from_script(script)

    with tempfile.TemporaryDirectory() as tmp_dir:
        temp_dir = Path(tmp_dir)
        for backend, mode in combinations:
            simulation = Simulation(loaded.problem, backend=backend, mode=mode)
            ir_path = temp_dir / f"{backend}-{mode}.json"
            ir_path.write_text(
                json.dumps(simulation.to_ir(), indent=2),
                encoding="utf-8",
            )
            run_cli(cli_path, "validate-json", str(ir_path))
            run_cli(cli_path, "plan-json", str(ir_path), "--backend", backend)
            print(f"  ✓ {script.name} [{backend}/{mode}] validate + plan")


def smoke_run_json(cli_path: Path, script: Path) -> None:
    """Run the exchange_relax example end-to-end via CLI run-json."""
    loaded = load_problem_from_script(script)
    simulation = Simulation(loaded.problem, backend="fdm", mode="strict")

    with tempfile.TemporaryDirectory() as tmp_dir:
        temp_dir = Path(tmp_dir)
        ir_path = temp_dir / "exchange_relax.json"
        ir_path.write_text(
            json.dumps(simulation.to_ir(), indent=2),
            encoding="utf-8",
        )
        output_dir = temp_dir / "artifacts"
        run_cli(
            cli_path,
            "run-json",
            str(ir_path),
            "--until", "1e-12",
            "--output-dir", str(output_dir),
        )

        # Verify artifacts were created
        metadata = output_dir / "metadata.json"
        scalars = output_dir / "scalars.csv"
        m_final = output_dir / "m_final.json"

        for artifact in [metadata, scalars, m_final]:
            if not artifact.exists():
                raise AssertionError(f"Missing artifact: {artifact.name}")

        print(f"  ✓ {script.name} [fdm/strict] run-json → artifacts")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cli", required=True, help="Path to fullmag CLI binary")
    parser.add_argument("--skip-run", action="store_true", help="Skip run-json test")
    args = parser.parse_args()

    cli_path = Path(args.cli).resolve()

    # 1. Semantic-only example: validate + plan for all backends
    print("Smoke: semantic-only example (dw_track.py)")
    smoke_validate_and_plan(
        cli_path,
        SEMANTIC_EXAMPLE,
        [("fdm", "strict"), ("fem", "strict"), ("hybrid", "hybrid")],
    )

    # 2. Executable example: validate + plan for FDM only
    print("Smoke: executable example (exchange_relax.py)")
    smoke_validate_and_plan(
        cli_path,
        EXECUTABLE_EXAMPLE,
        [("fdm", "strict")],
    )

    # 3. End-to-end run-json test
    if not args.skip_run:
        print("Smoke: run-json end-to-end")
        smoke_run_json(cli_path, EXECUTABLE_EXAMPLE)

    print("Python IR smoke test passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
