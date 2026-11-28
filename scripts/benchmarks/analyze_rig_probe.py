"""Summarise the rig emulation results (results.jsonl written by rig_probe.py).

Usage: python3 scripts/benchmarks/analyze_rig_probe.py <results dir> [--json out.json]

Per run: wall time, CPU time (user + system, exact from getrusage), CPU load (CPU time / wall time),
peak RSS of the process tree, threads, context switches, PCIe bytes of the whole GPU minus the
idle background (mean of the idle baselines), and the time those bytes would take on a PCIe x1 link.

E2 pairs (10 and 110 steps, same strategy and config) are differenced: per-step cost =
(cost_110 - cost_10) / 100 and setup cost = cost_10 - 10 * per-step cost. This removes setup and
teardown from the per-step numbers without relying on any timer inside fullmag.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path

X1_GEN3_BYTES_PER_S = 0.8e9   # practical PCIe 3.0 x1 copy rate (raw link 0.985 GB/s)
X1_GEN2_BYTES_PER_S = 0.4e9   # practical PCIe 2.0 x1 copy rate (raw link 0.5 GB/s)


def load(root: Path) -> tuple[dict[str, dict], dict]:
    runs, idle = {}, []
    for line in (root / "results.jsonl").read_text().splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        if record.get("kind") == "idle_baseline":
            idle.append(record)
        elif record.get("kind") == "run":
            runs[record["label"]] = record
    rates = {}
    for key in ("pcie_tx_bytes", "pcie_rx_bytes"):
        values = [r[key] / r["span_s"] for r in idle if r.get(key) is not None and r.get("span_s")]
        rates[key] = sum(values) / len(values) if values else 0.0
    rates["samples"] = [{k: r.get(k) for k in ("label", "span_s", "pcie_tx_bytes", "pcie_rx_bytes")}
                        for r in idle]
    return runs, rates


def cpu_s(record: dict) -> float:
    return record["rusage"]["user_s"] + record["rusage"]["system_s"]


def pcie(record: dict, key: str, rates: dict) -> float | None:
    raw = record.get(key)
    if raw is None:
        return None
    return max(0.0, raw - rates[key] * record.get("pcie_window_s", record["wall_s"]))


def pcie_total(record: dict, rates: dict) -> float | None:
    tx, rx = pcie(record, "pcie_tx_bytes", rates), pcie(record, "pcie_rx_bytes", rates)
    return None if tx is None or rx is None else tx + rx


def run_dir(root: Path, record: dict) -> Path | None:
    candidates = sorted((root / "runs").glob(f"{record['label']}-*"))
    return candidates[-1] if candidates else None


def solver_choice(record: dict) -> str:
    counters = record.get("receipt_counters", {})
    picked = {k: v for k, v in counters.items()
              if re.search(r"strategy|fallback|linear_solver|direct", k, re.I) and v not in (None, "", [])}
    return "; ".join(f"{k.split('.')[-1]}={v}" for k, v in list(picked.items())[:6])


def describe(record: dict, rates: dict) -> dict:
    wall = record["wall_s"]
    cpu = cpu_s(record)
    total = pcie_total(record, rates)
    return {
        "label": record["label"],
        "rc": record["returncode"],
        "wall_s": round(wall, 2),
        "cpu_s": round(cpu, 2),
        "cpu_load": round(cpu / wall, 2) if wall else None,
        "peak_rss_mib": round(record["process_tree_peak_rss_bytes"] / 2**20),
        "max_rss_largest_mib": round(record["rusage"]["max_rss_largest_process_bytes"] / 2**20),
        "threads_peak": record["process_tree_peak_threads"],
        "minflt": record["rusage"]["minflt"],
        "vol_switches": record["rusage"]["voluntary_switches"],
        "invol_switches": record["rusage"]["involuntary_switches"],
        "affinity": record.get("affinity_last"),
        "pcie_mb": round(total / 1e6, 1) if total is not None else None,
        "pcie_x1_gen3_s": round(total / X1_GEN3_BYTES_PER_S, 2) if total is not None else None,
        "gpu_mem_before_mib": record.get("gpu_memory_before_mib"),
        "gpu_mem_peak_sampled_mib": record.get("gpu_memory_peak_sampled_mib"),
        "gpu_util_samples": record.get("gpu_util_samples_pct"),
        "neighbor_cpu_s": record.get("neighbor_cpu_s"),
        "mesh": record.get("mesh"),
        "solver": solver_choice(record),
        "error_tail": record.get("error_tail", "")[-300:],
    }


def differenced(short: dict, long: dict, rates: dict, steps_short: int, steps_long: int) -> dict:
    n = steps_long - steps_short
    step_wall = (long["wall_s"] - short["wall_s"]) / n
    step_cpu = (cpu_s(long) - cpu_s(short)) / n
    out = {
        "step_wall_ms": round(1e3 * step_wall, 2),
        "step_cpu_ms": round(1e3 * step_cpu, 2),
        "step_cpu_load": round(step_cpu / step_wall, 2) if step_wall > 0 else None,
        "setup_wall_s": round(short["wall_s"] - steps_short * step_wall, 2),
        "setup_cpu_s": round(cpu_s(short) - steps_short * step_cpu, 2),
    }
    p_short, p_long = pcie_total(short, rates), pcie_total(long, rates)
    if p_short is not None and p_long is not None:
        step_bytes = (p_long - p_short) / n
        out["step_pcie_kb"] = round(step_bytes / 1e3, 1)
        out["setup_pcie_mb"] = round((p_short - steps_short * step_bytes) / 1e6, 1)
        out["step_pcie_x1_gen3_ms"] = round(1e3 * step_bytes / X1_GEN3_BYTES_PER_S, 2)
        out["step_pcie_x1_gen2_ms"] = round(1e3 * step_bytes / X1_GEN2_BYTES_PER_S, 2)
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("--json", type=Path)
    args = parser.parse_args()
    runs, rates = load(args.root)
    summary = {"idle_background_bytes_per_s": {k: round(v) for k, v in rates.items() if k != "samples"},
               "idle_samples": rates["samples"], "runs": {}, "e2_differenced": {}}
    for label, record in runs.items():
        summary["runs"][label] = describe(record, rates)
    for strategy in ("auto", "cg_amg", "cudss"):
        for config in ("A", "B"):
            short = runs.get(f"e2_{strategy}_{config}_s10")
            long = runs.get(f"e2_{strategy}_{config}_s110")
            if short and long and short["returncode"] == 0 and long["returncode"] == 0:
                summary["e2_differenced"][f"{strategy}_{config}"] = differenced(short, long, rates, 10, 110)
    print(json.dumps({k: v for k, v in summary.items() if k != "runs"}, indent=1))
    header = ["label", "rc", "wall_s", "cpu_s", "cpu_load", "peak_rss_mib", "threads_peak",
              "vol_switches", "invol_switches", "pcie_mb", "pcie_x1_gen3_s", "gpu_mem_peak_sampled_mib",
              "solver"]
    print("\t".join(header))
    for row in summary["runs"].values():
        print("\t".join(str(row.get(h)) for h in header))
    if args.json:
        args.json.write_text(json.dumps(summary, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
