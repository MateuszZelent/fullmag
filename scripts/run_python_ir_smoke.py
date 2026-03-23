#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

from fullmag import Simulation, load_problem_from_script

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EXAMPLE = ROOT / "examples" / "exchange_relax.py"


def run_cli(cli_path: Path, command: str, ir_path: Path, *, backend: str | None = None) -> None:
    args = [str(cli_path), command, str(ir_path)]
    if backend is not None:
        args.extend(["--backend", backend])
    subprocess.run(args, cwd=ROOT, check=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cli", required=True)
    parser.add_argument("--script", default=str(DEFAULT_EXAMPLE))
    args = parser.parse_args()

    cli_path = Path(args.cli).resolve()
    loaded = load_problem_from_script(args.script)
    combinations = [
        ("fdm", "strict"),
        ("fem", "strict"),
        ("hybrid", "hybrid"),
    ]

    with tempfile.TemporaryDirectory() as tmp_dir:
        temp_dir = Path(tmp_dir)
        for backend, mode in combinations:
            simulation = Simulation(loaded.problem, backend=backend, mode=mode)
            ir_path = temp_dir / f"{backend}-{mode}.json"
            ir_path.write_text(
                json.dumps(
                    loaded.to_ir(
                        requested_backend=simulation.backend,
                        execution_mode=simulation.mode,
                    ),
                    indent=2,
                ),
                encoding="utf-8",
            )
            run_cli(cli_path, "validate-json", ir_path)
            run_cli(cli_path, "plan-json", ir_path, backend=backend)

    print("Python IR smoke test passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
