#!/usr/bin/env python3
"""Validate the profiled FEM GPU HYPRE host/device timing contract."""

from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path
from typing import Any, Mapping, Sequence


TIMING_FIELDS = (
    "demag_hypre_wait_in_enqueue_wall_time_ms",
    "demag_hypre_host_api_wall_time_ms",
    "demag_hypre_device_elapsed_time_ms",
    "demag_hypre_wait_out_enqueue_wall_time_ms",
)
COUNT_FIELDS = (
    "demag_hypre_event_wait_count",
    "demag_hypre_timed_solve_count",
)
REQUIRED_FIELDS = (*TIMING_FIELDS, *COUNT_FIELDS, "step_profiler_enabled")


def _number(row: Mapping[str, Any], field: str) -> float | None:
    value = row.get(field)
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _integer(row: Mapping[str, Any], field: str) -> int | None:
    value = _number(row, field)
    if value is None or value != math.trunc(value):
        return None
    return int(value)


def _boolean(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    token = str(value).strip().lower()
    if token in {"1", "true", "yes", "on"}:
        return True
    if token in {"0", "false", "no", "off"}:
        return False
    return None


def _resolution(row: Mapping[str, Any]) -> str | None:
    text = " ".join(
        str(row.get(field, "")).lower()
        for field in ("solver_mesh_name", "mesh_name", "solver_mesh_path", "mesh_path")
    )
    matches = [resolution for resolution in ("coarse", "medium", "fine") if resolution in text]
    return matches[0] if len(matches) == 1 else None


def load_rows(paths: Sequence[str | Path]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for raw_path in paths:
        path = Path(raw_path)
        if path.suffix.lower() == ".csv":
            with path.open(newline="", encoding="utf-8") as handle:
                rows.extend(dict(row) for row in csv.DictReader(handle))
            continue
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, list):
            rows.extend(item for item in payload if isinstance(item, dict))
        elif isinstance(payload, dict) and isinstance(payload.get("results"), list):
            rows.extend(item for item in payload["results"] if isinstance(item, dict))
        elif isinstance(payload, dict):
            rows.append(payload)
        else:
            raise ValueError(f"{path} must contain an object or an array of objects")
    return rows


def validate_rows(
    rows: Sequence[Mapping[str, Any]],
    *,
    expected_resolutions: Sequence[str] = ("coarse", "fine"),
) -> dict[str, Any]:
    failures: list[str] = []
    observations: list[dict[str, Any]] = []
    expected = set(expected_resolutions)
    seen: set[tuple[str, bool]] = set()

    for index, row in enumerate(rows, start=1):
        backend = str(row.get("backend", "")).lower()
        if backend not in {"fem_gpu", "gpu"}:
            continue
        label = f"row={index}"
        if str(row.get("status", "ok")).lower() not in {"ok", "completed"}:
            failures.append(f"{label}: benchmark row is not successful")
            continue
        missing = [field for field in REQUIRED_FIELDS if field not in row]
        if missing:
            failures.append(f"{label}: missing fields {', '.join(missing)}")
            continue
        profiled = _boolean(row.get("step_profiler_enabled"))
        if profiled is None:
            failures.append(f"{label}: step_profiler_enabled is not boolean")
            continue
        resolution = _resolution(row)
        if resolution is None:
            failures.append(f"{label}: cannot identify coarse/fine solver mesh")
        elif resolution not in expected:
            failures.append(f"{label}: unexpected solver mesh resolution {resolution!r}")
        seen.add((resolution or "unknown", profiled))

        values = {field: _number(row, field) for field in TIMING_FIELDS}
        counts = {field: _integer(row, field) for field in COUNT_FIELDS}
        if any(value is None for value in values.values()) or any(
            value is None for value in counts.values()
        ):
            failures.append(f"{label}: HYPRE timing/count field is missing or non-finite")
            continue
        assert all(value is not None for value in values.values())
        assert all(value is not None for value in counts.values())
        if any(value < 0.0 for value in values.values()):
            failures.append(f"{label}: HYPRE timing is negative")
        if any(value < 0 for value in counts.values()):
            failures.append(f"{label}: HYPRE count is negative")

        if not profiled:
            if any(value != 0.0 for value in values.values()) or any(
                value != 0 for value in counts.values()
            ):
                failures.append(f"{label}: profiler-off HYPRE telemetry must be zero")
        else:
            demag_solves = _integer(row, "demag_solves")
            timed_solves = counts["demag_hypre_timed_solve_count"]
            device_elapsed = values["demag_hypre_device_elapsed_time_ms"]
            if demag_solves is None or demag_solves <= 0:
                failures.append(f"{label}: profiled row has no positive demag_solve count")
            elif timed_solves != demag_solves:
                failures.append(
                    f"{label}: timed_solve_count={timed_solves} differs from demag_solves={demag_solves}"
                )
            if device_elapsed <= 0.0:
                failures.append(f"{label}: profiled row has no positive GPU device elapsed time")
            compute_syncs = _integer(row, "hot_loop_compute_host_sync_count")
            if compute_syncs is None:
                compute_syncs = _integer(row, "hot_loop_compute_sync_count")
            if compute_syncs is None:
                failures.append(f"{label}: missing hot-loop compute synchronization count")
            elif compute_syncs != 0:
                failures.append(f"{label}: hot-loop compute synchronization count is {compute_syncs}")

        observations.append(
            {
                "row": index,
                "resolution": resolution,
                "step_profiler_enabled": profiled,
                "demag_solves": _integer(row, "demag_solves"),
                "demag_hypre_timed_solve_count": counts["demag_hypre_timed_solve_count"],
                "demag_hypre_device_elapsed_time_ms": values["demag_hypre_device_elapsed_time_ms"],
            }
        )

    gpu_rows = [row for row in rows if str(row.get("backend", "")).lower() in {"fem_gpu", "gpu"}]
    if not gpu_rows:
        failures.append("no FEM GPU rows were supplied")
    for resolution in expected:
        for profiled in (False, True):
            if (resolution, profiled) not in seen:
                failures.append(
                    f"missing FEM GPU row for resolution={resolution}, profiler={int(profiled)}"
                )

    return {
        "schema": "fullmag.fem.hypre_device_timing.v1",
        "status": "pass" if not failures else "fail",
        "row_count": len(gpu_rows),
        "expected_resolutions": list(expected_resolutions),
        "observations": observations,
        "failures": failures,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", nargs="+", required=True, help="CSV/JSON benchmark result files")
    parser.add_argument("--expected-resolutions", default="coarse,fine")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    expected = tuple(item.strip() for item in args.expected_resolutions.split(",") if item.strip())
    summary = validate_rows(load_rows(args.input), expected_resolutions=expected)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(summary, sort_keys=True))
    return 0 if summary["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
