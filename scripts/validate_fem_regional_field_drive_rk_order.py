#!/usr/bin/env python3
"""Validate fixed-final-time RK order and regional-drive event/energy contracts."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


EXPECTED_ORDER = {"heun": 2.0, "rk4": 4.0, "rk23": 3.0, "rk45": 5.0}


def regression_slope(steps: list[float], errors: list[float]) -> float:
    if len(steps) < 3 or len(steps) != len(errors):
        raise ValueError("each integrator requires at least three equal-length dt/error values")
    if any(value <= 0 or not math.isfinite(value) for value in (*steps, *errors)):
        raise ValueError("dt and error values must be finite and positive")
    x = [math.log(value) for value in steps]
    y = [math.log(value) for value in errors]
    x_mean = sum(x) / len(x)
    y_mean = sum(y) / len(y)
    denominator = sum((value - x_mean) ** 2 for value in x)
    return sum((xi - x_mean) * (yi - y_mean) for xi, yi in zip(x, y)) / denominator


def validate(payload: dict[str, object]) -> list[str]:
    failures: list[str] = []
    integrators = payload.get("integrators")
    if not isinstance(integrators, dict):
        return ["missing integrators object"]
    for name, expected in EXPECTED_ORDER.items():
        record = integrators.get(name)
        if not isinstance(record, dict):
            failures.append(f"missing integrator {name}")
            continue
        try:
            slope = regression_slope(list(record["dt_s"]), list(record["error"]))
        except (KeyError, TypeError, ValueError) as error:
            failures.append(f"{name}: {error}")
            continue
        if abs(slope - expected) > 0.5:
            failures.append(f"{name}: observed order {slope:.4g}, expected {expected} +/- 0.5")

    events = payload.get("events")
    if not isinstance(events, dict) or events.get("crossing_contamination") is not False:
        failures.append("pulse/PWL event crossing contamination was not proven absent")
    if not isinstance(events, dict) or events.get("fsal_invalidated_at_discontinuity") is not True:
        failures.append("FSAL invalidation at discontinuities was not proven")

    energy = payload.get("energy")
    if not isinstance(energy, dict):
        failures.append("missing drive energy oracle")
    else:
        measured = float(energy.get("measured_j", math.nan))
        oracle = float(energy.get("minus_mu0_integral_j", math.nan))
        tolerance = float(energy.get("absolute_tolerance_j", 0.0))
        if not all(math.isfinite(value) for value in (measured, oracle, tolerance)):
            failures.append("drive energy oracle contains non-finite values")
        elif abs(measured - oracle) > tolerance:
            failures.append(
                f"drive energy mismatch: measured={measured:.9e}, oracle={oracle:.9e}, tolerance={tolerance:.3e}"
            )
    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", type=Path)
    args = parser.parse_args()
    failures = validate(json.loads(args.artifact.read_text(encoding="utf-8")))
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}")
        return 1
    print("PASS: FEM regional field-drive RK order, event, and energy contracts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
