#!/usr/bin/env python3
"""Validate the serialized v1 skyrmion trajectory/Hall-angle artifact.

This validator checks provenance and numerical invariants only.  It does not
reconstruct a trajectory from a renderer field and therefore cannot promote a
run that lacks the accepted source-series identity.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Mapping


SCHEMA_VERSION = "skyrmion_hall_angle.v1"
ALGORITHM_VERSION = "weighted_gls.v1"
REASONS = {
    "no_motion",
    "topology_lost",
    "edge_contaminated",
    "no_stationary_window",
    "insufficient_samples",
}


class HallArtifactError(ValueError):
    """A serialized Hall artifact is incomplete or physically inconsistent."""


def _obj(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise HallArtifactError(f"{label} must be an object")
    return value


def _finite(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise HallArtifactError(f"{label} must be finite")
    result = float(value)
    if not math.isfinite(result):
        raise HallArtifactError(f"{label} must be finite")
    return result


def _vector(value: Any, size: int, label: str) -> list[float]:
    if not isinstance(value, list) or len(value) != size:
        raise HallArtifactError(f"{label} must contain {size} values")
    return [_finite(component, f"{label}[{index}]") for index, component in enumerate(value)]


def _provenance(value: Any, label: str) -> Mapping[str, Any]:
    result = _obj(value, label)
    for field in (
        "scene_revision",
        "field_revision",
        "mesh_revision",
        "mesh_generation_id",
        "domain_generation_id",
        "global_node_mapping_id",
        "cache_key_digest",
    ):
        if not isinstance(result.get(field), str) or not result[field]:
            raise HallArtifactError(f"{label}.{field} is required")
    return result


def _source(value: Any, label: str) -> Mapping[str, Any]:
    result = _obj(value, label)
    for field in (
        "magnetization_quantity_id",
        "magnetization_series_id",
        "object_id",
        "geometry_id",
        "grid_or_mesh_id",
        "support_id",
        "topological_charge_method_version",
    ):
        if not isinstance(result.get(field), str) or not result[field]:
            raise HallArtifactError(f"{label}.{field} is required")
    return result


def validate_hall_artifact(artifact: Mapping[str, Any]) -> None:
    if artifact.get("schema_version") != SCHEMA_VERSION:
        raise HallArtifactError(f"schema_version must be {SCHEMA_VERSION!r}")
    if artifact.get("algorithm_version") != ALGORITHM_VERSION:
        raise HallArtifactError(f"algorithm_version must be {ALGORITHM_VERSION!r}")
    trajectory = _obj(artifact.get("trajectory"), "trajectory")
    arrays = {
        field: trajectory.get(field)
        for field in ("time_s", "x_m", "y_m", "q", "edge_distance_m")
    }
    if any(not isinstance(value, list) for value in arrays.values()):
        raise HallArtifactError("trajectory arrays are required")
    count = len(arrays["time_s"])
    if count < 2 or any(len(value) != count for value in arrays.values()):
        raise HallArtifactError("trajectory arrays must have the same length and at least two samples")
    source = _source(trajectory.get("source"), "trajectory.source")
    provenance = _provenance(trajectory.get("provenance"), "trajectory.provenance")
    for index in range(count):
        time_s = _finite(arrays["time_s"][index], f"trajectory.time_s[{index}]")
        if index and time_s <= previous_time:
            raise HallArtifactError("trajectory.time_s must be strictly increasing")
        previous_time = time_s
        _finite(arrays["x_m"][index], f"trajectory.x_m[{index}]")
        _finite(arrays["y_m"][index], f"trajectory.y_m[{index}]")
        charge = _finite(arrays["q"][index], f"trajectory.q[{index}]")
        if abs(charge) < 0.5:
            raise HallArtifactError("trajectory.q indicates topology_lost")
        if _finite(arrays["edge_distance_m"][index], f"trajectory.edge_distance_m[{index}]") < 16e-9:
            raise HallArtifactError("trajectory.edge_distance_m indicates edge_contaminated")
    hall = _obj(artifact.get("hall_angle"), "hall_angle")
    reason = hall.get("reason_code")
    if reason is not None:
        if reason not in REASONS:
            raise HallArtifactError("hall_angle.reason_code is unknown")
        for field in ("v_parallel_m_per_s", "v_perp_m_per_s", "angle_rad", "angle_deg"):
            if hall.get(field) is not None:
                raise HallArtifactError("rejected Hall artifact must not publish velocity or angle")
        return
    velocity = [
        _finite(hall.get("v_parallel_m_per_s"), "hall_angle.v_parallel_m_per_s"),
        _finite(hall.get("v_perp_m_per_s"), "hall_angle.v_perp_m_per_s"),
    ]
    if math.hypot(*velocity) <= 0.0:
        raise HallArtifactError("accepted Hall artifact has no motion")
    angle_rad = _finite(hall.get("angle_rad"), "hall_angle.angle_rad")
    angle_deg = _finite(hall.get("angle_deg"), "hall_angle.angle_deg")
    expected_angle = math.atan2(velocity[1], velocity[0])
    if abs(math.atan2(math.sin(angle_rad - expected_angle), math.cos(angle_rad - expected_angle))) > 1e-10:
        raise HallArtifactError("hall_angle.angle_rad does not match atan2 velocity")
    if abs(angle_deg - math.degrees(angle_rad)) > 1e-8:
        raise HallArtifactError("hall_angle.angle_deg does not match angle_rad")
    interval = _obj(hall.get("accepted_interval"), "hall_angle.accepted_interval")
    start = interval.get("start_index")
    end = interval.get("end_index")
    if not isinstance(start, int) or not isinstance(end, int) or not 0 <= start < end < count:
        raise HallArtifactError("hall_angle.accepted_interval is outside trajectory")
    if interval.get("sample_count") != end - start + 1:
        raise HallArtifactError("hall_angle.accepted_interval.sample_count is inconsistent")
    residuals = hall.get("residuals_m")
    if not isinstance(residuals, list) or len(residuals) != end - start + 1:
        raise HallArtifactError("hall_angle.residuals_m does not match accepted interval")
    for index, residual in enumerate(residuals):
        _vector(residual, 2, f"hall_angle.residuals_m[{index}]")
    covariance = hall.get("velocity_covariance_m2_per_s2")
    if not isinstance(covariance, list) or len(covariance) != 2 or any(not isinstance(row, list) or len(row) != 2 for row in covariance):
        raise HallArtifactError("hall_angle.velocity_covariance_m2_per_s2 must be 2x2")
    matrix = [[_finite(value, "hall_angle.velocity_covariance_m2_per_s2") for value in row] for row in covariance]
    if abs(matrix[0][1] - matrix[1][0]) > 1e-12:
        raise HallArtifactError("velocity covariance must be symmetric")
    if matrix[0][0] < 0.0 or matrix[1][1] < 0.0 or matrix[0][0] * matrix[1][1] - matrix[0][1] ** 2 < -1e-30:
        raise HallArtifactError("velocity covariance must be positive semidefinite")
    reduced_chi_square = _finite(hall.get("reduced_chi_square"), "hall_angle.reduced_chi_square")
    if reduced_chi_square > 4.0:
        raise HallArtifactError("hall_angle.reduced_chi_square exceeds the weighted GLS gate")
    directional_coherence = _finite(
        hall.get("directional_coherence"), "hall_angle.directional_coherence"
    )
    if not 0.95 <= directional_coherence <= 1.0 + 1e-12:
        raise HallArtifactError("hall_angle.directional_coherence fails the directed-motion gate")
    _finite(hall.get("mean_signed_current_a_per_m2"), "hall_angle.mean_signed_current_a_per_m2")
    if _provenance(hall.get("provenance"), "hall_angle.provenance") != provenance:
        raise HallArtifactError("hall_angle.provenance does not match trajectory provenance")
    # The source must be present even though the Hall payload duplicates only
    # provenance: the trajectory owns the accepted $m(t)$ + geometry/grid seam.
    if not source:
        raise HallArtifactError("trajectory.source is required")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path)
    args = parser.parse_args(argv)
    try:
        value = json.loads(args.artifact.read_text(encoding="utf-8"))
        validate_hall_artifact(_obj(value, "artifact"))
    except (OSError, json.JSONDecodeError, HallArtifactError) as error:
        print(f"skyrmion Hall artifact rejected: {error}")
        return 1
    print("skyrmion Hall artifact contract: pass")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
