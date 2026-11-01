#!/usr/bin/env python3
"""Compare FDM CPU and CUDA runs of the region/material parity cases.

Each case of ``fdm_regions_parity_case.py`` runs on the CPU reference and on
CUDA (fp64, optionally fp32). The final magnetization of every lane is
compared with the CPU reference (max |dm| over cells and components), and the
final-row scalars of ``artifacts/scalars.csv`` are compared where both lanes
report them. Results go to ``<output>/parity.jsonl`` and a Markdown table to
stdout.

Usage (inside the backend container, from the source root)::

    python3 scripts/benchmarks/run_fdm_regions_parity.py --output /tmp/regions-parity
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
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
    run_dir.mkdir(parents=True, exist_ok=True)
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


def max_dm(reference: list, other: list) -> float:
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
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    lanes = [("cpu", "double"), ("gpu", "double")] + ([("gpu", "single")] if args.with_fp32 else [])
    rows = []
    with (args.output / "parity.jsonl").open("a") as log:
        for case in args.case or CASES:
            records = {lane: run(case, *lane, args.steps, args.output, args.fullmag_bin)
                       for lane in lanes}
            reference = records[("cpu", "double")]
            for lane, record in records.items():
                entry = {key: value for key, value in record.items() if key != "m_final"}
                if lane != ("cpu", "double") and reference["m_final"] and record["m_final"]:
                    entry["max_dm_vs_cpu"] = max_dm(reference["m_final"], record["m_final"])
                    entry["scalar_rel_vs_cpu"] = scalar_rel(reference["scalars"], record["scalars"])
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
