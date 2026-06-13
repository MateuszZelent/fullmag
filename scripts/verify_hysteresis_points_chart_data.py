#!/usr/bin/env python3
"""Validate hysteresis point data used by charts and live inspectors."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any


TOL = 1.0e-9


def load_json(path: Path) -> Any:
    return json.loads(path.read_text())


def require_number(value: Any, field: str) -> float:
    if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise SystemExit(f"{field} must be a finite number, got {value!r}")
    return float(value)


def require_vec3(value: Any, field: str) -> tuple[float, float, float]:
    if not isinstance(value, list) or len(value) != 3:
        raise SystemExit(f"{field} must be a 3-component vector, got {value!r}")
    return (
        require_number(value[0], f"{field}[0]"),
        require_number(value[1], f"{field}[1]"),
        require_number(value[2], f"{field}[2]"),
    )


def normalize_vector(vector: tuple[float, float, float], field: str) -> tuple[float, float, float]:
    norm = math.sqrt(sum(component * component for component in vector))
    if norm <= 1.0e-15:
        raise SystemExit(f"{field} must not be a zero vector")
    return tuple(component / norm for component in vector)


def field_orientation_axis(point: dict[str, Any], label: str) -> tuple[float, float, float] | None:
    orientation = point.get("field_orientation")
    if not isinstance(orientation, dict):
        return None
    kind = orientation.get("kind")
    if kind == "preset":
        preset = orientation.get("preset_name")
        if preset == "oop_positive":
            return (0.0, 0.0, 1.0)
        if preset == "oop_negative":
            return (0.0, 0.0, -1.0)
        if preset == "in_plane_x":
            return (1.0, 0.0, 0.0)
        if preset == "in_plane_y":
            return (0.0, 1.0, 0.0)
        raise SystemExit(f"{label}.field_orientation has unsupported preset {preset!r}")
    if kind == "sample":
        theta = math.radians(require_number(orientation.get("theta"), f"{label}.theta"))
        phi = math.radians(require_number(orientation.get("phi"), f"{label}.phi"))
        return (
            math.sin(theta) * math.cos(phi),
            math.sin(theta) * math.sin(phi),
            math.cos(theta),
        )
    if kind == "global":
        return normalize_vector(
            require_vec3(orientation.get("vector"), f"{label}.field_orientation.vector"),
            f"{label}.field_orientation.vector",
        )
    raise SystemExit(f"{label}.field_orientation has unsupported kind {kind!r}")


def field_axis(point: dict[str, Any], label: str) -> tuple[float, float, float]:
    axis = field_orientation_axis(point, label)
    if axis is not None:
        return axis
    return normalize_vector(
        require_vec3(point.get("field_vector_A_per_m"), f"{label}.field_vector_A_per_m"),
        f"{label}.field_vector_A_per_m",
    )


def measurement_axis(point: dict[str, Any], label: str) -> tuple[float, float, float]:
    axis = point.get("measurement_axis", "field_axis")
    if axis in (None, "field_axis"):
        return field_axis(point, label)
    if axis == "sample_normal":
        return (0.0, 0.0, 1.0)
    if isinstance(axis, dict) and axis.get("kind") == "custom":
        return normalize_vector(
            require_vec3(axis.get("vector"), f"{label}.measurement_axis.vector"),
            f"{label}.measurement_axis.vector",
        )
    raise SystemExit(f"{label}.measurement_axis has unsupported value {axis!r}")


def validate_point(point: dict[str, Any], index: int) -> None:
    label = f"hysteresis_points[{index}]"
    point_id = require_number(point.get("point_id"), f"{label}.point_id")
    field_value = require_number(point.get("field_value_mT"), f"{label}.field_value_mT")
    m_avg = require_vec3(point.get("m_avg"), f"{label}.m_avg")
    axis = measurement_axis(point, label)
    expected_parallel = sum(m_avg[component] * axis[component] for component in range(3))
    expected_oop = m_avg[2]
    expected_ip = math.sqrt(m_avg[0] * m_avg[0] + m_avg[1] * m_avg[1])
    checks = {
        "m_parallel": expected_parallel,
        "m_oop": expected_oop,
        "m_ip": expected_ip,
    }
    for key, expected in checks.items():
        actual = require_number(point.get(key), f"{label}.{key}")
        if abs(actual - expected) > TOL:
            raise SystemExit(
                f"{label}.{key} does not match m_avg/projection: "
                f"got {actual}, expected {expected}"
            )
    if not math.isfinite(point_id) or not math.isfinite(field_value):
        raise SystemExit(f"{label} contains non-finite chart coordinates")


def validate_chart_series(points: list[dict[str, Any]]) -> None:
    point_ids = [
        require_number(point.get("point_id"), f"hysteresis_points[{index}].point_id")
        for index, point in enumerate(points)
    ]
    if len(set(point_ids)) != len(point_ids):
        raise SystemExit("hysteresis_points.json contains duplicate point_id values")

    if len(points) < 2:
        return

    field_values = [
        require_number(
            point.get("field_value_mT"),
            f"hysteresis_points[{index}].field_value_mT",
        )
        for index, point in enumerate(points)
    ]
    if max(field_values) - min(field_values) <= TOL:
        raise SystemExit(
            "hysteresis_points.json field_value_mT span is zero; "
            "multi-point chart data would collapse onto one field coordinate"
        )


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: scripts/verify_hysteresis_points_chart_data.py <artifact-dir>")

    root = Path(sys.argv[1])
    points_path = root / "hysteresis_points.json"
    if not points_path.is_file():
        raise SystemExit(f"missing hysteresis points artifact: {points_path}")

    points = load_json(points_path)
    if not isinstance(points, list) or not points:
        raise SystemExit("hysteresis_points.json must contain a non-empty point list")
    for index, point in enumerate(points):
        if not isinstance(point, dict):
            raise SystemExit(f"hysteresis_points[{index}] must be an object")
        validate_point(point, index)
    validate_chart_series(points)

    print(f"validated hysteresis chart points: points={len(points)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
