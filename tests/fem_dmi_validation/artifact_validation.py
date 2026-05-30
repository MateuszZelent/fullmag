"""Validate FEM DMI runtime artifact rows.

This script checks CSV artifacts produced by an MFEM runtime sweep. It does not
run the solver; it makes the runtime evidence machine-checkable once produced.
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path
from typing import Iterable, Sequence

from helpers import (
    ValidationFailure,
    require_boundary_tilt_signal,
    require_chirality_matches,
    require_spiral_pitch_matches_reference,
)

SPIRAL_PITCH_RELATIVE_TOLERANCE = 0.15
BOUNDARY_TILT_MIN_ABS_J = 1.0e-21
BOUNDARY_BASELINE_ABS_TOLERANCE_J = 1.0e-23
REQUIRED_GATES = ("chirality", "spiral_pitch", "boundary_tilt")
NUMERIC_COLUMNS = {
    "spiral_pitch_m",
    "reference_spiral_pitch_m",
    "tilted_boundary_derivative_J",
    "uniform_boundary_derivative_J",
}


def _parse_cell(key: str, value: str) -> object:
    text = value.strip()
    if key in NUMERIC_COLUMNS:
        return float(text) if text else ""
    return text


def read_csv_rows(path: Path) -> list[dict]:
    """Read DMI runtime validation rows from a CSV artifact."""
    with path.open(newline="") as handle:
        reader = csv.DictReader(handle)
        return [
            {key: _parse_cell(key, value or "") for key, value in row.items()}
            for row in reader
        ]


def _gate(row: dict) -> str:
    value = row.get("gate")
    if not isinstance(value, str) or not value.strip():
        raise ValidationFailure("DMI artifact row is missing gate")
    return value.strip().casefold()


def _rows_for_gate(rows: Sequence[dict], gate: str) -> list[dict]:
    selected = [row for row in rows if _gate(row) == gate]
    if not selected:
        raise ValidationFailure(f"DMI runtime artifact missing {gate} gate rows")
    return selected


def validate_runtime_artifact(rows: Sequence[dict]) -> None:
    """Validate DMI chirality, spiral-pitch, and boundary-tilt artifact rows."""
    if not rows:
        raise ValidationFailure("DMI runtime artifact produced no rows")

    require_chirality_matches(
        _rows_for_gate(rows, "chirality"),
        label_key="case",
    )
    for row in _rows_for_gate(rows, "spiral_pitch"):
        require_spiral_pitch_matches_reference(
            row,
            pitch_key="spiral_pitch_m",
            reference_key="reference_spiral_pitch_m",
            relative_tolerance=SPIRAL_PITCH_RELATIVE_TOLERANCE,
            label=str(row.get("case", "spiral_pitch")),
        )
    for row in _rows_for_gate(rows, "boundary_tilt"):
        require_boundary_tilt_signal(
            row,
            tilted_key="tilted_boundary_derivative_J",
            baseline_key="uniform_boundary_derivative_J",
            min_tilt_abs=BOUNDARY_TILT_MIN_ABS_J,
            baseline_abs_tolerance=BOUNDARY_BASELINE_ABS_TOLERANCE_J,
            label=str(row.get("case", "boundary_tilt")),
        )


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv_path", type=Path)
    args = parser.parse_args(list(argv) if argv is not None else None)

    try:
        validate_runtime_artifact(read_csv_rows(args.csv_path))
    except ValidationFailure as exc:
        print(f"FAIL: {exc}")
        return 1
    print(f"PASS: DMI runtime artifact accepted ({args.csv_path})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
