#!/usr/bin/env python3
"""S18: FEM GPU performance benchmark suite.

Runs a standard problem across mesh sizes and records timing metrics.
Results are appended to a CSV for post-processing.

Usage:
    python3 scripts/analysis/fem_gpu_benchmark.py [--sizes 10k,50k,100k]

Requires: built fullmag-cli or the Python harness with native FEM backend.
"""

import argparse
import csv
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# Default mesh node counts for the benchmark sweep
DEFAULT_SIZES = [10_000, 50_000, 100_000, 500_000, 1_000_000]

BENCHMARK_DIR = Path(__file__).resolve().parent.parent.parent / "docs" / "reports"
CSV_PATH = BENCHMARK_DIR / "fem_gpu_benchmark_results.csv"


def parse_args():
    parser = argparse.ArgumentParser(description="FEM GPU benchmark suite")
    parser.add_argument(
        "--sizes",
        type=str,
        default=None,
        help="Comma-separated node counts (e.g., 10000,50000,100000)",
    )
    parser.add_argument(
        "--steps", type=int, default=100, help="Number of LLG steps per mesh"
    )
    parser.add_argument(
        "--output", type=str, default=str(CSV_PATH), help="Output CSV path"
    )
    return parser.parse_args()


def generate_sphere_mesh(target_nodes: int) -> dict:
    """Generate a sphere mesh description for the benchmark.

    Returns a dict with mesh parameters; actual mesh generation
    is delegated to the fullmag Python meshing pipeline.
    """
    # Estimate element size from target node count
    # For a unit sphere, V = 4/3 π → roughly n_tets ≈ 6 * n_nodes
    # hmax ≈ (V / n_tets)^(1/3)
    import math

    volume = 4.0 / 3.0 * math.pi * (50e-9) ** 3  # 50nm radius sphere
    n_tets_est = max(1, 6 * target_nodes)
    hmax = (volume / n_tets_est) ** (1.0 / 3.0)

    return {
        "shape": "sphere",
        "radius_m": 50e-9,
        "hmax_m": hmax,
        "target_nodes": target_nodes,
    }


def run_benchmark(mesh_desc: dict, n_steps: int) -> dict:
    """Run a single benchmark and return timing metrics.

    Placeholder: in production, this calls the fullmag runner
    via CLI or Python API.
    """
    result = {
        "target_nodes": mesh_desc["target_nodes"],
        "hmax_m": mesh_desc["hmax_m"],
        "n_steps": n_steps,
        "step_time_ms": None,
        "exchange_time_ms": None,
        "demag_solve_time_ms": None,
        "llg_rhs_time_ms": None,
        "demag_cg_iterations": None,
        "gpu_memory_mb": None,
        "status": "not_implemented",
    }
    # TODO: Wire up to actual runner when backend is ready
    return result


def write_csv(results: list[dict], output_path: str):
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    if not results:
        return
    fieldnames = list(results[0].keys())
    with open(output_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in results:
            writer.writerow(row)
    print(f"Results written to {output_path}")


def main():
    args = parse_args()
    sizes = DEFAULT_SIZES
    if args.sizes:
        sizes = [int(s.strip().replace("k", "000")) for s in args.sizes.split(",")]

    print(f"FEM GPU Benchmark: sizes={sizes}, steps={args.steps}")
    results = []
    for target in sizes:
        mesh_desc = generate_sphere_mesh(target)
        print(f"  Running {target} nodes (hmax={mesh_desc['hmax_m']:.2e})...")
        result = run_benchmark(mesh_desc, args.steps)
        results.append(result)
        print(f"    status={result['status']}")

    write_csv(results, args.output)


if __name__ == "__main__":
    main()
