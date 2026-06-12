#!/usr/bin/env python3
"""Validate the FDM macrospin Stoner-Wohlfarth hysteresis fixture."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any


REQUIRED_VARIANTS = {"easy_axis", "theta45"}


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
    if not isinstance(points, list) or len(points) < 8:
        raise SystemExit(f"variant {variant_id!r} must contain a resolved loop")
    return points


def interpolated_coercive_fields(points: list[dict[str, Any]], label: str) -> list[float]:
    crossings: list[float] = []
    for left, right in zip(points, points[1:]):
        h0 = require_number(left.get("field_value_mT"), f"{label}.field_value_mT")
        h1 = require_number(right.get("field_value_mT"), f"{label}.field_value_mT")
        m0 = require_number(left.get("m_parallel"), f"{label}.m_parallel")
        m1 = require_number(right.get("m_parallel"), f"{label}.m_parallel")
        if abs(m0) <= 1e-12:
            crossings.append(h0)
            continue
        if m0 * m1 > 0.0 or abs(m1 - m0) <= 1e-12:
            continue
        t = -m0 / (m1 - m0)
        crossings.append(h0 + t * (h1 - h0))
    return crossings


def validate_variant(points: list[dict[str, Any]], label: str) -> float:
    values = [require_number(point.get("m_parallel"), f"{label}.m_parallel") for point in points]
    if max(values) < 0.35:
        raise SystemExit(f"{label} never reaches positive magnetization: max={max(values)}")
    if min(values) > -0.35:
        raise SystemExit(f"{label} never reaches negative magnetization: min={min(values)}")
    crossings = interpolated_coercive_fields(points, label)
    if not crossings:
        raise SystemExit(f"{label} has no coercive-field crossing")
    hc = min(abs(value) for value in crossings)
    if not (0.0 < hc < 35.0):
        raise SystemExit(f"{label} coercive field is outside fixture range: {hc}")
    return hc


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit(
            "usage: scripts/verify_hysteresis_fdm_macrospin_sw_artifacts.py <artifact-dir>"
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
        raise SystemExit("missing required macrospin variants: " + ", ".join(missing))

    hc_by_variant: dict[str, float] = {}
    for variant_id in sorted(REQUIRED_VARIANTS):
        variant = variants_by_id[variant_id]
        status = variant.get("data_status")
        if not str(status).startswith("computed"):
            raise SystemExit(f"variant {variant_id!r} is not computed: {status!r}")
        points = require_points(root, variant)
        hc_by_variant[variant_id] = validate_variant(points, variant_id)

    easy_hc = hc_by_variant["easy_axis"]
    theta_hc = hc_by_variant["theta45"]
    if not theta_hc < easy_hc * 0.95:
        raise SystemExit(
            "Stoner-Wohlfarth angular trend failed: "
            f"theta45 Hc={theta_hc:.6g} mT, easy-axis Hc={easy_hc:.6g} mT"
        )

    print(
        "validated FDM macrospin Stoner-Wohlfarth trend: "
        f"Hc_easy={easy_hc:.6g}mT Hc_theta45={theta_hc:.6g}mT"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
