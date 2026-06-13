#!/usr/bin/env python3
"""Validate capped hysteresis saturation-probe artifacts."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any


EXPECTED_STATUS = "capped_by_limit"


def load_json(path: Path) -> Any:
    return json.loads(path.read_text())


def require_number(value: Any, field: str) -> float:
    if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise SystemExit(f"{field} must be a finite number, got {value!r}")
    return float(value)


def require_vec3(value: Any, field: str) -> list[float]:
    if not isinstance(value, list) or len(value) != 3:
        raise SystemExit(f"{field} must be a 3-vector, got {value!r}")
    return [require_number(component, f"{field}[{index}]") for index, component in enumerate(value)]


def require_measured_point_provenance(point: dict[str, Any], field: str) -> None:
    require_vec3(point.get("m_avg"), f"{field}.m_avg")
    require_vec3(point.get("field_vector_A_per_m"), f"{field}.field_vector_A_per_m")
    orientation = point.get("field_orientation")
    if not isinstance(orientation, dict):
        raise SystemExit(f"{field}.field_orientation must be an object, got {orientation!r}")
    measurement_axis = point.get("measurement_axis")
    if not (
        measurement_axis == "field_axis"
        or isinstance(measurement_axis, dict)
    ):
        raise SystemExit(f"{field}.measurement_axis must be present, got {measurement_axis!r}")
    if point.get("field_display_unit") != "mT":
        raise SystemExit(f"{field}.field_display_unit must be 'mT'")


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit(
            "usage: scripts/verify_hysteresis_saturation_limit_artifacts.py <artifact-dir>"
        )

    root = Path(sys.argv[1])
    saturation_path = root / "hysteresis_saturation.json"
    metrics_path = root / "hysteresis_metrics.json"
    points_path = root / "hysteresis_points.json"

    missing = [
        str(path)
        for path in (saturation_path, metrics_path, points_path)
        if not path.is_file()
    ]
    if missing:
        raise SystemExit(
            "missing required hysteresis saturation artifacts:\n" + "\n".join(missing)
        )

    saturation = load_json(saturation_path)
    metrics = load_json(metrics_path)
    points = load_json(points_path)

    if saturation.get("status") != EXPECTED_STATUS:
        raise SystemExit(
            f"saturation status must be {EXPECTED_STATUS!r}, got {saturation.get('status')!r}"
        )
    if metrics.get("saturation_status") != EXPECTED_STATUS:
        raise SystemExit(
            "hysteresis_metrics.json saturation_status must match saturation artifact "
            f"({metrics.get('saturation_status')!r} != {EXPECTED_STATUS!r})"
        )
    if saturation.get("direction") != 1:
        raise SystemExit(f"expected positive saturation direction, got {saturation.get('direction')!r}")
    reason = saturation.get("reason")
    if not isinstance(reason, str) or "max_probe_field_mT" not in reason:
        raise SystemExit(f"saturation reason must explain max field cap, got {reason!r}")

    max_field = require_number(saturation.get("max_probe_field_mT"), "max_probe_field_mT")
    preparation = require_number(
        saturation.get("preparation_field_mT"),
        "preparation_field_mT",
    )
    metrics_preparation = require_number(
        metrics.get("saturation_preparation_field_mT"),
        "saturation_preparation_field_mT",
    )
    if abs(preparation - max_field) > 1e-9:
        raise SystemExit(
            f"preparation field must equal capped max field ({preparation} != {max_field})"
        )
    if abs(metrics_preparation - preparation) > 1e-9:
        raise SystemExit(
            "metrics preparation field must match saturation artifact "
            f"({metrics_preparation} != {preparation})"
        )

    probe_points = saturation.get("points")
    if not isinstance(probe_points, list) or len(probe_points) != 3:
        raise SystemExit(
            f"saturation probe must contain exactly 3 probe points, got {probe_points!r}"
        )
    expected_fields = [max_field / 3.0, 2.0 * max_field / 3.0, max_field]
    for index, (point, expected_field) in enumerate(zip(probe_points, expected_fields)):
        if point.get("probe_index") != index:
            raise SystemExit(
                f"probe point {index} has invalid probe_index {point.get('probe_index')!r}"
            )
        actual_field = require_number(point.get("field_value_mT"), f"points[{index}].field_value_mT")
        if abs(actual_field - expected_field) > 1e-9:
            raise SystemExit(
                f"probe point {index} field mismatch: {actual_field} != {expected_field}"
            )
        require_number(point.get("m_parallel"), f"points[{index}].m_parallel")
        require_number(point.get("m_transverse"), f"points[{index}].m_transverse")
        status = point.get("status")
        if not isinstance(status, str) or not status:
            raise SystemExit(f"probe point {index} must have a non-empty status")

    if not isinstance(points, list) or len(points) != 1:
        raise SystemExit(f"expected one measured hysteresis point, got {points!r}")
    measured_point = points[0]
    if not isinstance(measured_point, dict):
        raise SystemExit(f"measured hysteresis point must be an object, got {measured_point!r}")
    if require_number(measured_point.get("field_value_mT"), "points[0].field_value_mT") != 0.0:
        raise SystemExit("measured smoke point must be at 0 mT")
    require_measured_point_provenance(measured_point, "points[0]")

    print(
        "validated hysteresis saturation limit: "
        f"status={EXPECTED_STATUS} probe_points={len(probe_points)} max_field_mT={max_field:g}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
