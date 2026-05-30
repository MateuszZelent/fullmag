"""Validate FEM thermal runtime artifact rows.

This script validates CSV artifacts from a stochastic runtime harness. It does
not run the solver; it makes variance and macrospin evidence checkable once
the MFEM runtime produces it.
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path
from typing import Iterable, Sequence

from helpers import (
    ValidationFailure,
    require_boltzmann_macrospin_mean,
    require_inverse_dt_variance_scaling,
    require_variance_matches_reference,
)

VARIANCE_RELATIVE_TOLERANCE = 0.10
INVERSE_DT_RELATIVE_TOLERANCE = 0.10
BOLTZMANN_ABSOLUTE_TOLERANCE = 0.10
NUMERIC_COLUMNS = {
    "dt_s",
    "sample_variance_Apm2",
    "reference_variance_Apm2",
    "m_parallel_mean",
    "ms_Apm",
    "volume_m3",
    "field_Apm",
    "temperature_K",
}


def _parse_cell(key: str, value: str) -> object:
    text = value.strip()
    if key in NUMERIC_COLUMNS:
        return float(text) if text else ""
    return text


def read_csv_rows(path: Path) -> list[dict]:
    """Read thermal runtime validation rows from a CSV artifact."""
    with path.open(newline="") as handle:
        reader = csv.DictReader(handle)
        return [
            {key: _parse_cell(key, value or "") for key, value in row.items()}
            for row in reader
        ]


def _gate(row: dict) -> str:
    value = row.get("gate")
    if not isinstance(value, str) or not value.strip():
        raise ValidationFailure("thermal artifact row is missing gate")
    return value.strip().casefold()


def _rows_for_gate(rows: Sequence[dict], gate: str) -> list[dict]:
    selected = [row for row in rows if _gate(row) == gate]
    if not selected:
        raise ValidationFailure(f"thermal runtime artifact missing {gate} gate rows")
    return selected


def validate_runtime_artifact(rows: Sequence[dict]) -> None:
    """Validate Brown variance and Boltzmann macrospin artifact rows."""
    if not rows:
        raise ValidationFailure("thermal runtime artifact produced no rows")

    variance_rows = _rows_for_gate(rows, "variance")
    require_variance_matches_reference(
        variance_rows,
        variance_key="sample_variance_Apm2",
        reference_key="reference_variance_Apm2",
        relative_tolerance=VARIANCE_RELATIVE_TOLERANCE,
        label_key="case",
    )
    require_inverse_dt_variance_scaling(
        variance_rows,
        dt_key="dt_s",
        variance_key="sample_variance_Apm2",
        relative_tolerance=INVERSE_DT_RELATIVE_TOLERANCE,
    )

    for row in _rows_for_gate(rows, "boltzmann"):
        require_boltzmann_macrospin_mean(
            row,
            mean_key="m_parallel_mean",
            ms_key="ms_Apm",
            volume_key="volume_m3",
            field_key="field_Apm",
            temperature_key="temperature_K",
            absolute_tolerance=BOLTZMANN_ABSOLUTE_TOLERANCE,
            label=str(row.get("case", "boltzmann")),
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
    print(f"PASS: thermal runtime artifact accepted ({args.csv_path})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
