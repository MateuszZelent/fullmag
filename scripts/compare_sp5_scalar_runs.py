#!/usr/bin/env python3
"""Compare final scalar observables from the FEM and FDM SP5 runs.

The two backends do not share a field-point ordering, so this deliberately
compares only observables that have the same definition: the final time,
volume/cell-reduced ``avg(m)``, and the reported energies/torque.  A report is
diagnostic unless the input times match and the caller has separately supplied
field-level and h/dt convergence evidence.
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any


VECTOR_COLUMNS = ("mx", "my", "mz")
SCALAR_COLUMNS = ("E_ex", "E_demag", "E_total", "max_torque_T")


def _last_row(path: Path) -> dict[str, float]:
    with path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    if not rows:
        raise ValueError(f"{path} contains no scalar rows")
    row = rows[-1]
    required = ("time", *VECTOR_COLUMNS, *SCALAR_COLUMNS)
    missing = [name for name in required if name not in row]
    if missing:
        raise ValueError(f"{path} is missing scalar columns: {', '.join(missing)}")
    return {name: float(row[name]) for name in required}


def compare(fem_path: Path, fdm_path: Path, time_tolerance: float) -> dict[str, Any]:
    fem = _last_row(fem_path)
    fdm = _last_row(fdm_path)
    delta = {name: fem[name] - fdm[name] for name in (*VECTOR_COLUMNS, *SCALAR_COLUMNS)}
    vector_l2 = sum(delta[name] ** 2 for name in VECTOR_COLUMNS) ** 0.5
    return {
        "schema_version": "sp5.fem_fdm_scalar_comparison.v1",
        "inputs": {"fem_scalars": str(fem_path), "fdm_scalars": str(fdm_path)},
        "same_final_time": abs(fem["time"] - fdm["time"]) <= time_tolerance,
        "time_difference_s": fem["time"] - fdm["time"],
        "time_tolerance_s": time_tolerance,
        "fem_final": fem,
        "fdm_final": fdm,
        "delta_fem_minus_fdm": delta,
        "avg_m_l2_difference": vector_l2,
        "qualification": {
            "status": "diagnostic",
            "equivalence_established": False,
            "reason": (
                "scalar endpoint comparison does not replace matched-field "
                "and mesh/time-step convergence evidence"
            ),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fem-scalars", required=True, type=Path)
    parser.add_argument("--fdm-scalars", required=True, type=Path)
    parser.add_argument("--time-tolerance", type=float, default=1e-18)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.time_tolerance < 0:
        parser.error("--time-tolerance must be non-negative")
    payload = compare(args.fem_scalars, args.fdm_scalars, args.time_tolerance)
    text = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text, encoding="utf-8")
    else:
        print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
