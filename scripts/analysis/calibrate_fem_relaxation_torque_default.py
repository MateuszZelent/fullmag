#!/usr/bin/env python3
"""Qualify a default relaxation torque tolerance from FEM CPU/GPU sweeps."""

from __future__ import annotations

import argparse
import csv
import json
import math
import struct
import zlib
from collections import defaultdict
from collections.abc import Mapping, Sequence
from pathlib import Path


MU0 = 4.0 * math.pi * 1.0e-7
DEFAULT_PHYSICAL_CAP_T = 1.0e-4
DEFAULT_SAFETY_FACTOR = 2.0
MAX_LAST_BUDGET_CHANGE = 0.10
MAX_FINAL_TO_INITIAL_RATIO = 0.25
MAX_CPU_GPU_SPREAD = 0.10


def finite_float(row: Mapping[str, object], field: str) -> float | None:
    try:
        value = float(row.get(field, ""))
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def positive_int(row: Mapping[str, object], field: str) -> int | None:
    try:
        value = int(row.get(field, ""))
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def case_key(row: Mapping[str, object]) -> tuple[str, ...]:
    return (
        str(row.get("solver_mesh_signature") or ""),
        str(row.get("scenario") or ""),
        str(row.get("integrator") or ""),
        str(row.get("timestep_policy") or ""),
        str(row.get("demag_model") or "none"),
    )


def round_up_one_significant_digit(value: float) -> float:
    exponent = math.floor(math.log10(value))
    scale = 10.0**exponent
    return math.ceil(value / scale) * scale


def relative_difference(left: float, right: float) -> float:
    return abs(left - right) / max(abs(left), abs(right), 1.0e-300)


def analyze_rows(
    rows: Sequence[Mapping[str, object]],
    *,
    physical_cap_t: float = DEFAULT_PHYSICAL_CAP_T,
    safety_factor: float = DEFAULT_SAFETY_FACTOR,
) -> dict[str, object]:
    failures: list[str] = []
    usable = [
        row
        for row in rows
        if row.get("status") == "ok"
        and row.get("relaxation_algorithm") == "llg_overdamped"
        and row.get("backend") in {"fem_cpu", "fem_gpu"}
    ]
    if not usable:
        return {
            "schema": "fullmag.relaxation-torque-calibration.v1",
            "qualified": False,
            "failures": ["no successful llg_overdamped FEM CPU/GPU rows"],
            "case_count": 0,
            "recommended_torque_tolerance_apm": None,
            "recommended_torque_tolerance_t": None,
        }

    meshes = {str(row.get("solver_mesh_signature") or "") for row in usable}
    policies = {str(row.get("timestep_policy") or "") for row in usable}
    scenarios = {str(row.get("scenario") or "") for row in usable}
    if "" in meshes or len(meshes) < 2:
        failures.append("calibration requires at least two stable solver mesh signatures")
    if not {"fixed", "adaptive"}.issubset(policies):
        failures.append("calibration requires fixed and adaptive timestep policies")
    if not any("exchange_only" in scenario for scenario in scenarios):
        failures.append("calibration requires an exchange-only scenario")
    if not any("demag" in scenario for scenario in scenarios):
        failures.append("calibration requires a production demag scenario")

    grouped: dict[tuple[str, ...], dict[str, dict[int, float]]] = defaultdict(
        lambda: defaultdict(dict)
    )
    for row in usable:
        backend = str(row["backend"])
        steps = positive_int(row, "steps")
        torque = finite_float(row, "final_torque_apm")
        if steps is None or torque is None or torque < 0.0:
            failures.append(f"case={case_key(row)} has invalid steps or final torque")
            continue
        grouped[case_key(row)][backend][steps] = torque

    qualified_floors: list[float] = []
    case_summaries: list[dict[str, object]] = []
    for key, by_backend in sorted(grouped.items()):
        if set(by_backend) != {"fem_cpu", "fem_gpu"}:
            failures.append(f"case={key} requires matching FEM CPU and GPU rows")
            continue
        common_steps = sorted(set(by_backend["fem_cpu"]) & set(by_backend["fem_gpu"]))
        if len(common_steps) < 3:
            failures.append(f"case={key} requires at least three common step budgets")
            continue

        first_steps, previous_steps, final_steps = common_steps[0], common_steps[-2], common_steps[-1]
        final_values = [by_backend[backend][final_steps] for backend in ("fem_cpu", "fem_gpu")]
        previous_values = [
            by_backend[backend][previous_steps] for backend in ("fem_cpu", "fem_gpu")
        ]
        initial_values = [by_backend[backend][first_steps] for backend in ("fem_cpu", "fem_gpu")]
        last_budget_change = max(
            relative_difference(previous, final)
            for previous, final in zip(previous_values, final_values)
        )
        final_to_initial = max(
            final / max(initial, 1.0e-300)
            for initial, final in zip(initial_values, final_values)
        )
        cpu_gpu_spread = relative_difference(final_values[0], final_values[1])

        case_failures: list[str] = []
        if last_budget_change > MAX_LAST_BUDGET_CHANGE:
            case_failures.append(
                f"not plateaued: last-budget torque change {last_budget_change:.6g} exceeds {MAX_LAST_BUDGET_CHANGE:.6g}"
            )
        if final_to_initial > MAX_FINAL_TO_INITIAL_RATIO:
            case_failures.append(
                f"insufficient relaxation: final/initial torque {final_to_initial:.6g} exceeds {MAX_FINAL_TO_INITIAL_RATIO:.6g}"
            )
        if cpu_gpu_spread > MAX_CPU_GPU_SPREAD:
            case_failures.append(
                f"CPU/GPU torque spread {cpu_gpu_spread:.6g} exceeds {MAX_CPU_GPU_SPREAD:.6g}"
            )
        if case_failures:
            failures.extend(f"case={key} {failure}" for failure in case_failures)
        else:
            qualified_floors.extend(final_values)
        case_summaries.append(
            {
                "case_key": list(key),
                "step_budgets": common_steps,
                "final_cpu_torque_apm": final_values[0],
                "final_gpu_torque_apm": final_values[1],
                "last_budget_change": last_budget_change,
                "final_to_initial_ratio": final_to_initial,
                "cpu_gpu_spread": cpu_gpu_spread,
                "qualified": not case_failures,
            }
        )

    recommendation_apm: float | None = None
    recommendation_t: float | None = None
    if qualified_floors and not failures:
        recommendation_apm = round_up_one_significant_digit(
            safety_factor * max(qualified_floors)
        )
        recommendation_t = recommendation_apm * MU0
        if recommendation_t > physical_cap_t:
            failures.append(
                f"recommended {recommendation_t:.6g} T exceeds physical cap {physical_cap_t:.6g} T"
            )

    qualified = bool(qualified_floors) and not failures
    return {
        "schema": "fullmag.relaxation-torque-calibration.v1",
        "qualified": qualified,
        "failures": failures,
        "case_count": len(grouped),
        "physical_cap_t": physical_cap_t,
        "safety_factor": safety_factor,
        "recommended_torque_tolerance_apm": recommendation_apm if qualified else None,
        "recommended_torque_tolerance_t": recommendation_t if qualified else None,
        "cases": case_summaries,
    }


def read_rows(paths: Sequence[Path]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for path in paths:
        with path.open(newline="", encoding="utf-8") as handle:
            rows.extend(csv.DictReader(handle))
    return rows


def write_plot(rows: Sequence[Mapping[str, object]], result: Mapping[str, object], path: Path) -> None:
    grouped: dict[tuple[str, str, str], list[tuple[int, float]]] = defaultdict(list)
    for row in rows:
        steps = positive_int(row, "steps")
        torque = finite_float(row, "final_torque_apm")
        if steps is None or torque is None or torque <= 0.0:
            continue
        label = (
            str(row.get("backend") or ""),
            str(row.get("scenario") or ""),
            str(row.get("solver_mesh_signature") or "")[:8],
        )
        grouped[label].append((steps, torque))
    all_values = [value for values in grouped.values() for value in values]
    if not all_values:
        raise ValueError("cannot plot calibration without positive torque samples")
    recommendation = result.get("recommended_torque_tolerance_apm")
    width, height = 1200, 720
    left, right, top, bottom = 90, 35, 35, 75
    pixels = bytearray([255] * (width * height * 3))

    def set_pixel(x: int, y: int, color: tuple[int, int, int]) -> None:
        if 0 <= x < width and 0 <= y < height:
            offset = (y * width + x) * 3
            pixels[offset : offset + 3] = bytes(color)

    def line(x0: int, y0: int, x1: int, y1: int, color: tuple[int, int, int]) -> None:
        dx, sx = abs(x1 - x0), 1 if x0 < x1 else -1
        dy, sy = -abs(y1 - y0), 1 if y0 < y1 else -1
        error = dx + dy
        while True:
            set_pixel(x0, y0, color)
            if x0 == x1 and y0 == y1:
                break
            doubled = 2 * error
            if doubled >= dy:
                error += dy
                x0 += sx
            if doubled <= dx:
                error += dx
                y0 += sy

    x_logs = [math.log2(steps) for steps, _ in all_values]
    y_logs = [math.log10(torque) for _, torque in all_values]
    if isinstance(recommendation, (int, float)) and recommendation > 0.0:
        y_logs.append(math.log10(recommendation))
    x_min, x_max = min(x_logs), max(x_logs)
    y_min, y_max = min(y_logs), max(y_logs)
    if x_min == x_max:
        x_max += 1.0
    if y_min == y_max:
        y_max += 1.0

    def point(steps: int, torque: float) -> tuple[int, int]:
        x = left + round((math.log2(steps) - x_min) / (x_max - x_min) * (width - left - right))
        y = top + round((y_max - math.log10(torque)) / (y_max - y_min) * (height - top - bottom))
        return x, y

    grid = (220, 220, 220)
    axis = (30, 30, 30)
    for index in range(6):
        x = left + round(index / 5 * (width - left - right))
        line(x, top, x, height - bottom, grid)
        y = top + round(index / 5 * (height - top - bottom))
        line(left, y, width - right, y, grid)
    line(left, top, left, height - bottom, axis)
    line(left, height - bottom, width - right, height - bottom, axis)

    colors = (
        (31, 119, 180),
        (255, 127, 14),
        (44, 160, 44),
        (214, 39, 40),
        (148, 103, 189),
        (140, 86, 75),
        (227, 119, 194),
        (23, 190, 207),
    )
    for index, (_, values) in enumerate(sorted(grouped.items())):
        points = [point(steps, torque) for steps, torque in sorted(values)]
        color = colors[index % len(colors)]
        for start, end in zip(points, points[1:]):
            line(*start, *end, color)
        for x, y in points:
            for offset_x in range(-3, 4):
                for offset_y in range(-3, 4):
                    set_pixel(x + offset_x, y + offset_y, color)
    if isinstance(recommendation, (int, float)) and recommendation > 0.0:
        _, y = point(int(2**x_min), recommendation)
        for x in range(left, width - right, 8):
            line(x, y, min(x + 4, width - right), y, axis)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    scanlines = b"".join(
        b"\x00" + bytes(pixels[row * width * 3 : (row + 1) * width * 3])
        for row in range(height)
    )
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(scanlines, level=9))
        + chunk(b"IEND", b"")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="+", type=Path, help="Benchmark CSV files")
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--plot", type=Path, required=True)
    parser.add_argument("--physical-cap-t", type=float, default=DEFAULT_PHYSICAL_CAP_T)
    parser.add_argument("--safety-factor", type=float, default=DEFAULT_SAFETY_FACTOR)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    rows = read_rows(args.inputs)
    result = analyze_rows(
        rows,
        physical_cap_t=args.physical_cap_t,
        safety_factor=args.safety_factor,
    )
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    args.summary.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    write_plot(rows, result, args.plot)
    if not result["qualified"]:
        for failure in result["failures"]:
            print(f"RELAXATION_TORQUE_CALIBRATION_ERROR={failure}")
        raise SystemExit(2)
    print(
        "RELAXATION_TORQUE_CALIBRATION="
        + json.dumps(
            {
                "torque_tolerance_apm": result["recommended_torque_tolerance_apm"],
                "torque_tolerance_t": result["recommended_torque_tolerance_t"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
