"""Parse and compare scalar Fullmag and MuMax3 tables for the sinc-layer case."""

from __future__ import annotations

import argparse
import csv
import json
import math
from bisect import bisect_left
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping, Sequence


MAGNETIZATION_COLUMNS = ("mx", "my", "mz")
FULLMAG_ENERGY_COLUMNS = (
    "e_ex",
    "e_demag",
    "e_ext",
    "e_drive",
    "e_ani",
    "e_dmi",
    "e_total",
)
MUMAX_ENERGY_COLUMNS = ("e_ex", "e_demag", "e_zeeman", "e_ani", "e_total")
COMPARABLE_ENERGY_COLUMNS = ("e_ex", "e_demag", "e_ani", "e_total", "e_external_total")
FIELD_SNAPSHOT_SUFFIXES = {".npy", ".npz", ".ovf", ".zarr", ".h5", ".hdf5"}
FIELD_SNAPSHOT_NAMES = {
    "m",
    "m.npy",
    "m.npz",
    "m.ovf",
    "magnetization",
    "magnetization.npy",
    "magnetization.npz",
    "magnetization.ovf",
}


@dataclass(frozen=True, slots=True)
class ScalarTable:
    backend: str
    source: Path
    columns: tuple[str, ...]
    rows: tuple[dict[str, float], ...]
    native_columns: tuple[str, ...]

    @property
    def first_time_s(self) -> float:
        return self.rows[0]["time_s"]

    @property
    def last_time_s(self) -> float:
        return self.rows[-1]["time_s"]


def _canonical_header(raw: str) -> str:
    token = raw.strip().lstrip("#").strip().split()[0]
    lowered = token.lower()
    aliases = {
        "t": "time_s",
        "time": "time_s",
        "step": "step",
        "mx": "mx",
        "my": "my",
        "mz": "mz",
        "e_ex": "e_ex",
        "e_exch": "e_ex",
        "e_exchange": "e_ex",
        "e_demag": "e_demag",
        "e_ext": "e_ext",
        "e_external": "e_ext",
        "e_drive": "e_drive",
        "e_ani": "e_ani",
        "e_anis": "e_ani",
        "e_dmi": "e_dmi",
        "e_zeeman": "e_zeeman",
        "e_total": "e_total",
    }
    return aliases.get(lowered, lowered)


def _read_float(raw: str, *, path: Path, line_number: int, column: str) -> float:
    try:
        value = float(raw.strip())
    except ValueError as exc:
        raise ValueError(
            f"{path}: line {line_number}: column {column!r} is not numeric: {raw!r}"
        ) from exc
    if not math.isfinite(value):
        raise ValueError(
            f"{path}: line {line_number}: column {column!r} is not finite"
        )
    return value


def _validate_rows(
    *,
    path: Path,
    backend: str,
    rows: Sequence[dict[str, float]],
    columns: Sequence[str],
    required: Iterable[str],
) -> ScalarTable:
    missing = [column for column in required if column not in columns]
    if missing:
        raise ValueError(
            f"{path}: {backend} scalar table is missing required columns: {', '.join(missing)}"
        )
    if not rows:
        raise ValueError(f"{path}: {backend} scalar table contains no data rows")
    previous_time = -math.inf
    for index, row in enumerate(rows, start=1):
        time_s = row["time_s"]
        if time_s < previous_time:
            raise ValueError(f"{path}: time is not monotonic at data row {index}")
        previous_time = time_s
    return ScalarTable(
        backend=backend,
        source=path,
        columns=tuple(columns),
        rows=tuple(dict(row) for row in rows),
        native_columns=tuple(columns),
    )


def _reject_field_table_path(path: Path) -> None:
    if path.name.lower() in FIELD_SNAPSHOT_NAMES or path.suffix.lower() in FIELD_SNAPSHOT_SUFFIXES:
        raise ValueError(f"field snapshot path is not a scalar table: {path}")


def parse_fullmag_scalars(path: str | Path) -> ScalarTable:
    path = Path(path)
    _reject_field_table_path(path)
    if not path.is_file():
        raise ValueError(f"Fullmag scalar table does not exist: {path}")
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise ValueError(f"{path}: Fullmag scalar table has no header")
        source_headers = tuple(reader.fieldnames)
        canonical_headers = tuple(_canonical_header(header) for header in source_headers)
        if len(set(canonical_headers)) != len(canonical_headers):
            raise ValueError(f"{path}: Fullmag scalar table has duplicate canonical columns")
        rows: list[dict[str, float]] = []
        for line_number, raw_row in enumerate(reader, start=2):
            row = {
                canonical: _read_float(
                    raw_row[source],
                    path=path,
                    line_number=line_number,
                    column=canonical,
                )
                for source, canonical in zip(source_headers, canonical_headers)
                if raw_row[source] is not None and raw_row[source].strip() != ""
            }
            if row:
                rows.append(row)
    return _validate_rows(
        path=path,
        backend="fdm_or_fem",
        rows=rows,
        columns=canonical_headers,
        required=("time_s", *MAGNETIZATION_COLUMNS, *FULLMAG_ENERGY_COLUMNS),
    )


def _split_mumax_line(line: str) -> list[str]:
    if "\t" in line:
        return [part.strip() for part in line.strip().split("\t")]
    return line.strip().split()


def parse_mumax_table(path: str | Path) -> ScalarTable:
    path = Path(path)
    _reject_field_table_path(path)
    if not path.is_file():
        raise ValueError(f"MuMax3 table does not exist: {path}")
    header: list[str] | None = None
    data_lines: list[tuple[int, list[str]]] = []
    with path.open(encoding="utf-8-sig") as handle:
        for line_number, raw_line in enumerate(handle, start=1):
            stripped = raw_line.strip()
            if not stripped:
                continue
            if stripped.startswith("#"):
                candidate = stripped[1:].strip()
                if header is None and candidate:
                    header = _split_mumax_line(candidate)
                continue
            data_lines.append((line_number, _split_mumax_line(stripped)))
    if header is None:
        raise ValueError(f"{path}: MuMax3 table has no '#'-prefixed header")
    canonical_header_values = [_canonical_header(value) for value in header]
    canonical_headers_list: list[str] = []
    duplicate_magnetization_columns: dict[str, int] = {}
    for canonical in canonical_header_values:
        if canonical not in canonical_headers_list:
            canonical_headers_list.append(canonical)
            continue
        if canonical not in MAGNETIZATION_COLUMNS:
            raise ValueError(f"{path}: MuMax3 table has duplicate canonical columns")
        duplicate_index = duplicate_magnetization_columns.get(canonical, 0) + 1
        duplicate_magnetization_columns[canonical] = duplicate_index
        canonical_headers_list.append(f"{canonical}__duplicate{duplicate_index}")
    canonical_headers = tuple(canonical_headers_list)
    rows: list[dict[str, float]] = []
    for line_number, values in data_lines:
        if len(values) != len(canonical_headers):
            raise ValueError(
                f"{path}: line {line_number}: expected {len(canonical_headers)} values, got {len(values)}"
            )
        rows.append(
            {
                canonical: _read_float(
                    value,
                    path=path,
                    line_number=line_number,
                    column=canonical,
                )
                for canonical, value in zip(canonical_headers, values)
            }
        )
    return _validate_rows(
        path=path,
        backend="mumax3",
        rows=rows,
        columns=canonical_headers,
        required=("time_s", *MAGNETIZATION_COLUMNS, *MUMAX_ENERGY_COLUMNS),
    )


def assert_no_field_snapshots(root: str | Path) -> None:
    root = Path(root)
    if not root.exists():
        raise ValueError(f"artifact root does not exist: {root}")
    paths = (root,) if root.is_file() else root.rglob("*")
    for candidate in paths:
        if candidate.name.lower() in FIELD_SNAPSHOT_NAMES or candidate.suffix.lower() in FIELD_SNAPSHOT_SUFFIXES:
            raise ValueError(f"field snapshot artifact detected: {candidate}")


def _table_times(table: ScalarTable) -> list[float]:
    times: list[float] = []
    for row in table.rows:
        value = row["time_s"]
        if not times or value != times[-1]:
            times.append(value)
    return times


def _interpolate(table: ScalarTable, column: str, time_s: float) -> float:
    rows = table.rows
    times = [row["time_s"] for row in rows]
    if time_s < times[0] or time_s > times[-1]:
        raise ValueError(f"cannot interpolate {table.backend} outside its time range")
    right = bisect_left(times, time_s)
    if right < len(times) and times[right] == time_s:
        return rows[right][column]
    if right == 0 or right == len(times):
        raise ValueError(f"cannot interpolate {table.backend} at t={time_s}")
    left = right - 1
    span = times[right] - times[left]
    if span <= 0.0:
        return rows[right][column]
    weight = (time_s - times[left]) / span
    return rows[left][column] + weight * (rows[right][column] - rows[left][column])


def _external_energy(table: ScalarTable, time_s: float) -> float:
    if "e_zeeman" in table.columns:
        return _interpolate(table, "e_zeeman", time_s)
    return _interpolate(table, "e_ext", time_s) + _interpolate(table, "e_drive", time_s)


def _common_grid(tables: Mapping[str, ScalarTable], reference_backend: str = "fdm") -> list[float]:
    reference = tables.get(reference_backend) or next(iter(tables.values()))
    start = max(table.first_time_s for table in tables.values())
    stop = min(table.last_time_s for table in tables.values())
    if start > stop:
        raise ValueError("scalar tables have no overlapping time interval")
    return [time for time in _table_times(reference) if start <= time <= stop]


def _series_value(table: ScalarTable, column: str, time_s: float) -> float:
    if column == "e_external_total":
        return _external_energy(table, time_s)
    return _interpolate(table, column, time_s)


def compare_tables(tables: Mapping[str, ScalarTable], *, reference_backend: str = "fdm") -> dict[str, object]:
    if len(tables) < 2:
        raise ValueError("at least two scalar tables are required for comparison")
    grid = _common_grid(tables, reference_backend=reference_backend)
    if not grid:
        raise ValueError("common comparison grid is empty")
    aligned_rows: list[dict[str, float]] = []
    for time_s in grid:
        row: dict[str, float] = {"time_s": time_s}
        for backend, table in tables.items():
            for column in (*MAGNETIZATION_COLUMNS, *COMPARABLE_ENERGY_COLUMNS):
                row[f"{backend}_{column}"] = _series_value(table, column, time_s)
        aligned_rows.append(row)

    pair_metrics: dict[str, object] = {}
    backends = list(tables)
    for left_index, left_backend in enumerate(backends):
        for right_backend in backends[left_index + 1 :]:
            pair_key = f"{left_backend}_vs_{right_backend}"
            metrics: dict[str, dict[str, float]] = {}
            for column in (*MAGNETIZATION_COLUMNS, *COMPARABLE_ENERGY_COLUMNS):
                deltas = [
                    abs(row[f"{left_backend}_{column}"] - row[f"{right_backend}_{column}"])
                    for row in aligned_rows
                ]
                metrics[column] = {
                    "max_abs": max(deltas),
                    "final_abs": deltas[-1],
                }
            pair_metrics[pair_key] = metrics
    return {
        "reference_backend": reference_backend if reference_backend in tables else backends[0],
        "grid_rows": len(aligned_rows),
        "grid_first_time_s": grid[0],
        "grid_last_time_s": grid[-1],
        "tables": {
            backend: {
                "source": str(table.source),
                "rows": len(table.rows),
                "columns": list(table.columns),
                "first_time_s": table.first_time_s,
                "last_time_s": table.last_time_s,
            }
            for backend, table in tables.items()
        },
        "mapping": {
            "mumax3_e_zeeman": "Fullmag e_ext + e_drive",
            "interpolation": "linear on reference backend times when source times differ",
        },
        "pair_metrics": pair_metrics,
        "aligned_rows": aligned_rows,
    }


def _write_csv(path: Path, rows: Sequence[Mapping[str, float]]) -> None:
    if not rows:
        raise ValueError("cannot write an empty comparison table")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def write_outputs(output_dir: str | Path, comparison: Mapping[str, object]) -> None:
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    aligned_rows = comparison.get("aligned_rows")
    if not isinstance(aligned_rows, list) or not aligned_rows:
        raise ValueError("comparison does not contain aligned rows")
    _write_csv(output_dir / "aligned_scalar_comparison.csv", aligned_rows)
    payload = {key: value for key, value in comparison.items() if key != "aligned_rows"}
    (output_dir / "comparison.json").write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fdm", type=Path, required=True, help="Fullmag FDM scalars.csv")
    parser.add_argument("--fem", type=Path, required=True, help="Fullmag FEM scalars.csv")
    parser.add_argument("--mumax", type=Path, required=True, help="MuMax3 table.txt")
    parser.add_argument("--output-dir", type=Path, default=Path("comparison"))
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="validate and compare inputs without writing output files",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    roots = {args.fdm.parent, args.fem.parent, args.mumax.parent}
    for root in roots:
        assert_no_field_snapshots(root)
    tables = {
        "fdm": parse_fullmag_scalars(args.fdm),
        "fem": parse_fullmag_scalars(args.fem),
        "mumax3": parse_mumax_table(args.mumax),
    }
    comparison = compare_tables(tables)
    if not args.verify_only:
        write_outputs(args.output_dir, comparison)
    print(json.dumps({key: value for key, value in comparison.items() if key != "aligned_rows"}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
