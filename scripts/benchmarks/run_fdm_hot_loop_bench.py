#!/usr/bin/env python3
"""Drive the FDM hot-loop benchmark matrix inside a Docker DEV backend.

Each case runs ``fullmag-bin scripts/benchmarks/fdm_hot_loop_case.py`` with the
case's environment, ``repeat`` times, and records the external wall time, the
solver's per-step wall time where the lane reports one, the CUDA receipt
counters and a hash of the final magnetization.  Results go to
``<output>/results.jsonl`` and a Markdown table to stdout.

Usage (inside the backend container, from the source root)::

    python3 scripts/benchmarks/run_fdm_hot_loop_bench.py \
        --output /build/fdm-bench/before --suite cpu --repeat 3
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path

CASE_SCRIPT = Path(__file__).with_name("fdm_hot_loop_case.py")


def _case(device: str, grid: str, steps: int, **extra: str) -> dict[str, str]:
    env = {"FDM_BENCH_DEVICE": device, "FDM_BENCH_GRID": grid, "FDM_BENCH_STEPS": str(steps)}
    env.update({f"FDM_BENCH_{key.upper()}": value for key, value in extra.items()})
    return env


# name -> environment overrides
SUITES: dict[str, list[tuple[str, dict[str, str]]]] = {
    "cpu": [
        ("cpu_ex_256x256x1", _case("cpu", "256,256,1", 400, demag="0")),
        ("cpu_ex_128x128x32", _case("cpu", "128,128,32", 100, demag="0")),
        ("cpu_full_256x256x1", _case("cpu", "256,256,1", 200)),
        ("cpu_full_128x128x32", _case("cpu", "128,128,32", 40)),
        ("cpu_full_rk45_128x128x32", _case("cpu", "128,128,32", 20, integrator="rk45")),
        ("cpu_hetero_ex_256x256x1", _case("cpu", "256,256,1", 400, demag="0", hetero="1")),
        ("cpu_hetero_full_128x128x32", _case("cpu", "128,128,32", 40, hetero="1")),
    ],
    # The CUDA lane reports no per-step wall time, so these cases are timed
    # by differencing against a run with a tenth of the steps; grids are kept
    # small enough that startup and result writing stay short.
    "gpu": [
        ("gpu_ex_256x256x8", _case("gpu", "256,256,8", 20000, demag="0")),
        ("gpu_ex_256x256x8_r64", _case("gpu", "256,256,8", 20000, demag="0", regions="64")),
        ("gpu_full_256x256x8", _case("gpu", "256,256,8", 4000)),
        ("gpu_full_256x256x8_r64", _case("gpu", "256,256,8", 4000, regions="64")),
        ("gpu_full_256x256x1", _case("gpu", "256,256,1", 20000)),
        ("gpu_fixed_rk45_256x256x1", _case("gpu", "256,256,1", 10000, integrator="rk45")),
        ("gpu_adaptive_rk45_256x256x1",
         _case("gpu", "256,256,1", 10000, integrator="rk45", adaptive="1")),
    ],
}

# A headless CLI run still publishes live previews.  On the CUDA lane those
# full-field device-to-host copies dominate wall time, so the solver is timed
# with them off unless ``--with-preview`` asks for the default behaviour.
PREVIEW_OFF_ENV = {
    "FULLMAG_DISABLE_PREVIEW_3D": "1",
    "FULLMAG_DISABLE_PREVIEW_2D": "1",
    "FULLMAG_DISABLE_LIVE_MAGNETIZATION": "1",
}


def run_case(name: str, overrides: dict[str, str], output: Path, attempt: int,
             fullmag_bin: str, keep_outputs: bool = False, with_preview: bool = False) -> dict:
    case_dir = output / "runs" / f"{name}-{attempt}"
    case_dir.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    # Detach from the group's live API: a headless run attached to it can be
    # stopped when the API replaces its current session.
    env["FULLMAG_API_PORT"] = "0"
    if not with_preview:
        env.update(PREVIEW_OFF_ENV)
    env.update(overrides)
    command = [fullmag_bin, str(CASE_SCRIPT), "--backend", "fdm", "--headless", "--json",
               "--output-dir", str(case_dir / "out")]
    started = time.perf_counter()
    completed = subprocess.run(command, env=env, capture_output=True, text=True)
    wall_s = time.perf_counter() - started
    (case_dir / "stdout.txt").write_text(completed.stdout)
    (case_dir / "stderr.txt").write_text(completed.stderr)
    artifacts = case_dir / "out" / "artifacts"
    step_ns = None
    m_final_sha256 = None
    steps_csv = artifacts / "solver_steps.csv"
    if steps_csv.is_file():
        with steps_csv.open(newline="") as handle:
            walls = [int(row["wall_time_ns"] or 0) for row in csv.DictReader(handle)]
        # The CUDA lane writes a single zero row for batched fixed-dt runs.
        if sum(walls) > 0:
            step_ns = sum(walls)
    m_final = artifacts / "m_final.json"
    if m_final.is_file():
        # Hash only the vector values: provenance carries per-run wall times.
        values = json.loads(m_final.read_text())["values"]
        m_final_sha256 = hashlib.sha256(json.dumps(values).encode()).hexdigest()
    gpu_counters = _gpu_receipt_counters(artifacts / "metadata.json")
    if steps_csv.is_file():
        shutil.copy2(steps_csv, case_dir / "solver_steps.csv")
    if not keep_outputs:
        # Field outputs of large grids fill a small scratch filesystem quickly.
        shutil.rmtree(case_dir / "out", ignore_errors=True)
    return {"case": name, "attempt": attempt, "env": overrides, "returncode": completed.returncode,
            "wall_s": wall_s, "step_s": None if step_ns is None else step_ns / 1e9,
            "m_final_sha256": m_final_sha256, "gpu": gpu_counters, "case_dir": str(case_dir)}


def _gpu_receipt_counters(metadata_path: Path) -> dict | None:
    """Transfer and adaptive-execution counters of a CUDA run's receipt."""
    if not metadata_path.is_file():
        return None
    metadata = json.loads(metadata_path.read_text())
    receipt = metadata.get("execution_provenance", {}).get("fdm_gpu_execution_receipt")
    if not receipt:
        return None
    transfers = receipt.get("transfer_counts", {})
    adaptive = receipt.get("adaptive_execution", {})
    return {
        "observation_d2h_count": transfers.get("observation_full_vector_d2h_count"),
        "observation_d2h_bytes": transfers.get("observation_full_vector_d2h_bytes"),
        "adaptive_realization": adaptive.get("realization"),
        "graph_launch_count": adaptive.get("graph_launch_count"),
        "step_completion_host_sync_count": adaptive.get("step_completion_host_sync_count"),
        "terminal_control_host_sync_count": adaptive.get("terminal_control_host_sync_count"),
        "observed_step_count": receipt.get("gpu_workspace", {}).get("observed_step_count"),
    }


def _accepted_steps(record: dict, requested: int) -> int:
    """Accepted steps of a run: the CUDA receipt's count, else the request."""
    observed = (record.get("gpu") or {}).get("observed_step_count")
    return observed if observed else requested


def _repeat(name: str, overrides: dict[str, str], args, results_path: Path) -> list[dict]:
    """Run one case ``args.repeat`` times; return the successful records."""
    records = []
    for attempt in range(args.repeat):
        record = run_case(name, overrides, args.output, attempt, args.fullmag_bin,
                          args.keep_outputs, args.with_preview)
        with results_path.open("a") as handle:
            handle.write(json.dumps(record) + "\n")
        status = "ok" if record["returncode"] == 0 else f"rc={record['returncode']}"
        print(f"{name} #{attempt}: wall {record['wall_s']:.2f} s, step {record['step_s']} s, "
              f"gpu {record['gpu']} {status}", file=sys.stderr)
        if record["returncode"] == 0:
            records.append(record)
    return records


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--suite", choices=sorted(SUITES), action="append", required=True)
    parser.add_argument("--case", action="append", default=[], help="run only these case names")
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--fullmag-bin", default="fullmag-bin")
    parser.add_argument("--keep-outputs", action="store_true",
                        help="keep each run's result bundle (large for 3D grids)")
    parser.add_argument("--with-preview", action="store_true",
                        help="keep the CLI live previews on (the headless default)")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    results_path = args.output / "results.jsonl"
    rows = []
    for suite in args.suite:
        for name, overrides in SUITES[suite]:
            if args.case and name not in args.case:
                continue
            steps = int(overrides["FDM_BENCH_STEPS"])
            runs = _repeat(name, overrides, args, results_path)
            per_step = [r["step_s"] / _accepted_steps(r, steps)
                        for r in runs if r["step_s"] is not None]
            method = "solver step time"
            if not per_step and runs:
                # Difference the wall time against a short run so startup and
                # result writing cancel; divide by the accepted-step difference.
                short = max(1, steps // 10)
                short_overrides = dict(overrides, FDM_BENCH_STEPS=str(short))
                short_runs = _repeat(f"{name}_short", short_overrides, args, results_path)
                if short_runs:
                    base_wall = statistics.median(r["wall_s"] for r in short_runs)
                    base_steps = statistics.median(_accepted_steps(r, short) for r in short_runs)
                    per_step = [(r["wall_s"] - base_wall) / (_accepted_steps(r, steps) - base_steps)
                                for r in runs]
                    method = f"wall({steps}) - median wall({short})"
            hashes = {r["m_final_sha256"] for r in runs if r["m_final_sha256"]}
            accepted = sorted({_accepted_steps(r, steps) for r in runs})
            rows.append((name, per_step, method, hashes, accepted))
    print("| case | runs | accepted steps | median per step [ms] | min [ms] | method "
          "| m_final sha256 |")
    print("|---|---:|---|---:|---:|---|---|")
    for name, per_step, method, hashes, accepted in rows:
        digest = ",".join(sorted(h[:12] for h in hashes)) or "-"
        steps_label = ",".join(str(value) for value in accepted)
        if per_step:
            print(f"| {name} | {len(per_step)} | {steps_label} | "
                  f"{1e3 * statistics.median(per_step):.3f} | {1e3 * min(per_step):.3f} | "
                  f"{method} | {digest} |")
        else:
            print(f"| {name} | 0 | - | failed | failed | - | - |")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
