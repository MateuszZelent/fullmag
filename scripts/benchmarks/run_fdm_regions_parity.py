#!/usr/bin/env python3
"""Compare FDM CPU and CUDA runs of the region/material parity cases.

Each case of ``fdm_regions_parity_case.py`` runs on the CPU reference and on
CUDA (fp64, optionally fp32). The final magnetization of every lane is
compared with the CPU reference (max |dm| over cells and components), and the
final-row scalars of ``artifacts/scalars.csv`` are compared where both lanes
report them. Results go to ``<output>/parity.jsonl`` and a Markdown table to
stdout. The script exits non-zero when a lane fails, its ``m_final`` is missing,
has the wrong shape or is non-finite, or an fp64 lane exceeds ``--max-dm`` or
``--max-energy-rel`` against the CPU reference. fp32 lanes are reported but not
held to the fp64 tolerances.

Usage (inside the backend container, from the source root)::

    python3 scripts/benchmarks/run_fdm_regions_parity.py --output /tmp/regions-parity
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

CASE_SCRIPT = Path(__file__).with_name("fdm_regions_parity_case.py")
CASES = ["two_materials", "two_materials_scaled", "grains", "uniform", "uniform_regions"]
PREVIEW_OFF_ENV = {
    "FULLMAG_DISABLE_PREVIEW_3D": "1",
    "FULLMAG_DISABLE_PREVIEW_2D": "1",
    "FULLMAG_DISABLE_LIVE_MAGNETIZATION": "1",
    "FULLMAG_API_PORT": "0",
}


def run(case: str, device: str, precision: str, steps: int, output: Path, fullmag_bin: str) -> dict:
    run_dir = output / f"{case}-{device}-{precision}"
    # A stale run directory could supply artifacts from an earlier build.
    if run_dir.exists():
        shutil.rmtree(run_dir)
    run_dir.mkdir(parents=True)
    env = dict(os.environ, **PREVIEW_OFF_ENV,
               FDM_REGIONS_CASE=case, FDM_REGIONS_DEVICE=device,
               FDM_REGIONS_PRECISION=precision, FDM_REGIONS_STEPS=str(steps))
    command = [fullmag_bin, str(CASE_SCRIPT), "--backend", "fdm", "--headless", "--json",
               "--output-dir", str(run_dir / "out")]
    started = time.perf_counter()
    completed = subprocess.run(command, env=env, capture_output=True, text=True)
    wall_s = time.perf_counter() - started
    (run_dir / "stdout.txt").write_text(completed.stdout)
    (run_dir / "stderr.txt").write_text(completed.stderr)
    artifacts = run_dir / "out" / "artifacts"
    m_final = None
    m_path = artifacts / "m_final.json"
    if m_path.is_file():
        m_final = json.loads(m_path.read_text())["values"]
    scalars = None
    scalars_path = artifacts / "scalars.csv"
    if scalars_path.is_file():
        with scalars_path.open(newline="") as handle:
            rows = list(csv.DictReader(handle))
        if rows:
            scalars = {key: float(value) for key, value in rows[-1].items()
                       if value not in ("", None) and _is_float(value)}
    return {
        "case": case, "device": device, "precision": precision, "steps": steps,
        "returncode": completed.returncode, "wall_s": wall_s,
        "stderr_tail": completed.stderr[-2000:] if completed.returncode else "",
        "m_final": m_final, "scalars": scalars,
        "m_final_sha256": None if m_final is None
        else hashlib.sha256(json.dumps(m_final).encode()).hexdigest(),
    }


def _is_float(value: str) -> bool:
    try:
        float(value)
    except ValueError:
        return False
    return True


def magnetization_problem(values: list | None) -> str | None:
    if values is None:
        return "m_final missing"
    if not values or any(len(cell) != 3 for cell in values):
        return "m_final is not a non-empty list of 3-vectors"
    if not all(math.isfinite(component) for cell in values for component in cell):
        return "m_final contains non-finite values"
    return None


def max_dm(reference: list, other: list) -> float:
    if len(reference) != len(other):
        raise ValueError(f"cell count differs: {len(reference)} vs {len(other)}")
    return max(abs(a - b) for ra, rb in zip(reference, other) for a, b in zip(ra, rb))


def scalar_rel(reference: dict | None, other: dict | None) -> dict:
    if not reference or not other:
        return {}
    out = {}
    for key, value in reference.items():
        if key in other and key.startswith(("E_", "e_", "energy")):
            scale = max(abs(value), 1e-30)
            out[key] = abs(other[key] - value) / scale
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--case", action="append", default=[])
    parser.add_argument("--steps", type=int, default=2000)
    parser.add_argument("--with-fp32", action="store_true")
    parser.add_argument("--fullmag-bin", default="fullmag-bin")
    parser.add_argument("--max-dm", type=float, default=1e-6,
                        help="fp64 tolerance on max |dm| against the CPU reference")
    parser.add_argument("--max-energy-rel", type=float, default=1e-8,
                        help="fp64 tolerance on the relative final energy difference")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    lanes = [("cpu", "double"), ("gpu", "double")] + ([("gpu", "single")] if args.with_fp32 else [])
    rows = []
    failures: list[str] = []
    with (args.output / "parity.jsonl").open("w") as log:
        for case in args.case or CASES:
            records = {lane: run(case, *lane, args.steps, args.output, args.fullmag_bin)
                       for lane in lanes}
            reference = records[("cpu", "double")]
            reference_problem = magnetization_problem(reference["m_final"])
            for lane, record in records.items():
                entry = {key: value for key, value in record.items() if key != "m_final"}
                label = f"{case} {lane[0]}/{lane[1]}"
                problem = magnetization_problem(record["m_final"])
                if record["returncode"] != 0:
                    failures.append(f"{label}: exit code {record['returncode']}")
                elif problem:
                    failures.append(f"{label}: {problem}")
                elif lane != ("cpu", "double") and reference_problem is None:
                    try:
                        entry["max_dm_vs_cpu"] = max_dm(reference["m_final"], record["m_final"])
                    except ValueError as error:
                        failures.append(f"{label}: {error}")
                    rel = scalar_rel(reference["scalars"], record["scalars"])
                    entry["scalar_rel_vs_cpu"] = rel
                    # Python's max() skips NaN after a finite value, so every
                    # compared energy and difference is checked before aggregating.
                    non_finite = [
                        key for key in rel
                        if not (math.isfinite(reference["scalars"][key])
                                and math.isfinite(record["scalars"][key])
                                and math.isfinite(rel[key]))
                    ]
                    if non_finite:
                        failures.append(f"{label}: non-finite energy {', '.join(non_finite)}")
                    if lane[1] == "double":
                        dm = entry.get("max_dm_vs_cpu")
                        if dm is not None and not dm <= args.max_dm:
                            failures.append(f"{label}: max |dm| {dm:.3e} > {args.max_dm:.1e}")
                        if not rel:
                            failures.append(f"{label}: no comparable energy scalars")
                        elif not non_finite and not max(rel.values()) <= args.max_energy_rel:
                            failures.append(f"{label}: energy rel {max(rel.values()):.3e} > "
                                            f"{args.max_energy_rel:.1e}")
                log.write(json.dumps(entry) + "\n")
                rows.append(entry)
                print(f"{case} {lane}: rc={record['returncode']} wall={record['wall_s']:.1f}s "
                      f"max_dm={entry.get('max_dm_vs_cpu')}", file=sys.stderr)
    print("| case | lane | rc | wall [s] | max abs dm vs CPU | max rel energy diff | m_final sha256 |")
    print("|---|---|---:|---:|---:|---:|---|")
    for row in rows:
        rel = row.get("scalar_rel_vs_cpu") or {}
        worst = max(rel.values()) if rel else None
        print(f"| {row['case']} | {row['device']}/{row['precision']} | {row['returncode']} | "
              f"{row['wall_s']:.1f} | {row.get('max_dm_vs_cpu', '-')} | "
              f"{'-' if worst is None else f'{worst:.2e}'} | {(row['m_final_sha256'] or '-')[:12]} |")
    for failure in failures:
        print(f"PARITY FAILURE: {failure}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
