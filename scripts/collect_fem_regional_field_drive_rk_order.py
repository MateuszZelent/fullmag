#!/usr/bin/env python3
"""Collect managed FEM runs into the strict RK/event/energy validator schema."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


def table_columns(run: Path) -> tuple[list[str], list[list[float]]]:
    table_dir = run / "tables" / "default"
    schema = json.loads((table_dir / "schema.json").read_text())
    table = json.loads((table_dir / "table.json").read_text())
    columns = [column["quantity_id"] for column in schema["columns"]]
    return columns, [row["values"] for row in table["rows"]]


def final_vector(run: Path) -> tuple[list[float], dict[str, float]]:
    columns, rows = table_columns(run)
    if not rows:
        raise ValueError(f"{run}: table has no rows")
    values = dict(zip(columns, rows[-1], strict=True))
    return [float(values[name]) for name in ("mx", "my", "mz")], values


def event_energy_sample(
    samples: list[dict[str, float]], *, until_s: float
) -> dict[str, float]:
    """Return the table sample nearest the pulse midpoint.

    Table artifacts use canonical quantity ids (``t`` and ``e_drive``), not
    Python authoring aliases such as ``time`` and ``E_drive``.
    """
    if not samples:
        raise ValueError("event run table has no rows")
    sample = min(samples, key=lambda row: abs(float(row["t"]) - 0.5 * until_s))
    if not (0.35 * until_s <= float(sample["t"]) < 0.65 * until_s):
        raise ValueError("event run did not publish an energy sample inside the pulse plateau")
    return sample


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", action="append", required=True, help="integrator:dt_s:artifact_dir")
    parser.add_argument("--event-run", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    grouped: dict[str, list[tuple[float, Path]]] = {}
    for encoded in args.run:
        name, dt_text, path = encoded.split(":", 2)
        grouped.setdefault(name, []).append((float(dt_text), Path(path)))
    integrators: dict[str, object] = {}
    for name, runs in grouped.items():
        runs.sort(reverse=True)
        if len(runs) < 4:
            raise ValueError(f"{name}: requires three measured dt values and one finer reference")
        reference, _ = final_vector(runs[-1][1])
        dt_s, error = [], []
        for dt, path in runs[:-1]:
            vector, _ = final_vector(path)
            dt_s.append(dt)
            error.append(math.sqrt(sum((left - right) ** 2 for left, right in zip(vector, reference))))
        integrators[name] = {"dt_s": dt_s, "error": error}

    event_artifact = json.loads((args.event_run / "regional_field_drive.v1.json").read_text())
    until = float(event_artifact["stage_end_time_s"] - event_artifact["stage_start_time_s"])
    columns, rows = table_columns(args.event_run)
    samples = [dict(zip(columns, row, strict=True)) for row in rows]
    sample = event_energy_sample(samples, until_s=until)
    oracle = -800e3 * (4e-9) ** 3 * float(sample["my"]) * 1e-3
    measured = float(sample["e_drive"])
    payload = {
        "integrators": integrators,
        "events": {
            "crossing_contamination": event_artifact.get("fsal_invalidation_count") != 2,
            "fsal_invalidated_at_discontinuity": event_artifact.get("fsal_invalidation_count") == 2,
            "times_s": event_artifact.get("fsal_invalidation_times_s", []),
        },
        "energy": {
            "measured_j": measured,
            "minus_mu0_integral_j": oracle,
            "absolute_tolerance_j": max(abs(oracle) * 1e-8, 1e-30),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
