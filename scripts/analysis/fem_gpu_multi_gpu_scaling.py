#!/usr/bin/env python3
"""Multi-GPU strong and weak scaling analysis and promotion gate for FEM GPU.

Records single-GPU baseline, evaluates 2+ GPU scaling:
total time, compute time, communication time, load imbalance, scaling efficiency,
and numerical parity. Enforces fail-closed gate against host staging and low efficiency.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass
class RankReceipt:
    world_rank: int
    local_rank: int
    device_ordinal: int
    device_uuid: str
    host_staging: bool
    cuda_aware_mpi: bool
    compute_time_sec: float
    comm_time_sec: float
    total_time_sec: float


@dataclass
class ScalingRunReport:
    gpu_count: int
    baseline_time_sec: float
    total_time_sec: float
    speedup: float
    efficiency: float
    imbalance: float
    host_staging_detected: bool
    parity_passed: bool
    promotable: bool
    rejection_reason: Optional[str] = None


def analyze_multi_gpu_scaling(
    receipts: List[RankReceipt],
    baseline_time_sec: float,
    min_efficiency: float = 0.70,
    max_imbalance: float = 0.20,
    tol_parity: float = 1.0e-9,
    measured_error: float = 0.0,
) -> ScalingRunReport:
    gpu_count = len(receipts)
    if gpu_count == 0:
        return ScalingRunReport(
            gpu_count=0,
            baseline_time_sec=baseline_time_sec,
            total_time_sec=0.0,
            speedup=0.0,
            efficiency=0.0,
            imbalance=1.0,
            host_staging_detected=False,
            parity_passed=False,
            promotable=False,
            rejection_reason="No receipts provided",
        )

    # Check host staging
    host_staging = any(r.host_staging or not r.cuda_aware_mpi for r in receipts)

    # Max total time across ranks defines parallel execution time
    total_time = max(r.total_time_sec for r in receipts)
    min_time = min(r.total_time_sec for r in receipts)
    imbalance = (total_time - min_time) / max(total_time, 1.0e-12)

    speedup = baseline_time_sec / max(total_time, 1.0e-12)
    efficiency = speedup / gpu_count

    parity_passed = measured_error <= tol_parity

    promotable = True
    rejection_reason = None

    if host_staging:
        promotable = False
        rejection_reason = "Host staging detected or CUDA-aware MPI transport missing"
    elif not parity_passed:
        promotable = False
        rejection_reason = f"Numerical parity failed: error {measured_error} > tol {tol_parity}"
    elif efficiency < min_efficiency:
        promotable = False
        rejection_reason = f"Scaling efficiency {efficiency:.3f} below minimum {min_efficiency:.3f}"
    elif imbalance > max_imbalance:
        promotable = False
        rejection_reason = f"Load imbalance {imbalance:.3f} exceeds maximum {max_imbalance:.3f}"

    return ScalingRunReport(
        gpu_count=gpu_count,
        baseline_time_sec=baseline_time_sec,
        total_time_sec=total_time,
        speedup=speedup,
        efficiency=efficiency,
        imbalance=imbalance,
        host_staging_detected=host_staging,
        parity_passed=parity_passed,
        promotable=promotable,
        rejection_reason=rejection_reason,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Multi-GPU scaling analyzer")
    parser.add_argument("--receipts-json", required=True, help="Path to JSON receipts")
    parser.add_argument("--baseline-time-sec", type=float, required=True, help="Single-GPU baseline time")
    parser.add_argument("--min-efficiency", type=float, default=0.70)
    parser.add_argument("--max-imbalance", type=float, default=0.20)
    parser.add_argument("--parity-error", type=float, default=0.0)
    parser.add_argument("--output-json", help="Output JSON report path")

    args = parser.parse_args()

    data = json.loads(Path(args.receipts_json).read_text(encoding="utf-8"))
    receipts = [RankReceipt(**item) for item in data]

    report = analyze_multi_gpu_scaling(
        receipts=receipts,
        baseline_time_sec=args.baseline_time_sec,
        min_efficiency=args.min_efficiency,
        max_imbalance=args.max_imbalance,
        measured_error=args.parity_error,
    )

    report_dict = asdict(report)
    out_json = json.dumps(report_dict, indent=2)

    if args.output_json:
        Path(args.output_json).write_text(out_json, encoding="utf-8")

    print(out_json)
    return 0 if report.promotable else 1


if __name__ == "__main__":
    sys.exit(main())
