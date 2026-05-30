"""Validate FEM demag residual and phase-timing telemetry artifacts."""

from __future__ import annotations

import argparse
import csv
from pathlib import Path
from typing import Iterable, Sequence

from helpers import ValidationFailure, require_solver_telemetry

NUMERIC_COLUMNS = {
    "demag_linear_iterations",
    "demag_linear_residual",
    "demag_wall_time_ns",
    "demag_assemble_wall_time_ns",
    "demag_solve_wall_time_ns",
    "demag_recover_wall_time_ns",
    "demag_energy_wall_time_ns",
}


def _parse_cell(key: str, value: str) -> object:
    text = value.strip()
    if key in NUMERIC_COLUMNS:
        return float(text) if text else ""
    return text


def read_csv_rows(path: Path) -> list[dict]:
    """Read demag telemetry validation rows from a CSV artifact."""
    with path.open(newline="") as handle:
        reader = csv.DictReader(handle)
        return [
            {key: _parse_cell(key, value or "") for key, value in row.items()}
            for row in reader
        ]


def validate_runtime_artifact(rows: Sequence[dict]) -> None:
    """Validate demag residual, iteration, and phase-timing telemetry rows."""
    require_solver_telemetry(rows, label_key="case")


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv_path", type=Path)
    args = parser.parse_args(list(argv) if argv is not None else None)

    try:
        validate_runtime_artifact(read_csv_rows(args.csv_path))
    except ValidationFailure as exc:
        print(f"FAIL: {exc}")
        return 1
    print(f"PASS: demag telemetry artifact accepted ({args.csv_path})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
