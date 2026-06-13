#!/usr/bin/env python3
"""Validate hysteresis magnetization playback artifacts."""

from __future__ import annotations

import csv
import json
import math
import struct
import sys
from pathlib import Path

TOL = 1.0e-9


def load_json(path: Path):
    return json.loads(path.read_text())


def load_component_major_chunk(path: Path, cell_count: int) -> list[list[float]]:
    raw = path.read_bytes()
    expected_bytes = cell_count * 3 * 8
    if len(raw) != expected_bytes:
        raise SystemExit(
            f"invalid chunk size for {path.name}: got {len(raw)}, expected {expected_bytes}"
        )
    values = [0.0] * (cell_count * 3)
    for index in range(cell_count * 3):
        values[index] = struct.unpack_from("<d", raw, index * 8)[0]
    return [
        [
            values[cell],
            values[cell_count + cell],
            values[2 * cell_count + cell],
        ]
        for cell in range(cell_count)
    ]


def assert_vectors_match(
    snapshot_id: str,
    zarr_values: list[list[float]],
    json_values: object,
) -> None:
    if not isinstance(json_values, list) or len(json_values) != len(zarr_values):
        raise SystemExit(
            f"JSON fallback vector count mismatch for {snapshot_id}: "
            f"got {len(json_values) if isinstance(json_values, list) else 'non-list'}, "
            f"expected {len(zarr_values)}"
        )
    for cell, (zarr_vector, json_vector) in enumerate(zip(zarr_values, json_values)):
        if not isinstance(json_vector, list) or len(json_vector) != 3:
            raise SystemExit(f"invalid JSON fallback vector for {snapshot_id} cell {cell}")
        for component, (actual, expected) in enumerate(zip(zarr_vector, json_vector)):
            if not math.isclose(float(actual), float(expected), rel_tol=0.0, abs_tol=1e-12):
                raise SystemExit(
                    "Zarr chunk does not match JSON fallback for "
                    f"{snapshot_id} cell {cell} component {component}: "
                    f"got {actual}, expected {expected}"
                )


def average_vector(values: list[list[float]]) -> list[float]:
    if not values:
        raise SystemExit("cannot average an empty magnetization snapshot")
    total = [0.0, 0.0, 0.0]
    for vector in values:
        for component in range(3):
            total[component] += vector[component]
    return [component_total / len(values) for component_total in total]


def weighted_average_vector(values: list[list[float]], weights: list[float]) -> list[float]:
    if len(values) != len(weights):
        raise SystemExit(
            f"average_weights length mismatch: got {len(weights)}, expected {len(values)}"
        )
    total = [0.0, 0.0, 0.0]
    weight_sum = 0.0
    for vector, weight in zip(values, weights):
        if not math.isfinite(float(weight)) or float(weight) <= 0.0:
            continue
        weight_value = float(weight)
        for component in range(3):
            total[component] += vector[component] * weight_value
        weight_sum += weight_value
    if weight_sum <= 0.0:
        raise SystemExit("average_weights must contain at least one positive weight")
    return [component_total / weight_sum for component_total in total]


def require_vec3(name: str, value: object) -> tuple[float, float, float]:
    if not isinstance(value, list) or len(value) != 3:
        raise SystemExit(f"{name} must be a 3-component vector, got {value!r}")
    vector = tuple(float(component) for component in value)
    if not all(math.isfinite(component) for component in vector):
        raise SystemExit(f"{name} must contain finite values, got {value!r}")
    return vector


def normalize_vector(name: str, vector: tuple[float, float, float]) -> tuple[float, float, float]:
    norm = math.sqrt(sum(component * component for component in vector))
    if norm <= 1.0e-15:
        raise SystemExit(f"{name} must not be a zero vector")
    return tuple(component / norm for component in vector)


def field_orientation_axis(point: dict, snapshot_id: str) -> tuple[float, float, float] | None:
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
        raise SystemExit(f"unsupported field_orientation preset for {snapshot_id}: {preset!r}")
    if kind == "sample":
        theta = math.radians(float(orientation["theta"]))
        phi = math.radians(float(orientation["phi"]))
        return (
            math.sin(theta) * math.cos(phi),
            math.sin(theta) * math.sin(phi),
            math.cos(theta),
        )
    if kind == "global":
        return normalize_vector(
            f"field_orientation.vector for {snapshot_id}",
            require_vec3(f"field_orientation.vector for {snapshot_id}", orientation.get("vector")),
        )
    raise SystemExit(f"unsupported field_orientation kind for {snapshot_id}: {kind!r}")


def field_axis_from_point(point: dict, snapshot_id: str) -> tuple[float, float, float]:
    axis = field_orientation_axis(point, snapshot_id)
    if axis is not None:
        return axis
    field_vector = point.get("field_vector_A_per_m")
    if field_vector is None:
        raise SystemExit(
            f"{snapshot_id} requires field_orientation or field_vector_A_per_m "
            "to validate m_parallel"
        )
    return normalize_vector(
        f"field_vector_A_per_m for {snapshot_id}",
        require_vec3(f"field_vector_A_per_m for {snapshot_id}", field_vector),
    )


def measurement_axis_from_point(point: dict, snapshot_id: str) -> tuple[float, float, float]:
    axis = point.get("measurement_axis", "field_axis")
    if axis in (None, "field_axis"):
        return field_axis_from_point(point, snapshot_id)
    if axis == "sample_normal":
        return (0.0, 0.0, 1.0)
    if isinstance(axis, dict) and axis.get("kind") == "custom":
        return normalize_vector(
            f"measurement_axis.vector for {snapshot_id}",
            require_vec3(f"measurement_axis.vector for {snapshot_id}", axis.get("vector")),
        )
    raise SystemExit(f"unsupported measurement_axis for {snapshot_id}: {axis!r}")


def assert_projection_components_match_point(point: dict, snapshot_id: str) -> None:
    m_avg = require_vec3(f"m_avg for {snapshot_id}", point.get("m_avg"))
    measurement_axis = measurement_axis_from_point(point, snapshot_id)
    expected_parallel = sum(m_avg[index] * measurement_axis[index] for index in range(3))
    expected_oop = m_avg[2]
    expected_ip = math.sqrt(m_avg[0] * m_avg[0] + m_avg[1] * m_avg[1])
    expected_components = {
        "m_parallel": expected_parallel,
        "m_oop": expected_oop,
        "m_ip": expected_ip,
    }
    for key, expected in expected_components.items():
        try:
            actual = float(point[key])
        except (KeyError, TypeError, ValueError) as exc:
            raise SystemExit(f"{key} for {snapshot_id} must be a finite number") from exc
        if not math.isfinite(actual) or abs(actual - expected) > TOL:
            raise SystemExit(
                f"{key} does not match m_avg/projection for {snapshot_id}: "
                f"got {actual}, expected {expected}"
            )


def load_average_weights(
    field_root: Path,
    zattrs: dict,
    root_zattrs: dict,
    cell_count: int,
    weighting: str,
) -> list[float] | None:
    if weighting == "uniform_sample_average":
        return None
    if root_zattrs.get("average_weights_ref") != "fields/m/average_weights":
        raise SystemExit(
            "weighted hysteresis playback requires "
            "hysteresis.zarr/.zattrs average_weights_ref='fields/m/average_weights'"
        )
    if zattrs.get("average_weights_ref") != "average_weights":
        raise SystemExit(
            "weighted hysteresis playback requires "
            "hysteresis.zarr/fields/m/.zattrs average_weights_ref='average_weights'"
        )
    weights_root = field_root / "average_weights"
    zarray = load_json(weights_root / ".zarray")
    if zarray.get("shape") != [cell_count] or zarray.get("chunks") != [cell_count]:
        raise SystemExit(
            "invalid average_weights Zarr shape/chunks: "
            f"shape={zarray.get('shape')!r} chunks={zarray.get('chunks')!r}"
        )
    if zarray.get("dtype") != "<f8":
        raise SystemExit(f"unexpected average_weights dtype: {zarray.get('dtype')!r}")
    raw = (weights_root / "0").read_bytes()
    expected_bytes = cell_count * 8
    if len(raw) != expected_bytes:
        raise SystemExit(
            f"invalid average_weights chunk size: got {len(raw)}, expected {expected_bytes}"
        )
    return [struct.unpack_from("<d", raw, index * 8)[0] for index in range(cell_count)]


def assert_point_average_matches_snapshot(
    snapshot_id: str,
    point: dict,
    zarr_values: list[list[float]],
    weighting: str,
    average_weights: list[float] | None,
) -> None:
    point_average = point.get("m_avg")
    if not isinstance(point_average, list) or len(point_average) != 3:
        raise SystemExit(f"invalid m_avg for {snapshot_id}: {point_average!r}")
    for component, value in enumerate(point_average):
        if not math.isfinite(float(value)):
            raise SystemExit(
                f"invalid m_avg for {snapshot_id} component {component}: {value!r}"
            )
    snapshot_average = (
        average_vector(zarr_values)
        if average_weights is None
        else weighted_average_vector(zarr_values, average_weights)
    )
    for component, (actual, expected) in enumerate(zip(point_average, snapshot_average)):
        if not math.isclose(float(actual), expected, rel_tol=0.0, abs_tol=1e-12):
            raise SystemExit(
                f"m_avg does not match Zarr snapshot for {snapshot_id} "
                f"component {component}: got {actual}, expected {expected}"
            )


def expected_snapshot_vector_ref(snapshot_id: str) -> str:
    return (
        "/v2/sessions/current/data/fields/m/samples/vector"
        f"?component=full&scope_kind=full&snapshot_id={snapshot_id}&stage_id=stage-000"
    )


def assert_snapshot_refs(point: dict, snapshot_id: str) -> None:
    expected_json_ref = f"hysteresis_snapshots/{snapshot_id}/m.json"
    expected_zarr_ref = "hysteresis.zarr"
    expected_vector_ref = expected_snapshot_vector_ref(snapshot_id)
    expected = {
        "snapshot_storage_format": "zarr_v2_json_fallback",
        "snapshot_json_artifact_ref": expected_json_ref,
        "snapshot_zarr_store_ref": expected_zarr_ref,
        "snapshot_resource_ref": expected_vector_ref,
        "snapshot_vector_resource_ref": expected_vector_ref,
    }
    for key, value in expected.items():
        actual = point.get(key)
        if actual != value:
            raise SystemExit(
                f"invalid {key} for {snapshot_id}: got {actual!r}, expected {value!r}"
            )


def assert_zarr_average_weighting(
    zattrs: dict,
    root_zattrs: dict,
    weighting: str,
) -> None:
    for source_name, attrs in (
        ("hysteresis.zarr/.zattrs", root_zattrs),
        ("hysteresis.zarr/fields/m/.zattrs", zattrs),
    ):
        zarr_weighting = attrs.get("magnetization_average_weighting")
        if zarr_weighting is not None and zarr_weighting != weighting:
            raise SystemExit(
                f"{source_name} magnetization_average_weighting mismatch: "
                f"got {zarr_weighting!r}, expected {weighting!r}"
            )


def assert_zarr_storage_policy(zattrs: dict, root_zattrs: dict) -> str:
    allowed = {"every_step", "every_n", "selected", "key_events"}
    root_policy = root_zattrs.get("magnetization_storage_policy")
    field_policy = zattrs.get("magnetization_storage_policy")
    if not isinstance(root_policy, str) or root_policy not in allowed:
        raise SystemExit(
            "hysteresis.zarr/.zattrs magnetization_storage_policy must be one of "
            f"{sorted(allowed)}, got {root_policy!r}"
        )
    if field_policy != root_policy:
        raise SystemExit(
            "hysteresis.zarr/fields/m/.zattrs magnetization_storage_policy mismatch: "
            f"got {field_policy!r}, expected {root_policy!r}"
        )
    return root_policy


def assert_zarr_manifest(zattrs: dict, root_zattrs: dict) -> None:
    expected_root = {
        "fullmag_kind": "hysteresis_field_sequence",
        "preferred_container": "zarr",
        "point_index_file": "points.csv",
    }
    for key, expected in expected_root.items():
        actual = root_zattrs.get(key)
        if actual != expected:
            raise SystemExit(
                f"hysteresis.zarr/.zattrs {key} must be {expected!r}, got {actual!r}"
            )
    schema_version = root_zattrs.get("schema_version")
    if not isinstance(schema_version, int) or schema_version <= 0:
        raise SystemExit(
            "hysteresis.zarr/.zattrs schema_version must be a positive integer, "
            f"got {schema_version!r}"
        )
    quantity_ids = root_zattrs.get("quantity_ids")
    if not isinstance(quantity_ids, list) or "m" not in quantity_ids:
        raise SystemExit(
            "hysteresis.zarr/.zattrs quantity_ids must include 'm', "
            f"got {quantity_ids!r}"
        )

    expected_field = {
        "quantity_id": "m",
        "unit": "1",
        "axes": ["point", "component", "spatial_sample"],
        "component_order": ["x", "y", "z"],
        "storage_layout": "soa_component_major",
        "sample_index_file": "samples.csv",
    }
    for key, expected in expected_field.items():
        actual = zattrs.get(key)
        if actual != expected:
            raise SystemExit(
                f"hysteresis.zarr/fields/m/.zattrs {key} must be {expected!r}, "
                f"got {actual!r}"
            )


def assert_sample_index_contract(samples: list[dict[str, str]]) -> None:
    required_columns = {
        "sample_index",
        "snapshot_id",
        "point_id",
        "field_value_mT",
        "quantity_id",
        "chunk_key",
        "cell_count",
        "grid_x",
        "grid_y",
        "grid_z",
        "branch_id",
        "protocol_role",
        "mesh_identity",
        "field_revision",
    }
    if not samples:
        raise SystemExit("samples.csv must contain at least one sample row")
    missing = sorted(required_columns.difference(samples[0].keys()))
    if missing:
        raise SystemExit(
            "samples.csv is missing required hysteresis playback columns: "
            + ", ".join(missing)
        )


def assert_sample_row_matches_point(
    row: dict[str, str],
    point: dict,
    snapshot_id: str,
    expected_cell_count: int,
) -> None:
    if row.get("quantity_id") != "m":
        raise SystemExit(
            f"samples.csv quantity_id must be 'm' for {snapshot_id}: "
            f"got {row.get('quantity_id')!r}"
        )
    if row.get("component_count") != "3":
        raise SystemExit(
            f"samples.csv component_count must be 3 for {snapshot_id}: "
            f"got {row.get('component_count')!r}"
        )
    if row.get("dtype") != "<f8":
        raise SystemExit(
            f"samples.csv dtype must be '<f8' for {snapshot_id}: "
            f"got {row.get('dtype')!r}"
        )
    try:
        cell_count = int(str(row.get("cell_count") or ""))
    except ValueError as exc:
        raise SystemExit(f"samples.csv cell_count must be an integer for {snapshot_id}") from exc
    if cell_count != expected_cell_count:
        raise SystemExit(
            f"samples.csv cell_count mismatch for {snapshot_id}: "
            f"got {cell_count}, expected {expected_cell_count}"
        )
    expected_branch_id = str(point.get("branch_id") or "")
    expected_protocol_role = str(point.get("protocol_role") or "")
    if str(row.get("branch_id") or "") != expected_branch_id:
        raise SystemExit(
            f"samples.csv branch_id mismatch for {snapshot_id}: "
            f"got {row.get('branch_id')!r}, expected {expected_branch_id!r}"
        )
    if str(row.get("protocol_role") or "") != expected_protocol_role:
        raise SystemExit(
            f"samples.csv protocol_role mismatch for {snapshot_id}: "
            f"got {row.get('protocol_role')!r}, expected {expected_protocol_role!r}"
        )
    mesh_identity = str(row.get("mesh_identity") or "")
    if not mesh_identity:
        raise SystemExit(f"samples.csv mesh_identity is required for {snapshot_id}")
    try:
        field_revision = int(str(row.get("field_revision") or ""))
    except ValueError as exc:
        raise SystemExit(
            f"samples.csv field_revision must be an integer for {snapshot_id}"
        ) from exc
    if field_revision <= 0:
        raise SystemExit(
            f"samples.csv field_revision must be positive for {snapshot_id}"
        )


def assert_root_point_index_matches_samples(
    point_rows: list[dict[str, str]],
    sample_rows: list[dict[str, str]],
) -> None:
    assert_sample_index_contract(point_rows)
    if len(point_rows) != len(sample_rows):
        raise SystemExit(
            f"points.csv row count mismatch: points.csv has {len(point_rows)}, "
            f"samples.csv has {len(sample_rows)}"
        )
    samples_by_snapshot = {row.get("snapshot_id"): row for row in sample_rows}
    for row in point_rows:
        snapshot_id = row.get("snapshot_id")
        sample = samples_by_snapshot.get(snapshot_id)
        if sample is None:
            raise SystemExit(f"points.csv references unknown snapshot_id {snapshot_id!r}")
        for key in (
            "sample_index",
            "point_id",
            "field_value_mT",
            "quantity_id",
            "grid_x",
            "grid_y",
            "grid_z",
            "cell_count",
            "component_count",
            "dtype",
            "branch_id",
            "protocol_role",
            "mesh_identity",
            "field_revision",
        ):
            if row.get(key) != sample.get(key):
                raise SystemExit(
                    f"points.csv {key} mismatch for {snapshot_id}: "
                    f"got {row.get(key)!r}, expected {sample.get(key)!r}"
                )
        expected_chunk_key = f"fields/m/{sample.get('chunk_key')}"
        if row.get("chunk_key") != expected_chunk_key:
            raise SystemExit(
                f"points.csv chunk_key mismatch for {snapshot_id}: "
                f"got {row.get('chunk_key')!r}, expected {expected_chunk_key!r}"
            )


def assert_settle_trace_covers_snapshot_points(
    root: Path,
    snapshot_points: list[dict],
) -> None:
    trace_path = root / "hysteresis_settle_trace.json"
    if not trace_path.is_file():
        raise SystemExit(f"missing hysteresis settle_trace artifact: {trace_path}")
    trace = load_json(trace_path)
    if not isinstance(trace, list) or not trace:
        raise SystemExit("hysteresis_settle_trace.json must contain a non-empty list")

    point_ids_with_trace: set[int] = set()
    for index, record in enumerate(trace):
        if not isinstance(record, dict):
            raise SystemExit(f"settle_trace[{index}] must be an object")
        point_id = record.get("point_id")
        if not isinstance(point_id, int):
            raise SystemExit(f"settle_trace[{index}].point_id must be an integer")
        for key in ("algorithm_id", "method", "status"):
            value = record.get(key)
            if not isinstance(value, str) or not value:
                raise SystemExit(f"settle_trace[{index}].{key} must be a non-empty string")
        point_ids_with_trace.add(point_id)

    missing = [
        str(point.get("point_id", index))
        for index, point in enumerate(snapshot_points)
        if point.get("point_id") not in point_ids_with_trace
    ]
    if missing:
        raise SystemExit(
            "settle_trace is missing records for snapshot point ids: "
            + ", ".join(missing)
        )


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit(
            "usage: scripts/verify_hysteresis_playback_artifacts.py <artifact-dir>"
        )

    root = Path(sys.argv[1])
    points_path = root / "hysteresis_points.json"
    metrics_path = root / "hysteresis_metrics.json"
    zarr_root = root / "hysteresis.zarr"
    field_root = zarr_root / "fields" / "m"
    points_index_path = zarr_root / "points.csv"
    samples_path = field_root / "samples.csv"
    zarray_path = field_root / ".zarray"
    zattrs_path = field_root / ".zattrs"

    required = [
        points_path,
        zarr_root / ".zgroup",
        zarr_root / ".zattrs",
        zarray_path,
        zattrs_path,
        points_index_path,
        samples_path,
    ]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise SystemExit(
            "missing required hysteresis playback artifacts:\n" + "\n".join(missing)
        )

    points = load_json(points_path)
    if not isinstance(points, list) or not points:
        raise SystemExit("hysteresis_points.json must contain a non-empty point list")
    metrics = load_json(metrics_path) if metrics_path.is_file() else {}
    weighting = metrics.get("magnetization_average_weighting", "uniform_sample_average")
    if not isinstance(weighting, str) or not weighting:
        raise SystemExit(
            "hysteresis_metrics.json magnetization_average_weighting must be a non-empty string"
        )

    snapshot_points = [point for point in points if point.get("snapshot_id")]
    if not snapshot_points:
        raise SystemExit("no hysteresis points contain snapshot_id values")
    if len(snapshot_points) != len(points):
        missing_snapshot_points = [
            str(point.get("point_id", index))
            for index, point in enumerate(points)
            if not point.get("snapshot_id")
        ]
        raise SystemExit(
            "playback requires snapshot_id for every hysteresis point; "
            "missing point ids: " + ", ".join(missing_snapshot_points)
        )

    zattrs = load_json(zattrs_path)
    root_zattrs = load_json(zarr_root / ".zattrs")
    zarray = load_json(zarray_path)
    assert_zarr_manifest(zattrs, root_zattrs)
    assert_zarr_average_weighting(zattrs, root_zattrs, weighting)
    storage_policy = assert_zarr_storage_policy(zattrs, root_zattrs)

    shape = zarray.get("shape")
    chunks = zarray.get("chunks")
    if not (
        isinstance(shape, list)
        and len(shape) == 3
        and isinstance(chunks, list)
        and len(chunks) == 3
    ):
        raise SystemExit(f"invalid Zarr shape/chunks metadata: {shape!r} {chunks!r}")
    if shape[1] != 3 or chunks[0] != 1 or chunks[1] != 3:
        raise SystemExit(f"unexpected Zarr vector layout: shape={shape!r} chunks={chunks!r}")
    if zarray.get("dtype") != "<f8":
        raise SystemExit(f"unexpected Zarr dtype: {zarray.get('dtype')!r}")
    average_weights = load_average_weights(
        field_root,
        zattrs,
        root_zattrs,
        int(shape[2]),
        weighting,
    )

    with samples_path.open(newline="") as handle:
        samples = list(csv.DictReader(handle))
    assert_sample_index_contract(samples)
    with points_index_path.open(newline="") as handle:
        point_index_rows = list(csv.DictReader(handle))
    assert_root_point_index_matches_samples(point_index_rows, samples)
    if len(samples) != len(snapshot_points):
        raise SystemExit(
            f"sample count mismatch: samples.csv has {len(samples)}, "
            f"hysteresis_points.json has {len(snapshot_points)} snapshot points"
        )
    if shape[0] != len(samples):
        raise SystemExit(
            f"Zarr point axis mismatch: shape[0]={shape[0]}, samples={len(samples)}"
        )
    assert_settle_trace_covers_snapshot_points(root, snapshot_points)

    rows_by_snapshot = {row.get("snapshot_id"): row for row in samples}
    missing_rows = [
        point["snapshot_id"]
        for point in snapshot_points
        if point.get("snapshot_id") not in rows_by_snapshot
    ]
    if missing_rows:
        raise SystemExit(
            "missing Zarr sample rows for snapshot ids:\n" + "\n".join(missing_rows)
        )

    for point in snapshot_points:
        snapshot_id = point["snapshot_id"]
        assert_snapshot_refs(point, snapshot_id)
        row = rows_by_snapshot[snapshot_id]
        assert_sample_row_matches_point(row, point, snapshot_id, int(shape[2]))
        chunk_key = row.get("chunk_key")
        chunk_path = field_root / str(chunk_key)
        if not chunk_path.is_file():
            raise SystemExit(f"missing Zarr chunk for {snapshot_id}: {chunk_path}")
        cell_count = int(row.get("cell_count", "0"))
        zarr_values = load_component_major_chunk(chunk_path, cell_count)
        fallback = root / "hysteresis_snapshots" / snapshot_id / "m.json"
        if not fallback.is_file():
            raise SystemExit(f"missing compatibility m.json fallback: {fallback}")
        assert_vectors_match(snapshot_id, zarr_values, load_json(fallback).get("values"))
        assert_point_average_matches_snapshot(
            snapshot_id,
            point,
            zarr_values,
            weighting,
            average_weights,
        )
        assert_projection_components_match_point(point, snapshot_id)

    print(
        f"validated hysteresis playback: points={len(points)} "
        f"snapshots={len(snapshot_points)} cell_count={shape[2]} "
        f"container=zarr average_weighting={weighting} storage_policy={storage_policy}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
