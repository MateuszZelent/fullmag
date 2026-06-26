#!/usr/bin/env python3
"""Validate paired cross-backend hysteresis metrics parity artifacts."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "hysteresis-metrics-parity/v1"
REQUIRED_PARITY_METRICS = {
    "H_c_plus",
    "H_c_minus",
    "M_r_plus",
    "M_r_minus",
}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text())


def require_mapping(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SystemExit(f"{field} must be an object, got {value!r}")
    return value


def require_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise SystemExit(f"{field} must be a non-empty string, got {value!r}")
    return value


def require_finite_number(value: Any, field: str) -> float:
    if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise SystemExit(f"{field} must be a finite number, got {value!r}")
    return float(value)


def require_under(base: Path, path: Path, field: str) -> None:
    try:
        path.relative_to(base)
    except ValueError:
        raise SystemExit(f"{field} must stay under {base}, got {path}") from None


def lane_label(lane: dict[str, Any], field: str) -> str:
    return "/".join(
        [
            require_string(lane.get("backend"), f"{field}.backend"),
            require_string(lane.get("device"), f"{field}.device"),
            require_string(lane.get("precision"), f"{field}.precision"),
        ]
    )


def resolve_metrics_path(manifest_path: Path, lane: dict[str, Any], field: str) -> Path:
    raw_path = require_string(lane.get("metrics_path"), f"{field}.metrics_path")
    path = Path(raw_path)
    if path.is_absolute():
        raise SystemExit(f"{field}.metrics_path must be relative, got {raw_path!r}")
    base = manifest_path.parent.resolve()
    resolved = (manifest_path.parent / path).resolve()
    require_under(base, resolved, f"{field}.metrics_path")
    if not resolved.is_file():
        raise SystemExit(f"{field}.metrics_path does not exist: {resolved}")
    return resolved


def require_available_metric(metrics: dict[str, Any], metric_name: str, lane: str) -> float:
    value = require_finite_number(metrics.get(metric_name), f"{lane}.{metric_name}")
    statuses = require_mapping(metrics.get("metric_statuses"), f"{lane}.metric_statuses")
    status_entry = require_mapping(
        statuses.get(metric_name),
        f"{lane}.metric_statuses.{metric_name}",
    )
    status = status_entry.get("status")
    if status != "available":
        raise SystemExit(
            f"{lane}.metric_statuses.{metric_name}.status must be 'available', "
            f"got {status!r}"
        )
    reason = status_entry.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        raise SystemExit(f"{lane}.metric_statuses.{metric_name}.reason is required")
    return value


def validate_metric_pair(
    pair_id: str,
    reference_label: str,
    candidate_label: str,
    reference_metrics: dict[str, Any],
    candidate_metrics: dict[str, Any],
    metric: dict[str, Any],
) -> str:
    metric_name = require_string(metric.get("name"), f"{pair_id}.metrics[].name")
    unit = require_string(metric.get("unit"), f"{pair_id}.{metric_name}.unit")
    abs_tolerance = require_finite_number(
        metric.get("abs_tolerance"),
        f"{pair_id}.{metric_name}.abs_tolerance",
    )
    if abs_tolerance < 0.0:
        raise SystemExit(
            f"{pair_id}.{metric_name}.abs_tolerance must be non-negative, "
            f"got {abs_tolerance!r}"
        )
    reference_value = require_available_metric(
        reference_metrics,
        metric_name,
        reference_label,
    )
    candidate_value = require_available_metric(
        candidate_metrics,
        metric_name,
        candidate_label,
    )
    delta = abs(candidate_value - reference_value)
    if delta > abs_tolerance:
        raise SystemExit(
            f"{pair_id} {metric_name} parity failed for {reference_label} vs "
            f"{candidate_label}: reference={reference_value} {unit}, "
            f"candidate={candidate_value} {unit}, delta={delta} > "
            f"abs_tolerance={abs_tolerance}"
        )
    return f"{metric_name}: delta={delta:g} {unit}"


def validate_pair(manifest_path: Path, pair: dict[str, Any], index: int) -> str:
    pair_id = require_string(pair.get("pair_id"), f"pairs[{index}].pair_id")
    reference = require_mapping(pair.get("reference"), f"{pair_id}.reference")
    candidate = require_mapping(pair.get("candidate"), f"{pair_id}.candidate")
    reference_label = lane_label(reference, f"{pair_id}.reference")
    candidate_label = lane_label(candidate, f"{pair_id}.candidate")
    reference_metrics = require_mapping(
        load_json(resolve_metrics_path(manifest_path, reference, f"{pair_id}.reference")),
        f"{pair_id}.reference metrics",
    )
    candidate_metrics = require_mapping(
        load_json(resolve_metrics_path(manifest_path, candidate, f"{pair_id}.candidate")),
        f"{pair_id}.candidate metrics",
    )
    metrics = pair.get("metrics")
    if not isinstance(metrics, list) or not metrics:
        raise SystemExit(f"{pair_id}.metrics must be a non-empty list")
    metric_names = {
        require_string(
            require_mapping(metric, f"{pair_id}.metrics[{metric_index}]").get("name"),
            f"{pair_id}.metrics[{metric_index}].name",
        )
        for metric_index, metric in enumerate(metrics)
    }
    missing_metrics = sorted(REQUIRED_PARITY_METRICS - metric_names)
    if missing_metrics:
        raise SystemExit(
            f"{pair_id}.metrics missing required metric(s): "
            + ", ".join(missing_metrics)
        )
    details = [
        validate_metric_pair(
            pair_id,
            reference_label,
            candidate_label,
            reference_metrics,
            candidate_metrics,
            require_mapping(metric, f"{pair_id}.metrics[{metric_index}]"),
        )
        for metric_index, metric in enumerate(metrics)
    ]
    reference_weighting = reference_metrics.get("magnetization_average_weighting")
    candidate_weighting = candidate_metrics.get("magnetization_average_weighting")
    weighting_note = ""
    if reference_weighting is not None or candidate_weighting is not None:
        weighting_note = (
            f"; weighting={reference_weighting!r} vs {candidate_weighting!r}"
        )
    return (
        f"{pair_id}: {reference_label} vs {candidate_label}; "
        + ", ".join(details)
        + weighting_note
    )


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: scripts/verify_hysteresis_metrics_parity.py <manifest.json>")

    manifest_path = Path(sys.argv[1])
    manifest = require_mapping(load_json(manifest_path), "metrics parity manifest")
    if manifest.get("schema_version") != SCHEMA_VERSION:
        raise SystemExit(
            f"schema_version must be {SCHEMA_VERSION!r}, got {manifest.get('schema_version')!r}"
        )
    pairs = manifest.get("pairs")
    if not isinstance(pairs, list) or not pairs:
        raise SystemExit("pairs must be a non-empty list")

    summaries = [
        validate_pair(manifest_path, require_mapping(pair, f"pairs[{index}]"), index)
        for index, pair in enumerate(pairs)
    ]
    print(
        f"validated hysteresis metrics parity: pairs={len(summaries)}; "
        + " | ".join(summaries)
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
