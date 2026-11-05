#!/usr/bin/env python3
"""Read-only analysis of automatic runner performance artifacts.

Produces Polish Markdown, machine-readable statistics and scientific PNG/PDF
plots. Run against a completed `performance/` directory or its parent. It never
starts a solver. Plot memory is bounded by time bins, independently of row count.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
from typing import Any


def number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("nonfinite performance metric")
    return result


class Aggregate:
    def __init__(self) -> None:
        self.count = 0
        self.total = 0.0
        self.low = math.inf
        self.high = -math.inf

    def add(self, value: float | None) -> None:
        if value is not None:
            self.count += 1
            self.total += value
            self.low = min(self.low, value)
            self.high = max(self.high, value)

    def result(self) -> dict[str, Any]:
        return {"samples": self.count, "mean": self.total / self.count if self.count else None,
                "min": self.low if self.count else None, "max": self.high if self.count else None}


class Series:
    """Fixed-size time bins; no raw history array or hidden prefix truncation."""
    def __init__(self, duration: float, bins: int = 1024) -> None:
        self.duration = max(duration, 1e-9)
        self.bins = bins
        self.values: dict[str, dict[int, Aggregate]] = {}

    def add(self, key: str, elapsed: float, value: float | None) -> None:
        if value is None:
            return
        index = min(self.bins - 1, max(0, int(elapsed / self.duration * self.bins)))
        self.values.setdefault(key, {}).setdefault(index, Aggregate()).add(value)

    def points(self, key: str) -> tuple[list[float], list[float]]:
        data = self.values.get(key, {})
        indices = sorted(data)
        return ([(i + 0.5) * self.duration / self.bins for i in indices],
                [data[i].total / data[i].count for i in indices])


def analyze(root: Path) -> tuple[dict[str, Any], Series]:
    summary = json.loads((root / "summary.json").read_text())
    if summary.get("schema") != "fullmag.run_performance.v1":
        raise ValueError("unsupported performance schema")
    duration = number(summary.get("elapsed_monotonic_ns"))
    if duration is None or duration < 0:
        raise ValueError("missing or negative monotonic duration")
    duration /= 1e9
    series = Series(duration)
    phase_totals: dict[str, Aggregate] = {}
    row_count = 0
    first = last = None
    nonunit_gaps = 0
    previous_step = -1
    with (root / "steps.csv").open(newline="") as stream:
        reader = csv.DictReader(stream)
        if not reader.fieldnames or len(reader.fieldnames) != len(set(reader.fieldnames)):
            raise ValueError("missing or duplicate step CSV columns")
        for row in reader:
            step = int(row["step_index"])
            elapsed = float(row["elapsed_monotonic_ns"]) / 1e9
            if step <= previous_step or not math.isfinite(elapsed) or elapsed < 0:
                raise ValueError("step rows must be unique, increasing and finite")
            previous_step = step
            row_count += 1
            first = first or (elapsed, step)
            last = (elapsed, step)
            gap = number(row.get("step_gap_since_previous"))
            if gap is not None and gap > 1:
                nonunit_gaps += 1
            series.add("step", elapsed, float(step))
            latency = number(row.get("callback_delta_ns_per_step_gap"))
            series.add("step_ms", elapsed, latency / 1e6 if latency is not None else None)
            for key, raw in row.items():
                if key.startswith("relaxation_") and "wall_time_ns" in key:
                    value = number(raw)
                    if value is not None and value > 0:
                        phase_totals.setdefault(key, Aggregate()).add(value / 1e6)
    resource_metrics = {name: Aggregate() for name in ("cpu_percent", "rss_bytes", "gpu_percent", "vram_bytes", "power_watts")}
    gpu_ids: set[str] = set()
    unavailable_gpu_samples = 0
    resources_count = 0
    with (root / "resources.csv").open(newline="") as stream:
        for row in csv.DictReader(stream):
            resources_count += 1
            elapsed = float(row["elapsed_monotonic_ns"]) / 1e9
            gpu = json.loads(row["gpu_json"])
            if gpu.get("uuid"):
                gpu_ids.add(str(gpu["uuid"]))
            gpu_percent = number(gpu.get("utilization_percent"))
            unavailable_gpu_samples += gpu_percent is None
            values = {"cpu_percent": number(row.get("cpu_process_percent")), "rss_bytes": number(row.get("rss_bytes")),
                      "gpu_percent": gpu_percent, "vram_bytes": number(gpu.get("memory_used_bytes")),
                      "power_watts": number(gpu.get("power_watts"))}
            for key, value in values.items():
                resource_metrics[key].add(value)
                series.add(key, elapsed, value)
    window = (last[0] - first[0]) if first and last else 0
    rate = (last[1] - first[1]) / window if first and last and window > 0 else None
    if summary.get("callback_latency_availability") != "available_for_observed_callback_intervals":
        rate = None
    overhead = number(summary.get("collection_overhead_ns"))
    return {
        "schema": "fullmag.performance_report.v1", "identity": summary.get("identity"),
        "outcome": summary.get("outcome"), "realization": summary.get("realization"),
        "elapsed_monotonic_seconds": duration, "observed_step_rows": row_count,
        "observed_first_step": first[1] if first else None, "observed_last_step": last[1] if last else None,
        "observed_callback_window_seconds": window, "observed_steps_per_second": rate,
        "stage_steps_per_second": (summary.get("coverage", {}).get("accepted_step_index_span") or 0) / duration if duration else None,
        "nonunit_gap_rows": nonunit_gaps, "coverage": summary.get("coverage"),
        "collection_overhead_percent": overhead / (duration * 1e9) * 100 if overhead is not None and duration else None,
        "resources": {key: value.result() for key, value in resource_metrics.items()},
        "resource_samples": resources_count, "gpu_uuids": sorted(gpu_ids),
        "gpu_unavailable_samples": unavailable_gpu_samples,
        "nonzero_relaxation_phase_ms": {key: value.result() for key, value in phase_totals.items()},
        "phase_semantics": "host wall unless explicitly device elapsed; inclusive phases overlap and must not be summed",
        "gpu_scope": "whole_device_not_process_occupancy", "raw_summary": summary,
    }, series


def display(value: Any, digits: int = 3) -> str:
    return "N/A" if value is None else f"{value:.{digits}f}"


def render(report: dict[str, Any], series: Series, output: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(3, 2, figsize=(12, 10), constrained_layout=True)
    for ax, key, label, divisor in (
        (axes[0, 0], "step", "Zaakceptowany krok", 1),
        (axes[0, 1], "step_ms", "Czas między callbackami / krok [ms]", 1),
        (axes[1, 0], "cpu_percent", "CPU procesu [% jednego rdzenia]", 1),
        (axes[1, 1], "gpu_percent", "GPU całego urządzenia [%]", 1),
        (axes[2, 0], "rss_bytes", "RSS procesu [MiB]", 2**20),
        (axes[2, 1], "vram_bytes", "VRAM całego GPU [MiB]", 2**20),
    ):
        x, y = series.points(key)
        if y:
            ax.plot(x, [v / divisor for v in y], linewidth=1, marker="." if len(x) < 3 else None)
        else:
            ax.text(0.5, 0.5, "N/A — brak pomiaru", transform=ax.transAxes, ha="center")
        ax.set(xlabel="Czas monotoniczny [s]", ylabel=label)
        ax.set_xlim(0, max(series.duration, 1e-6))
        ax.grid(alpha=0.2)
    fig.suptitle("Fullmag — wydajność przebiegu; średnie w ograniczonych koszykach czasu")
    fig.savefig(output / "performance.png", dpi=170)
    fig.savefig(output / "performance.pdf")
    plt.close(fig)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, help="Prior report JSON or audit summary; comparison is descriptive, not parity qualification")
    parser.add_argument("--no-plots", action="store_true")
    args = parser.parse_args()
    root = args.run if (args.run / "summary.json").is_file() else args.run / "performance"
    report, series = analyze(root)
    if args.output_dir.resolve() == root.resolve():
        parser.error("report directory must differ from the immutable input directory")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    inputs = {}
    for name in ("summary.json", "steps.csv", "resources.csv"):
        digest = hashlib.sha256()
        with (root / name).open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
        inputs[name] = digest.hexdigest()
    report["input_sha256"] = inputs
    if args.baseline:
        baseline = json.loads(args.baseline.read_text())
        rate = baseline.get("observed_steps_per_second", baseline.get("steps_per_second"))
        report["comparison"] = {"baseline": str(args.baseline), "baseline_steps_per_second": rate,
            "observed_rate_ratio": report["observed_steps_per_second"] / rate if rate and report["observed_steps_per_second"] else None,
            "qualification": "descriptive_only; verify equal input/state, precision, tolerance and publication workload before claiming speedup"}
    (args.output_dir / "benchmark.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    resources = report["resources"]
    rows = [
        ("Czas etapu runnera [s]", report["elapsed_monotonic_seconds"]),
        ("Kroki/s — okno callbacków", report["observed_steps_per_second"]),
        ("Kroki/s — etap z inicjalizacją i finalizacją runnera", report["stage_steps_per_second"]),
        ("CPU procesu [% jednego rdzenia], średnia", resources["cpu_percent"]["mean"]),
        ("GPU całego urządzenia [%], średnia", resources["gpu_percent"]["mean"]),
        ("Narzut callbacku pomiarowego [% czasu przebiegu]", report["collection_overhead_percent"]),
    ]
    text = "# Benchmark wydajności Fullmag\n\n"
    text += f"Stan: `{report['outcome']}`. Realizacja: `{report['realization']}`. Identyfikacja wejścia i pokrycie znajdują się w `benchmark.json`.\n\n"
    text += "| Metryka | Wartość |\n|---|---:|\n" + "".join(f"| {key} | {display(value)} |\n" for key, value in rows)
    text += "\nCzas etapu runnera obejmuje jego inicjalizację i finalizację; przygotowanie siatki i admission mają odrębny zakres. Wykorzystanie GPU dotyczy całego urządzenia i nie jest occupancy ani pomiarem wyłącznie workera. N/A oznacza brak pomiaru. Fazy inkluzywne i czasy urządzenia mogą się nakładać; nie sumujemy ich jako rozłącznych składników. Luki callbacków nie są uzupełniane sztucznymi krokami. Narzut callbacku nie obejmuje pracy niezależnego wątku samplera.\n"
    if "comparison" in report:
        text += f"\nOpisowe porównanie do wskazanego baseline: iloraz szybkości {display(report['comparison']['observed_rate_ratio'])}. Zgodność stanu początkowego, tolerancji i obciążenia publikacją wymaga osobnego dowodu.\n"
    if not args.no_plots:
        render(report, series, args.output_dir)
        text += "\n![Wydajność przebiegu](performance.png)\n"
    (args.output_dir / "BENCHMARK.md").write_text(text)
    print(json.dumps({"report": str(args.output_dir / "BENCHMARK.md"), "observed_steps_per_second": report["observed_steps_per_second"]}))


if __name__ == "__main__":
    main()
