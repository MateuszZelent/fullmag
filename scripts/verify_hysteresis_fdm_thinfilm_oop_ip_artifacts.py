#!/usr/bin/env python3
"""Validate the small FDM thin-film OOP/IP hysteresis fixture."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any


REQUIRED_VARIANTS = {"ip_near_x", "oop"}
COMPUTED_VARIANT_STATUSES = {"computed_active_stage", "computed_variant_run"}
HYSTERESIS_FAMILY_RESOURCE_PREFIX = "/v2/sessions/current/analysis/hysteresis-family/"


def load_json(path: Path) -> Any:
    return json.loads(path.read_text())


def require_number(value: Any, field: str) -> float:
    if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise SystemExit(f"{field} must be a finite number, got {value!r}")
    return float(value)


def require_points(root: Path, variant: dict[str, Any]) -> list[dict[str, Any]]:
    variant_id = variant.get("variant_id")
    points_path = variant.get("points_path")
    if not isinstance(points_path, str):
        raise SystemExit(f"variant {variant_id!r} is missing points_path")
    path = root / points_path
    if not path.is_file():
        raise SystemExit(f"missing points artifact for {variant_id}: {path}")
    points = load_json(path)
    if not isinstance(points, list) or len(points) < 5:
        raise SystemExit(f"variant {variant_id!r} must contain a resolved loop")
    return points


def validate_variant_manifest_contract(variant: dict[str, Any], variant_id: str) -> None:
    status = variant.get("data_status")
    if status not in COMPUTED_VARIANT_STATUSES:
        raise SystemExit(f"variant {variant_id!r} is not computed: {status!r}")
    points_resource_ref = variant.get("points_resource_ref")
    if not isinstance(points_resource_ref, str) or not points_resource_ref.startswith(
        HYSTERESIS_FAMILY_RESOURCE_PREFIX
    ):
        raise SystemExit(
            f"variant {variant_id!r} has invalid points_resource_ref: {points_resource_ref!r}"
        )


def validate_point_schema(points: list[dict[str, Any]], label: str) -> None:
    for index, point in enumerate(points):
        m_avg = point.get("m_avg")
        if not isinstance(m_avg, list) or len(m_avg) != 3:
            raise SystemExit(f"{label}[{index}].m_avg must be a 3-vector")
        for component_index, component in enumerate(m_avg):
            require_number(component, f"{label}[{index}].m_avg[{component_index}]")
        m_parallel = require_number(point.get("m_parallel"), f"{label}[{index}].m_parallel")
        if abs(m_parallel) > 1.05:
            raise SystemExit(f"{label}[{index}].m_parallel is outside normalized range")
        require_number(point.get("field_value_mT"), f"{label}[{index}].field_value_mT")


def projection_values(points: list[dict[str, Any]], label: str) -> list[float]:
    values = [require_number(point.get("m_parallel"), f"{label}.m_parallel") for point in points]
    if max(values) - min(values) < 0.05:
        raise SystemExit(f"{label} has no measurable hysteresis response")
    return values


def high_field_abs_projection(points: list[dict[str, Any]], label: str) -> float:
    max_abs_field = max(
        abs(require_number(point.get("field_value_mT"), f"{label}.field_value_mT"))
        for point in points
    )
    high_field_points = [
        point
        for point in points
        if abs(require_number(point.get("field_value_mT"), f"{label}.field_value_mT"))
        >= max_abs_field - 1e-9
    ]
    if not high_field_points:
        raise SystemExit(f"{label} has no high-field points")
    return max(
        abs(require_number(point.get("m_parallel"), f"{label}.m_parallel"))
        for point in high_field_points
    )


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit(
            "usage: scripts/verify_hysteresis_fdm_thinfilm_oop_ip_artifacts.py <artifact-dir>"
        )

    root = Path(sys.argv[1])
    manifest_path = root / "hysteresis_angular_family.json"
    if not manifest_path.is_file():
        raise SystemExit(f"missing angular-family manifest: {manifest_path}")

    manifest = load_json(manifest_path)
    variants = manifest.get("variants")
    if not isinstance(variants, list):
        raise SystemExit("angular-family manifest variants must be a list")
    variants_by_id = {str(variant.get("variant_id")): variant for variant in variants}
    missing = sorted(REQUIRED_VARIANTS.difference(variants_by_id))
    if missing:
        raise SystemExit("missing required thin-film variants: " + ", ".join(missing))

    points_by_variant: dict[str, list[dict[str, Any]]] = {}
    high_field_by_variant: dict[str, float] = {}
    for variant_id in sorted(REQUIRED_VARIANTS):
        variant = variants_by_id[variant_id]
        validate_variant_manifest_contract(variant, variant_id)
        points = require_points(root, variant)
        validate_point_schema(points, variant_id)
        projection_values(points, variant_id)
        points_by_variant[variant_id] = points
        high_field_by_variant[variant_id] = high_field_abs_projection(points, variant_id)

    ip_high = high_field_by_variant["ip_near_x"]
    oop_high = high_field_by_variant["oop"]
    if ip_high < 0.35:
        raise SystemExit(f"in-plane branch does not align with high field: {ip_high:.6g}")
    if oop_high >= ip_high * 0.9:
        raise SystemExit(
            "thin-film demag contrast failed: "
            f"OOP high-field |m_parallel|={oop_high:.6g}, IP={ip_high:.6g}"
        )

    ip_values = projection_values(points_by_variant["ip_near_x"], "ip_near_x")
    oop_values = projection_values(points_by_variant["oop"], "oop")
    ip_span = max(ip_values) - min(ip_values)
    oop_span = max(oop_values) - min(oop_values)
    if ip_span < 0.5:
        raise SystemExit(f"in-plane branch response is too weak: span={ip_span:.6g}")
    if oop_span < 0.5:
        raise SystemExit(f"OOP branch response is too weak: span={oop_span:.6g}")
    print(
        "validated FDM thin-film OOP/IP hysteresis fixture: "
        f"IP_high={ip_high:.6g} OOP_high={oop_high:.6g} "
        f"IP_span={ip_span:.6g} OOP_span={oop_span:.6g}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
