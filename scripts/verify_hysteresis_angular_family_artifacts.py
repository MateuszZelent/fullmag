#!/usr/bin/env python3
"""Validate angular-family hysteresis artifacts."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def load_json(path: Path):
    return json.loads(path.read_text())


def require_points(path: Path, label: str) -> list[dict]:
    if not path.is_file():
        raise SystemExit(f"missing {label} points artifact: {path}")
    points = load_json(path)
    if not isinstance(points, list) or not points:
        raise SystemExit(f"{label} points artifact must contain a non-empty list")
    for point in points:
        if not isinstance(point.get("m_avg"), list) or len(point["m_avg"]) != 3:
            raise SystemExit(f"{label} point is missing m_avg[3]: {point!r}")
        if not isinstance(point.get("m_parallel"), (int, float)):
            raise SystemExit(f"{label} point is missing numeric m_parallel: {point!r}")
    return points


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit(
            "usage: scripts/verify_hysteresis_angular_family_artifacts.py <artifact-dir>"
        )

    root = Path(sys.argv[1])
    family_path = root / "hysteresis_angular_family.json"
    if not family_path.is_file():
        raise SystemExit(f"missing angular-family manifest: {family_path}")

    manifest = load_json(family_path)
    variants = manifest.get("variants")
    if not isinstance(variants, list) or len(variants) < 2:
        raise SystemExit("angular-family manifest must contain at least two variants")

    computed = [variant for variant in variants if str(variant.get("data_status")).startswith("computed")]
    if len(computed) < 2:
        raise SystemExit(
            "angular-family manifest must contain at least two computed variants"
        )

    active_id = manifest.get("active_variant_id")
    if not active_id:
        raise SystemExit("angular-family manifest is missing active_variant_id")

    base_points = require_points(root / "hysteresis_points.json", "active")
    active_variants = [
        variant for variant in variants if variant.get("variant_id") == active_id
    ]
    if len(active_variants) != 1:
        raise SystemExit(f"active variant {active_id!r} must appear exactly once")
    active_variant = active_variants[0]
    if active_variant.get("data_status") != "computed_active_stage":
        raise SystemExit(
            f"active variant must be computed_active_stage, got {active_variant.get('data_status')!r}"
        )
    if int(active_variant.get("point_count", -1)) != len(base_points):
        raise SystemExit(
            "active variant point_count must match hysteresis_points.json "
            f"({active_variant.get('point_count')} != {len(base_points)})"
        )

    checked_variant_count = 1
    for variant in variants:
        variant_id = variant.get("variant_id")
        status = variant.get("data_status")
        if status == "computed_active_stage":
            continue
        if status != "computed_variant_run":
            raise SystemExit(f"variant {variant_id!r} has unexpected status {status!r}")
        points_path = variant.get("points_path")
        metrics_path = variant.get("metrics_path")
        if not isinstance(points_path, str) or not isinstance(metrics_path, str):
            raise SystemExit(f"computed variant {variant_id!r} is missing artifact paths")
        if points_path == "hysteresis_points.json":
            raise SystemExit(
                f"computed variant {variant_id!r} must not point at active-stage points"
            )
        variant_points = require_points(root / points_path, f"variant {variant_id}")
        metrics_file = root / metrics_path
        if not metrics_file.is_file():
            raise SystemExit(f"missing variant metrics artifact: {metrics_file}")
        if int(variant.get("point_count", -1)) != len(variant_points):
            raise SystemExit(
                f"variant {variant_id!r} point_count mismatch: "
                f"{variant.get('point_count')} != {len(variant_points)}"
            )
        checked_variant_count += 1

    print(
        "validated hysteresis angular family: "
        f"family_id={manifest.get('family_id')} variants={checked_variant_count}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
