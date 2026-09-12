"""Parse and compare scalar Fullmag CPU/GPU, FEM CPU/GPU, and MuMax3 tables."""

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


def _table_with_rows(table: ScalarTable, rows: Sequence[dict[str, float]], source: Path) -> ScalarTable:
    if not rows:
        raise ValueError(f"{source}: selected stage contains no scalar rows")
    return ScalarTable(
        backend=table.backend,
        source=source,
        columns=table.columns,
        rows=tuple(dict(row) for row in rows),
        native_columns=table.native_columns,
    )


def _fullmag_stage_candidates(root: Path, stage: str) -> list[Path]:
    if root.is_file():
        return [root]
    if not root.is_dir():
        raise ValueError(f"Fullmag {stage} bundle does not exist: {root}")
    if stage == "relaxation":
        candidates = [
            root / "artifacts" / "tables" / "relaxation" / "table.csv",
            root / "tables" / "relaxation" / "table.csv",
        ]
        candidates.extend(sorted(root.glob("stages/*/tables/relaxation/table.csv")))
        candidates.extend(
            path
            for path in sorted(root.glob("stages/*/scalars.csv"))
            if "relax" in path.parent.name.lower()
        )
        return candidates
    if stage != "dynamic":
        raise ValueError(f"unsupported Fullmag stage: {stage!r}")
    candidates = [
        root / "artifacts" / "tables" / "default" / "table.csv",
        root / "tables" / "default" / "table.csv",
    ]
    candidates.extend(
        path
        for path in sorted(root.glob("stages/*/tables/default/table.csv"))
        if any(token in path.parent.parent.name.lower() for token in ("dynamic", "table_autosave"))
    )
    candidates.extend([root / "artifacts" / "scalars.csv", root / "scalars.csv"])
    return candidates


def load_fullmag_stage(path: str | Path, stage: str) -> ScalarTable:
    root = Path(path)
    if root.is_dir():
        assert_no_field_snapshots(root)
    candidates = _fullmag_stage_candidates(root, stage)
    errors: list[str] = []
    for candidate in candidates:
        if not candidate.is_file():
            continue
        try:
            return parse_fullmag_scalars(candidate)
        except ValueError as exc:
            errors.append(str(exc))
    detail = f"; last error: {errors[-1]}" if errors else ""
    raise ValueError(f"{root}: Fullmag {stage} scalar table is unavailable{detail}")


def load_lane_stage(path: str | Path, lane: str, stage: str) -> ScalarTable:
    if lane == "mumax3":
        candidate = Path(path)
        if candidate.is_dir():
            table_candidates = [candidate / "table.txt", candidate / "table.tsv"]
            candidate = next((item for item in table_candidates if item.is_file()), candidate)
        table = parse_mumax_table(candidate)
        if stage == "relaxation":
            zero_rows = [row for row in table.rows if row["time_s"] == 0.0]
            if not zero_rows:
                raise ValueError(f"{candidate}: MuMax3 relaxation endpoint is unavailable")
            return _table_with_rows(table, [zero_rows[-1]], candidate)
        if stage == "dynamic":
            zero_indices = [index for index, row in enumerate(table.rows) if row["time_s"] == 0.0]
            start = zero_indices[-1] if zero_indices else 0
            return _table_with_rows(table, table.rows[start:], candidate)
        raise ValueError(f"unsupported MuMax3 stage: {stage!r}")
    return load_fullmag_stage(path, stage)


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
    return _interpolate(table, "e_ext", time_s)


def _common_grid(tables: Mapping[str, ScalarTable], reference_backend: str = "fdm_cpu") -> list[float]:
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


def compare_tables(
    tables: Mapping[str, ScalarTable],
    *,
    reference_backend: str = "fdm_cpu",
    alignment: str = "time",
) -> dict[str, object]:
    if len(tables) < 2:
        raise ValueError("at least two scalar tables are required for comparison")
    if alignment not in {"time", "row"}:
        raise ValueError(f"unsupported comparison alignment: {alignment!r}")
    reference = tables.get(reference_backend) or next(iter(tables.values()))
    if alignment == "time":
        points: list[tuple[int | None, float]] = [
            (None, time_s) for time_s in _common_grid(tables, reference_backend=reference_backend)
        ]
    else:
        row_count = len(reference.rows)
        if any(len(table.rows) != row_count for table in tables.values()):
            raise ValueError("row-aligned comparison requires equal row counts")
        points = [(index, reference.rows[index]["time_s"]) for index in range(row_count)]
    if not points:
        raise ValueError("common comparison grid is empty")
    aligned_rows: list[dict[str, float]] = []
    for row_index, time_s in points:
        row: dict[str, float] = {"time_s": time_s}
        if row_index is not None:
            row["row_index"] = row_index
        for backend, table in tables.items():
            for column in (*MAGNETIZATION_COLUMNS, *COMPARABLE_ENERGY_COLUMNS):
                if row_index is None:
                    value = _series_value(table, column, time_s)
                else:
                    value = (
                        table.rows[row_index]["e_zeeman"]
                        if column == "e_external_total" and "e_zeeman" in table.columns
                        else (
                            table.rows[row_index]["e_ext"]
                            if column == "e_external_total"
                            else table.rows[row_index][column]
                        )
                    )
                row[f"{backend}_{column}"] = value
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
        "alignment": alignment,
        "grid_rows": len(aligned_rows),
        "grid_first_time_s": points[0][1],
        "grid_last_time_s": points[-1][1],
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
            "fullmag_e_ext": "Fullmag e_ext (bias + drive)",
            "mumax3_e_zeeman": "MuMax3 e_zeeman (bias + drive)",
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
    relaxation = comparison.get("relaxation")
    if isinstance(relaxation, Mapping):
        relaxation_rows = relaxation.get("aligned_rows")
        if isinstance(relaxation_rows, list) and relaxation_rows:
            _write_csv(output_dir / "aligned_relaxation_comparison.csv", relaxation_rows)
    payload = {key: value for key, value in comparison.items() if key != "aligned_rows"}
    if isinstance(relaxation, Mapping):
        payload["relaxation"] = {
            key: value for key, value in relaxation.items() if key != "aligned_rows"
        }
    (output_dir / "comparison.json").write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _require_fem_fk_qualification(path: str | Path, lane: str) -> None:
    root = Path(path)
    if not root.is_dir():
        raise ValueError(
            f"{lane}: --require-qualified-fk wymaga bundle katalogowego z qualification.json: {root}"
        )
    candidates = (root / "qualification.json", root / "artifacts" / "qualification.json")
    report_path = next((candidate for candidate in candidates if candidate.is_file()), None)
    if report_path is None:
        raise ValueError(f"{lane}: brak qualification.json w {root}")
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"{lane}: nie można odczytać {report_path}: {exc}") from exc
    if not isinstance(report, Mapping) or report.get("status") != "PASS":
        status = report.get("status") if isinstance(report, Mapping) else None
        raise ValueError(f"{lane}: kwalifikacja FEM/BEM FK nie ma statusu PASS (status={status!r})")
    if report.get("lane") != ("gpu" if lane == "fem_fk_gpu" else "cpu"):
        raise ValueError(f"{lane}: qualification.json ma niezgodny lane={report.get('lane')!r}")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fdm", "--fdm-cpu", dest="fdm", type=Path, required=True, help="Fullmag FDM CPU scalar table")
    parser.add_argument("--fdm-gpu", dest="fdm_gpu", type=Path, help="Fullmag FDM GPU scalar table")
    parser.add_argument("--fem", "--fem-cpu", dest="fem", type=Path, help="Fullmag FEM CPU scalar table")
    parser.add_argument("--fem-gpu", dest="fem_gpu", type=Path, help="Fullmag FEM GPU scalar table")
    parser.add_argument(
        "--fem-pr-cpu", "--fem-poisson-robin-cpu",
        dest="fem_pr_cpu", type=Path,
        help="Fullmag FEM CPU Poisson-Robin scalar bundle/table",
    )
    parser.add_argument(
        "--fem-pr-gpu", "--fem-poisson-robin-gpu",
        dest="fem_pr_gpu", type=Path,
        help="Fullmag FEM GPU Poisson-Robin scalar bundle/table",
    )
    parser.add_argument(
        "--fem-fk-cpu", "--fem-fredkin-koehler-cpu",
        dest="fem_fk_cpu", type=Path,
        help="Fullmag FEM CPU Fredkin-Koehler scalar bundle/table",
    )
    parser.add_argument(
        "--fem-fk-gpu", "--fem-fredkin-koehler-gpu",
        dest="fem_fk_gpu", type=Path,
        help="Fullmag FEM GPU Fredkin-Koehler scalar bundle/table",
    )
    parser.add_argument("--mumax", type=Path, required=True, help="MuMax3 table.txt")
    parser.add_argument("--output-dir", type=Path, default=Path("comparison"))
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="validate and compare inputs without writing output files",
    )
    parser.add_argument(
        "--align-by-row",
        action="store_true",
        help="align static relaxation tables by row index instead of time",
    )
    parser.add_argument(
        "--require-qualified-fk",
        dest="require_qualified_fk",
        action="store_true",
        help="require PASS qualification.json for every supplied FEM Fredkin-Koehler lane",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    lane_paths: dict[str, Path] = {"fdm_cpu": args.fdm}
    for lane, path in (
        ("fdm_gpu", args.fdm_gpu),
        ("fem_cpu", args.fem),
        ("fem_gpu", args.fem_gpu),
        ("fem_pr_cpu", args.fem_pr_cpu),
        ("fem_pr_gpu", args.fem_pr_gpu),
        ("fem_fk_cpu", args.fem_fk_cpu),
        ("fem_fk_gpu", args.fem_fk_gpu),
    ):
        if path is not None:
            lane_paths[lane] = path
    lane_paths["mumax3"] = args.mumax
    if args.require_qualified_fk:
        for lane in ("fem_fk_cpu", "fem_fk_gpu"):
            if lane in lane_paths:
                _require_fem_fk_qualification(lane_paths[lane], lane)
    for path in lane_paths.values():
        if path.is_dir():
            assert_no_field_snapshots(path)
    tables = {
        lane: load_lane_stage(path, lane, "dynamic")
        for lane, path in lane_paths.items()
    }
    comparison = compare_tables(
        tables,
        reference_backend="fdm_cpu",
        alignment="row" if args.align_by_row else "time",
    )
    fullmag_paths = [path for lane, path in lane_paths.items() if lane != "mumax3"]
    if fullmag_paths and all(path.is_dir() for path in fullmag_paths):
        try:
            relaxation_tables = {
                lane: load_lane_stage(path, lane, "relaxation")
                for lane, path in lane_paths.items()
            }
            comparison["relaxation"] = compare_tables(
                relaxation_tables,
                reference_backend="fdm_cpu",
                alignment="row" if args.align_by_row else "time",
            )
        except ValueError as exc:
            comparison["relaxation"] = {
                "status": "NOT VERIFIED",
                "reason": str(exc),
            }
    else:
        comparison["relaxation"] = {
            "status": "NOT VERIFIED",
            "reason": "relaxation comparison requires Fullmag bundle directories, not only CSV paths",
        }
    if not args.verify_only:
        write_outputs(args.output_dir, comparison)
    print(json.dumps({key: value for key, value in comparison.items() if key != "aligned_rows"}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
