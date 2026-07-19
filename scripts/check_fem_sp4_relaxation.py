#!/usr/bin/env python3
"""Fail-closed readiness check for a completed FEM SP4 relaxation bundle."""

from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path


TORQUE_LIMIT_T = 1e-5
ENERGY_RELATIVE_BUDGET = 1e-10


def _qualification(
    metadata: dict[str, object],
    expected_device: str | None,
) -> dict[str, object] | None:
    if expected_device is not None:
        value = metadata.get(f"fem_{expected_device}_relaxation_qualification")
        return value if isinstance(value, dict) else None
    for key in (
        "fem_gpu_relaxation_qualification",
        "fem_cpu_relaxation_qualification",
    ):
        value = metadata.get(key)
        if isinstance(value, dict):
            return value
    return None


def _finite_float(value: object) -> float:
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("non-finite numeric value")
    return result


def _scalar_tail_is_ready(path: Path) -> bool:
    with path.open(newline="", encoding="utf-8") as stream:
        reader = csv.DictReader(stream)
        required = {"E_total", "max_torque_T"}
        if not required.issubset(reader.fieldnames or ()):
            return False
        rows = list(reader)
    if len(rows) < 2:
        return False
    energies = [_finite_float(row["E_total"]) for row in rows]
    torques = [_finite_float(row["max_torque_T"]) for row in rows]
    tail = energies[-min(10, len(energies)) :]
    scale = max(max(abs(value) for value in tail), 1e-30)
    budget = ENERGY_RELATIVE_BUDGET * scale
    if any(right - left > budget for left, right in zip(tail, tail[1:])):
        return False
    if tail[-1] - tail[0] > budget:
        return False
    return 0.0 <= torques[-1] <= TORQUE_LIMIT_T


def _field_is_finite(path: Path) -> bool:
    field = json.loads(path.read_text(encoding="utf-8"))
    values = field.get("values") if isinstance(field, dict) else None
    if not isinstance(values, list) or not values:
        return False
    for vector in values:
        if not isinstance(vector, list) or len(vector) != 3:
            return False
        if not all(math.isfinite(float(component)) for component in vector):
            return False
    return True


def relaxation_is_ready(
    artifacts: Path,
    *,
    expected_algorithm: str | None = None,
    expected_device: str | None = None,
) -> bool:
    try:
        if expected_device not in {None, "cpu", "gpu"}:
            return False
        metadata = json.loads(
            (artifacts / "metadata.json").read_text(encoding="utf-8")
        )
        if not isinstance(metadata, dict):
            return False
        qualification = _qualification(metadata, expected_device)
        if qualification is None:
            return False
        final_torque_t = _finite_float(qualification["final_torque_t"])
        stop_value = _finite_float(qualification["stop_metric_value"])
        stop_threshold = _finite_float(qualification["stop_threshold"])
        executed_steps = int(qualification["executed_steps"])
        algorithm = qualification.get("relaxation_algorithm")
        return (
            qualification.get("converged") is True
            and isinstance(algorithm, str)
            and bool(algorithm)
            and (expected_algorithm is None or algorithm == expected_algorithm)
            and isinstance(qualification.get("stop_reason"), str)
            and bool(qualification["stop_reason"])
            and isinstance(qualification.get("stop_metric_name"), str)
            and bool(qualification["stop_metric_name"])
            and stop_value >= 0.0
            and stop_threshold > 0.0
            and executed_steps > 0
            and 0.0 <= final_torque_t <= TORQUE_LIMIT_T
            and _scalar_tail_is_ready(artifacts / "scalars.csv")
            and _field_is_finite(artifacts / "m_final.json")
        )
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError):
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifacts", type=Path)
    parser.add_argument(
        "--expected-algorithm",
        choices=("llg_overdamped", "projected_gradient_bb", "nonlinear_cg"),
    )
    parser.add_argument("--expected-device", choices=("cpu", "gpu"))
    args = parser.parse_args()
    return 0 if relaxation_is_ready(
        args.artifacts,
        expected_algorithm=args.expected_algorithm,
        expected_device=args.expected_device,
    ) else 1


if __name__ == "__main__":
    raise SystemExit(main())
