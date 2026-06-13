#!/usr/bin/env python3
"""Validate OOP/IP/custom-angle hysteresis projection artifacts."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any


REQUIRED_VARIANTS = {"ip_x", "oop", "custom_theta45_phi30"}
TOL = 1.0e-9


def load_json(path: Path) -> Any:
    return json.loads(path.read_text())


def normalize(vector: tuple[float, float, float]) -> tuple[float, float, float]:
    norm = math.sqrt(sum(component * component for component in vector))
    if norm <= 1.0e-15:
        raise SystemExit(f"cannot normalize near-zero vector {vector!r}")
    return tuple(component / norm for component in vector)


def orientation_axis(orientation: dict[str, Any]) -> tuple[float, float, float]:
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
        raise SystemExit(f"unsupported preset orientation {preset!r}")
    if kind == "sample":
        theta = math.radians(float(orientation["theta"]))
        phi = math.radians(float(orientation["phi"]))
        return (
            math.sin(theta) * math.cos(phi),
            math.sin(theta) * math.sin(phi),
            math.cos(theta),
        )
    if kind == "global":
        vector = orientation.get("vector")
        if not isinstance(vector, list) or len(vector) != 3:
            raise SystemExit(f"global orientation must define vector[3]: {orientation!r}")
        return normalize((float(vector[0]), float(vector[1]), float(vector[2])))
    raise SystemExit(f"unsupported orientation kind {kind!r}")


def measurement_axis(
    axis: str | dict[str, Any] | None,
    field_axis: tuple[float, float, float],
) -> tuple[float, float, float]:
    if axis in (None, "field_axis"):
        return field_axis
    if axis == "sample_normal":
        return (0.0, 0.0, 1.0)
    if isinstance(axis, dict) and axis.get("kind") == "custom":
        vector = axis.get("vector")
        if not isinstance(vector, list) or len(vector) != 3:
            raise SystemExit(f"custom measurement axis must define vector[3]: {axis!r}")
        return normalize((float(vector[0]), float(vector[1]), float(vector[2])))
    raise SystemExit(f"unsupported measurement axis {axis!r}")


def require_points(root: Path, relative_path: str, variant_id: str) -> list[dict[str, Any]]:
    path = root / relative_path
    if not path.is_file():
        raise SystemExit(f"missing points artifact for {variant_id}: {path}")
    points = load_json(path)
    if not isinstance(points, list) or not points:
        raise SystemExit(f"points artifact for {variant_id} must be a non-empty list")
    return points


def validate_variant_manifest_contract(variant: dict[str, Any], variant_id: str) -> None:
    status = variant.get("data_status")
    if status not in ("computed_active_stage", "computed_variant_run"):
        raise SystemExit(
            f"required projection variant {variant_id!r} must be computed, got {status!r}"
        )
    resource_ref = variant.get("points_resource_ref")
    if not isinstance(resource_ref, str) or not resource_ref.startswith(
        "/v2/sessions/current/analysis/hysteresis-family/",
    ):
        raise SystemExit(
            f"variant {variant_id!r} points_resource_ref must be a public v2 "
            f"hysteresis-family resource, got {resource_ref!r}"
        )


def validate_variant(root: Path, variant: dict[str, Any]) -> int:
    variant_id = str(variant.get("variant_id"))
    validate_variant_manifest_contract(variant, variant_id)
    orientation = variant.get("orientation")
    if not isinstance(orientation, dict):
        raise SystemExit(f"variant {variant_id} is missing orientation")
    points_path = variant.get("points_path")
    if not isinstance(points_path, str):
        raise SystemExit(f"variant {variant_id} is missing points_path")

    field_axis = orientation_axis(orientation)
    meas_axis = measurement_axis(variant.get("measurement_axis"), field_axis)
    points = require_points(root, points_path, variant_id)

    for index, point in enumerate(points):
        m_avg = point.get("m_avg")
        if not isinstance(m_avg, list) or len(m_avg) != 3:
            raise SystemExit(f"point {index} for {variant_id} is missing m_avg[3]")
        m = tuple(float(component) for component in m_avg)
        expected_parallel = sum(m[i] * meas_axis[i] for i in range(3))
        expected_oop = m[2]
        expected_ip = math.sqrt(m[0] * m[0] + m[1] * m[1])
        actual_parallel = float(point.get("m_parallel"))
        actual_oop = float(point.get("m_oop"))
        actual_ip = float(point.get("m_ip"))
        if abs(actual_parallel - expected_parallel) > TOL:
            raise SystemExit(
                f"{variant_id} point {index} m_parallel mismatch: "
                f"{actual_parallel} != {expected_parallel}"
            )
        if abs(actual_oop - expected_oop) > TOL:
            raise SystemExit(
                f"{variant_id} point {index} m_oop mismatch: {actual_oop} != {expected_oop}"
            )
        if abs(actual_ip - expected_ip) > TOL:
            raise SystemExit(
                f"{variant_id} point {index} m_ip mismatch: {actual_ip} != {expected_ip}"
            )
    return len(points)


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit(
            "usage: scripts/verify_hysteresis_projection_benchmark.py <artifact-dir>"
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
        raise SystemExit("missing required projection variants: " + ", ".join(missing))

    total_points = 0
    for variant_id in sorted(REQUIRED_VARIANTS):
        total_points += validate_variant(root, variants_by_id[variant_id])

    print(
        "validated hysteresis projection benchmark: "
        f"variants={len(REQUIRED_VARIANTS)} points={total_points}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
