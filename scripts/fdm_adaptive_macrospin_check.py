"""Exact-solution gate for scripts/fdm_adaptive_macrospin_case.py (note 0480 §10.3).

Usage:
    python -B scripts/fdm_adaptive_macrospin_check.py --reference <cpu_out> \
        --candidate <gpu_out_a> --candidate <gpu_out_b> [--tolerance 1e-6]

Each argument is a headless --output-dir; rows come from artifacts/scalars.csv.
Validation support only: the oracle shares no code with the solvers.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from pathlib import Path

G_FACTOR = 2.0
MU_B = 9.2740100783e-24
HBAR = 1.054571817e-34
ALPHA = 0.01
B_Z_T = 0.05


def exact_m(time_s: float) -> tuple[float, float, float]:
    gamma = G_FACTOR * MU_B / HBAR
    theta = gamma * B_Z_T * time_s / (1.0 + ALPHA * ALPHA)
    m_perp = 1.0 / math.cosh(ALPHA * theta)
    return m_perp * math.cos(theta), m_perp * math.sin(theta), math.tanh(ALPHA * theta)


def load_rows(output_dir: Path) -> list[dict[str, float]]:
    with (output_dir / "artifacts" / "scalars.csv").open(newline="") as handle:
        rows = [{key: float(value) for key, value in row.items() if value != ""}
                for row in csv.DictReader(handle)]
    if not rows:
        raise SystemExit(f"{output_dir}: no table rows")
    return rows


def summarize(output_dir: Path) -> dict[str, object]:
    rows = load_rows(output_dir)
    worst = 0.0
    for row in rows:
        expected = exact_m(row["time"])
        observed = (row["mx"], row["my"], row["mz"])
        worst = max(worst, max(abs(o - e) for o, e in zip(observed, expected)))
    return {
        "output_dir": str(output_dir),
        "rows": len(rows),
        "final_time_s": rows[-1]["time"],
        "final_step": int(rows[-1].get("step", -1)),
        "max_abs_deviation_from_exact": worst,
        "rows_m": [(row["mx"], row["my"], row["mz"]) for row in rows],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, action="append", required=True)
    parser.add_argument("--tolerance", type=float, default=1e-6)
    args = parser.parse_args()

    reference = summarize(args.reference)
    candidates = [summarize(path) for path in args.candidate]
    failures = []
    for candidate in [reference, *candidates]:
        if candidate["max_abs_deviation_from_exact"] > args.tolerance:
            failures.append(f"{candidate['output_dir']}: deviation from exact solution "
                            f"{candidate['max_abs_deviation_from_exact']:.3e} > {args.tolerance:.1e}")
    for candidate in candidates:
        if candidate["rows"] != reference["rows"]:
            failures.append(f"{candidate['output_dir']}: {candidate['rows']} rows, "
                            f"reference has {reference['rows']}")
        if reference["final_step"] > 0 and candidate["final_step"] > 10 * reference["final_step"]:
            failures.append(f"{candidate['output_dir']}: {candidate['final_step']} accepted steps, "
                            f"reference needed {reference['final_step']}; controller output unused")
    first = candidates[0]
    for other in candidates[1:]:
        if other["rows_m"] != first["rows_m"]:
            failures.append(f"{other['output_dir']}: table differs from {first['output_dir']} "
                            "for an identical run")

    report = {
        "tolerance": args.tolerance,
        "reference": {k: v for k, v in reference.items() if k != "rows_m"},
        "candidates": [{k: v for k, v in c.items() if k != "rows_m"} for c in candidates],
        "failures": failures,
        "status": "pass" if not failures else "fail",
    }
    print(json.dumps(report, indent=2))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
