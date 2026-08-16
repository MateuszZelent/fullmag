#!/usr/bin/env python3
"""Build a fail-closed skyrmion Hall artifact from an accepted FDM field series.

The producer intentionally consumes the persisted numerical source (the
versioned FDM ``m.zarr`` plus grid/FMRM provenance), never renderer data or a
pre-computed centre.  It supports the uncompressed Zarr-v2 layout emitted by
the current FDM artifact writer and refuses layouts it cannot prove correct.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import struct
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

try:
    from scripts.validate_skyrmion_hall_angle import validate_hall_artifact
except ModuleNotFoundError:  # direct ``python scripts/build_...py`` invocation
    from validate_skyrmion_hall_angle import validate_hall_artifact


MIN_WINDOW_SAMPLES = 21
MIN_WINDOW_DURATION_S = 100.0e-12
MIN_EDGE_DISTANCE_M = 16.0e-9
MIN_DISPLACEMENT_M = 4.0e-9
MIN_MEAN_SPEED_M_PER_S = 1.0
MAX_SPEED_CV = 0.10
MAX_RELATIVE_CHARGE_DEVIATION = 0.05
MAX_REDUCED_CHI_SQUARE = 4.0
MIN_DIRECTIONAL_COHERENCE = 0.95
MIN_ABS_TOPOLOGICAL_CHARGE = 0.5
FMRM_HEADER_BYTES = 64
FMRM_INACTIVE = 0xFFFFFFFF
TOPOLOGICAL_CHARGE_METHOD = "berg_luescher_fdm_regular_grid.v1"
UNCERTAINTY_MODEL = "cell_centroid_quantization.v1"


class HallBuildError(ValueError):
    """The persisted runtime artifacts are insufficient or inconsistent."""


def _json(path: Path, label: str) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise HallBuildError(f"{label} is unreadable: {path}") from error
    if not isinstance(value, Mapping):
        raise HallBuildError(f"{label} must be an object: {path}")
    return value


def _finite(value: Any, label: str) -> float:
    if isinstance(value, str):
        try:
            value = float(value)
        except ValueError:
            value = None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise HallBuildError(f"{label} must be finite")
    return float(value)


def _sha256_files(paths: Iterable[Path]) -> str:
    digest = hashlib.sha256()
    for path in sorted(paths, key=lambda item: item.as_posix()):
        try:
            data = path.read_bytes()
        except OSError as error:
            raise HallBuildError(f"cannot hash artifact: {path}") from error
        digest.update(path.name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(data)
    return digest.hexdigest()


def _find_values(value: Any, key: str) -> list[Any]:
    found: list[Any] = []
    if isinstance(value, Mapping):
        for name, child in value.items():
            if name == key:
                found.append(child)
            found.extend(_find_values(child, key))
    elif isinstance(value, list):
        for child in value:
            found.extend(_find_values(child, key))
    return found


def _read_grid(stage: Path) -> tuple[dict[str, Any], list[int], list[float], list[float], list[int], bytes]:
    certificate_root = _json(stage / "mesh/fdm_grid_certificate.json", "FDM grid certificate")
    certificate = certificate_root.get("certificate")
    if not isinstance(certificate, Mapping):
        raise HallBuildError("FDM grid certificate lacks certificate object")
    descriptor = _json(stage / "mesh/fdm_region_membership.v2.json", "FDM membership descriptor")
    if descriptor.get("schema_version") != "fdm_region_membership.v2":
        raise HallBuildError("unsupported FDM membership descriptor schema")
    counts = certificate.get("counts")
    cell_m = certificate.get("cell_m")
    origin_m = certificate.get("origin_m")
    grid_fingerprint = certificate.get("grid_fingerprint")
    if not isinstance(counts, list) or len(counts) != 3 or any(not isinstance(item, int) or item <= 0 for item in counts):
        raise HallBuildError("FDM grid counts are invalid")
    if not isinstance(cell_m, list) or len(cell_m) != 3 or any(_finite(item, "cell_m") <= 0.0 for item in cell_m):
        raise HallBuildError("FDM cell sizes are invalid")
    if not isinstance(origin_m, list) or len(origin_m) != 3:
        raise HallBuildError("FDM grid origin is invalid")
    if not isinstance(grid_fingerprint, str) or len(grid_fingerprint) != 64:
        raise HallBuildError("FDM grid fingerprint is invalid")
    if descriptor.get("counts") != counts or descriptor.get("grid_fingerprint") != grid_fingerprint:
        raise HallBuildError("FDM certificate and membership descriptor disagree")
    binary_path = stage / "mesh/fdm_region_membership.v2.bin"
    try:
        payload = binary_path.read_bytes()
    except OSError as error:
        raise HallBuildError("FDM membership binary is unreadable") from error
    if len(payload) < FMRM_HEADER_BYTES or payload[:4] != b"FMRM" or payload[4:6] != bytes([2, 2]):
        raise HallBuildError("unsupported or truncated FMRM header")
    binary_counts = list(struct.unpack_from("<3I", payload, 8))
    cell_count, legend_count = struct.unpack_from("<2I", payload, 20)
    if binary_counts != counts or cell_count != math.prod(counts):
        raise HallBuildError("FMRM header disagrees with grid descriptor")
    if payload[28:60] != bytes.fromhex(grid_fingerprint) or legend_count != len(descriptor.get("region_legend", [])):
        raise HallBuildError("FMRM identity disagrees with grid descriptor")
    expected_bytes = FMRM_HEADER_BYTES + 4 * cell_count
    if len(payload) != expected_bytes:
        raise HallBuildError("FMRM payload length is inconsistent")
    memberships = list(struct.unpack_from(f"<{cell_count}I", payload, FMRM_HEADER_BYTES))
    active = [index for index, value in enumerate(memberships) if value != FMRM_INACTIVE]
    if not active:
        raise HallBuildError("FMRM contains no magnetic-support cells")
    nx, ny, nz = counts
    plane_counts = [0] * nz
    plane_indices: list[list[int]] = [[] for _ in range(nz)]
    plane_size = nx * ny
    for index in active:
        plane = index // plane_size
        plane_counts[plane] += 1
        plane_indices[plane].append(index)
    populated = [plane for plane, count in enumerate(plane_counts) if count]
    if len(populated) != 1:
        raise HallBuildError("Hall producer requires exactly one populated magnetic FDM plane")
    plane = populated[0]
    if plane_counts[plane] != plane_size or set(plane_indices[plane]) != set(range(plane * plane_size, (plane + 1) * plane_size)):
        raise HallBuildError("Hall producer requires a complete rectangular magnetic FDM plane")
    return (
        {
            "grid_fingerprint": grid_fingerprint,
            "certificate": certificate,
            "descriptor": descriptor,
            "membership_bytes": payload,
        },
        counts,
        [float(item) for item in cell_m],
        [float(item) for item in origin_m],
        [plane],
        payload,
    )


def _read_series(stage: Path, counts: Sequence[int]) -> tuple[list[float], list[list[list[float]]], list[Path]]:
    zarr = stage / "fields/m.zarr"
    zarray = _json(zarr / ".zarray", "m.zarr metadata")
    if zarray.get("zarr_format") != 2 or zarray.get("dtype") != "<f8" or zarray.get("order") != "C":
        raise HallBuildError("unsupported m.zarr format or dtype")
    if zarray.get("compressor") is not None or zarray.get("filters") is not None:
        raise HallBuildError("compressor or filters in m.zarr are not supported by the fail-closed producer")
    shape = zarray.get("shape")
    chunks = zarray.get("chunks")
    cell_count = math.prod(counts)
    if not isinstance(shape, list) or len(shape) != 3 or not isinstance(shape[0], int) or shape[0] < 1:
        raise HallBuildError("m.zarr sample shape is invalid")
    if shape[1:] != [3, cell_count]:
        raise HallBuildError("m.zarr shape must be [samples,3,grid_cells]")
    if chunks != [1, 3, cell_count]:
        raise HallBuildError("m.zarr must use one complete sample chunk")
    samples_path = zarr / "samples.csv"
    try:
        with samples_path.open(newline="", encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))
    except OSError as error:
        raise HallBuildError("m.zarr samples.csv is unreadable") from error
    if len(rows) != shape[0]:
        raise HallBuildError("m.zarr sample index and samples.csv disagree")
    times: list[float] = []
    values: list[list[list[float]]] = []
    source_files: list[Path] = [zarr / ".zarray", zarr / ".zattrs", samples_path]
    for sample, row in enumerate(rows):
        if row.get("sample") != str(sample) or row.get("chunk_key") != f"{sample}.0.0":
            raise HallBuildError("m.zarr samples.csv is not a contiguous sample sequence")
        time_s = _finite(row.get("time"), f"m.zarr sample {sample} time")
        if times and time_s <= times[-1]:
            raise HallBuildError("m.zarr sample times are not strictly increasing")
        times.append(time_s)
        chunk = zarr / f"{sample}.0.0"
        try:
            payload = chunk.read_bytes()
        except OSError as error:
            raise HallBuildError(f"m.zarr chunk is unreadable: {chunk}") from error
        expected = 3 * cell_count * 8
        if len(payload) != expected:
            raise HallBuildError(f"m.zarr chunk length is invalid: {chunk}")
        unpacked = struct.unpack(f"<{3 * cell_count}d", payload)
        values.append([list(unpacked[offset * cell_count : (offset + 1) * cell_count]) for offset in range(3)])
        source_files.append(chunk)
    return times, values, source_files


def _triangle_charge(a: Sequence[float], b: Sequence[float], c: Sequence[float]) -> float:
    vectors = []
    for vector in (a, b, c):
        norm = math.sqrt(sum(component * component for component in vector))
        if norm <= 0.5 or not math.isfinite(norm):
            raise HallBuildError("m.zarr has an invalid active magnetization vector")
        vectors.append([component / norm for component in vector])
    a, b, c = vectors
    cross = [b[1] * c[2] - b[2] * c[1], b[2] * c[0] - b[0] * c[2], b[0] * c[1] - b[1] * c[0]]
    numerator = sum(a[index] * cross[index] for index in range(3))
    denominator = 1.0 + sum(a[index] * b[index] for index in range(3)) + sum(b[index] * c[index] for index in range(3)) + sum(c[index] * a[index] for index in range(3))
    return 2.0 * math.atan2(numerator, denominator) / (4.0 * math.pi)


def _sample_geometry(values: list[list[float]], counts: Sequence[int], cell: Sequence[float], origin: Sequence[float], plane: int) -> tuple[float, float, float, float]:
    nx, ny, _ = counts
    plane_offset = plane * nx * ny

    def vector(x: int, y: int) -> list[float]:
        index = plane_offset + x + nx * y
        return [values[component][index] for component in range(3)]

    total_charge = 0.0
    weighted_x = 0.0
    weighted_y = 0.0
    for y in range(ny - 1):
        for x in range(nx - 1):
            triangles = (
                ((x, y), (x + 1, y), (x + 1, y + 1), (x + 2.0 / 3.0, y + 1.0 / 3.0)),
                ((x, y), (x + 1, y + 1), (x, y + 1), (x + 1.0 / 3.0, y + 2.0 / 3.0)),
            )
            for first, second, third, centroid in triangles:
                charge = _triangle_charge(vector(*first), vector(*second), vector(*third))
                total_charge += charge
                weighted_x += charge * (origin[0] + centroid[0] * cell[0])
                weighted_y += charge * (origin[1] + centroid[1] * cell[1])
    if not math.isfinite(total_charge) or abs(total_charge) < MIN_ABS_TOPOLOGICAL_CHARGE:
        raise HallBuildError("topological charge is below the fail-closed topology gate")
    centre_x = weighted_x / total_charge
    centre_y = weighted_y / total_charge
    bounds_min_x = origin[0] + 0.0 * cell[0]
    bounds_max_x = origin[0] + nx * cell[0]
    bounds_min_y = origin[1] + 0.0 * cell[1]
    bounds_max_y = origin[1] + ny * cell[1]
    edge_distance = min(centre_x - bounds_min_x, bounds_max_x - centre_x, centre_y - bounds_min_y, bounds_max_y - centre_y)
    if edge_distance < 0.0:
        raise HallBuildError("computed skyrmion centre lies outside magnetic support")
    return total_charge, centre_x, centre_y, edge_distance


def _current_density(metadata: Mapping[str, Any]) -> float:
    problem_meta = metadata.get("problem_meta")
    if not isinstance(problem_meta, Mapping):
        raise HallBuildError("stage metadata lacks problem_meta")
    runtime_metadata = problem_meta.get("runtime_metadata")
    if not isinstance(runtime_metadata, Mapping):
        raise HallBuildError("stage metadata lacks runtime_metadata")
    modules = _find_values(runtime_metadata, "current_modules")
    boundaries: list[Mapping[str, Any]] = []
    for module in modules:
        if isinstance(module, list):
            for item in module:
                if isinstance(item, Mapping) and isinstance(item.get("boundaries"), list):
                    boundaries.extend(item["boundaries"])
    values: dict[str, float] = {}
    for boundary in boundaries:
        identifier = boundary.get("id")
        value = boundary.get("outward_current_density_Apm2")
        if identifier in {"terminal_x_minus", "terminal_x_plus"}:
            values[str(identifier)] = _finite(value, f"current boundary {identifier}")
    if set(values) != {"terminal_x_minus", "terminal_x_plus"}:
        raise HallBuildError("stage current transport lacks both x terminal boundary values")
    if not math.isclose(values["terminal_x_minus"], -values["terminal_x_plus"], rel_tol=1e-12, abs_tol=1e-9):
        raise HallBuildError("x terminal current boundary values are not conservative opposites")
    return -values["terminal_x_plus"]


def _provenance(stage: Path, grid: Mapping[str, Any], source_files: Sequence[Path], membership_bytes: bytes, metadata: Mapping[str, Any], graph: Mapping[str, Any]) -> dict[str, Any]:
    grid_id = str(grid["grid_fingerprint"])
    field_revision = _sha256_files(source_files)
    mapping_id = hashlib.sha256(membership_bytes).hexdigest()
    stage_id = str(_find_values(metadata, "active_stage_id")[0]) if _find_values(metadata, "active_stage_id") else stage.name
    values = {
        "scene_revision": str(graph.get("scene_revision", "")),
        "field_revision": field_revision,
        "mesh_revision": str(graph.get("mesh_revision", "")),
        "mesh_generation_id": grid_id,
        "domain_generation_id": grid_id,
        "global_node_mapping_id": mapping_id,
        "snapshot_id": None,
        "stage_id": stage_id,
        "cache_key_digest": "",
        "uncertainty_model": UNCERTAINTY_MODEL,
        "uncertainty_calibration_status": "provisional_cell_quantization",
    }
    if not values["scene_revision"] or not values["mesh_revision"]:
        raise HallBuildError("physics graph provenance lacks scene or mesh revision")
    values["cache_key_digest"] = hashlib.sha256(json.dumps(values, sort_keys=True).encode("utf-8")).hexdigest()
    return values


def _invert(matrix: list[list[float]]) -> list[list[float]] | None:
    size = len(matrix)
    augmented = [row[:] + [1.0 if row_index == column else 0.0 for column in range(size)] for row_index, row in enumerate(matrix)]
    for pivot_column in range(size):
        pivot_row = max(range(pivot_column, size), key=lambda row: abs(augmented[row][pivot_column]))
        pivot = augmented[pivot_row][pivot_column]
        if not math.isfinite(pivot) or abs(pivot) <= 1e-30:
            return None
        augmented[pivot_column], augmented[pivot_row] = augmented[pivot_row], augmented[pivot_column]
        pivot = augmented[pivot_column][pivot_column]
        augmented[pivot_column] = [value / pivot for value in augmented[pivot_column]]
        for row in range(size):
            if row == pivot_column:
                continue
            factor = augmented[row][pivot_column]
            augmented[row] = [left - factor * right for left, right in zip(augmented[row], augmented[pivot_column])]
    result = [row[size:] for row in augmented]
    return result if all(math.isfinite(value) for row in result for value in row) else None


def _fit(samples: list[dict[str, Any]], start_index: int) -> dict[str, Any] | None:
    if len(samples) <= 2:
        return None
    normal = [[0.0] * 4 for _ in range(4)]
    rhs = [0.0] * 4
    for sample in samples:
        covariance = sample["covariance"]
        inverse = _invert(covariance)
        if inverse is None:
            return None
        design = [[1.0, 0.0, sample["time_s"], 0.0], [0.0, 1.0, 0.0, sample["time_s"]]]
        observation = sample["centre"]
        for i in range(4):
            for j in range(4):
                normal[i][j] += sum(design[ci][i] * inverse[ci][cj] * design[cj][j] for ci in range(2) for cj in range(2))
            rhs[i] += sum(design[ci][i] * inverse[ci][cj] * observation[cj] for ci in range(2) for cj in range(2))
    parameter_covariance = _invert(normal)
    if parameter_covariance is None:
        return None
    parameters = [sum(parameter_covariance[row][column] * rhs[column] for column in range(4)) for row in range(4)]
    velocity = [parameters[2], parameters[3]]
    residuals = [[sample["centre"][0] - (parameters[0] + velocity[0] * sample["time_s"]), sample["centre"][1] - (parameters[1] + velocity[1] * sample["time_s"])] for sample in samples]
    normalized = 0.0
    for sample, residual in zip(samples, residuals):
        inverse = _invert(sample["covariance"])
        if inverse is None:
            return None
        normalized += residual[0] * (inverse[0][0] * residual[0] + inverse[0][1] * residual[1]) + residual[1] * (inverse[1][0] * residual[0] + inverse[1][1] * residual[1])
    degrees = len(samples) - 2
    reduced_chi_square = normalized / (2.0 * degrees)
    speed_squared = velocity[0] ** 2 + velocity[1] ** 2
    if not math.isfinite(reduced_chi_square) or reduced_chi_square > MAX_REDUCED_CHI_SQUARE or speed_squared <= 0.0:
        return None
    speed = math.sqrt(speed_squared)
    projected = 0.0
    total_distance = 0.0
    for left, right in zip(samples, samples[1:]):
        delta = [right["centre"][0] - left["centre"][0], right["centre"][1] - left["centre"][1]]
        projected += delta[0] * velocity[0] / speed + delta[1] * velocity[1] / speed
        total_distance += math.hypot(*delta)
    coherence = projected / total_distance if total_distance > 0.0 else 0.0
    if coherence < MIN_DIRECTIONAL_COHERENCE:
        return None
    velocity_covariance = [[parameter_covariance[2][2], parameter_covariance[2][3]], [parameter_covariance[3][2], parameter_covariance[3][3]]]
    angle_variance = (velocity[1] ** 2 * velocity_covariance[0][0] + velocity[0] ** 2 * velocity_covariance[1][1] - 2.0 * velocity[0] * velocity[1] * velocity_covariance[0][1]) / speed_squared ** 2
    return {
        "start_index": start_index,
        "end_index": start_index + len(samples) - 1,
        "velocity": velocity,
        "velocity_covariance": velocity_covariance,
        "residuals": residuals,
        "angle_rad": math.atan2(velocity[1], velocity[0]),
        "angle_variance_rad2": angle_variance,
        "mean_current": sum(sample["current"] for sample in samples) / len(samples),
        "reduced_chi_square": reduced_chi_square,
        "directional_coherence": coherence,
        "duration_s": samples[-1]["time_s"] - samples[0]["time_s"],
    }


def _analyse(samples: list[dict[str, Any]], trajectory: dict[str, Any]) -> dict[str, Any]:
    hall: dict[str, Any] = {
        "v_parallel_m_per_s": None,
        "v_perp_m_per_s": None,
        "angle_rad": None,
        "angle_deg": None,
        "angle_variance_rad2": None,
        "velocity_covariance_m2_per_s2": None,
        "residuals_m": None,
        "accepted_interval": None,
        "mean_signed_current_a_per_m2": None,
        "reduced_chi_square": None,
        "directional_coherence": None,
        "provenance": None,
        "reason_code": None,
    }
    if any(abs(sample["q"]) < MIN_ABS_TOPOLOGICAL_CHARGE for sample in samples):
        hall["reason_code"] = "topology_lost"
    elif any(sample["edge_distance_m"] < MIN_EDGE_DISTANCE_M for sample in samples):
        hall["reason_code"] = "edge_contaminated"
    elif len(samples) < MIN_WINDOW_SAMPLES:
        hall["reason_code"] = "insufficient_samples"
    else:
        motion_exists = False
        for left, right in zip(samples, samples[1:]):
            displacement = math.hypot(right["centre"][0] - left["centre"][0], right["centre"][1] - left["centre"][1])
            speed = displacement / (right["time_s"] - left["time_s"])
            motion_exists |= displacement >= MIN_DISPLACEMENT_M and speed >= MIN_MEAN_SPEED_M_PER_S
        motion_exists |= math.hypot(samples[-1]["centre"][0] - samples[0]["centre"][0], samples[-1]["centre"][1] - samples[0]["centre"][1]) >= MIN_DISPLACEMENT_M
        selected: dict[str, Any] | None = None
        for start in range(len(samples)):
            for end in range(start + MIN_WINDOW_SAMPLES - 1, len(samples)):
                window = samples[start : end + 1]
                duration = window[-1]["time_s"] - window[0]["time_s"]
                if duration < MIN_WINDOW_DURATION_S:
                    continue
                charges = sorted(sample["q"] for sample in window)
                middle = len(charges) // 2
                median = (charges[middle - 1] + charges[middle]) / 2.0 if len(charges) % 2 == 0 else charges[middle]
                if median == 0.0 or any(abs(sample["q"] - median) > MAX_RELATIVE_CHARGE_DEVIATION * abs(median) for sample in window):
                    continue
                speeds = [math.hypot(right["centre"][0] - left["centre"][0], right["centre"][1] - left["centre"][1]) / (right["time_s"] - left["time_s"]) for left, right in zip(window, window[1:])]
                mean_speed = sum(speeds) / len(speeds)
                speed_cv = math.sqrt(sum((speed - mean_speed) ** 2 for speed in speeds) / len(speeds)) / max(mean_speed, MIN_MEAN_SPEED_M_PER_S)
                net = math.hypot(window[-1]["centre"][0] - window[0]["centre"][0], window[-1]["centre"][1] - window[0]["centre"][1])
                if net < MIN_DISPLACEMENT_M or mean_speed < MIN_MEAN_SPEED_M_PER_S or speed_cv > MAX_SPEED_CV:
                    continue
                fit = _fit(window, start)
                if fit is not None and (selected is None or (fit["duration_s"], -fit["start_index"]) > (selected["duration_s"], -selected["start_index"])):
                    selected = fit
        if selected is None:
            hall["reason_code"] = "no_stationary_window" if motion_exists else "no_motion"
        else:
            hall.update(
                {
                    "v_parallel_m_per_s": selected["velocity"][0],
                    "v_perp_m_per_s": selected["velocity"][1],
                    "angle_rad": selected["angle_rad"],
                    "angle_deg": math.degrees(selected["angle_rad"]),
                    "angle_variance_rad2": selected["angle_variance_rad2"],
                    "velocity_covariance_m2_per_s2": selected["velocity_covariance"],
                    "residuals_m": selected["residuals"],
                    "accepted_interval": {"start_index": selected["start_index"], "end_index": selected["end_index"], "sample_count": selected["end_index"] - selected["start_index"] + 1},
                    "mean_signed_current_a_per_m2": selected["mean_current"],
                    "reduced_chi_square": selected["reduced_chi_square"],
                    "directional_coherence": selected["directional_coherence"],
                }
            )
    return hall


def build_hall_artifact(stage_dir: str | Path) -> dict[str, Any]:
    stage = Path(stage_dir)
    if not stage.is_dir():
        raise HallBuildError(f"stage directory does not exist: {stage}")
    metadata = _json(stage / "metadata.json", "stage metadata")
    graph = _json(stage / "physics/physics_graph_provenance.v1.json", "physics graph provenance")
    grid, counts, cell, origin, plane_values, membership_bytes = _read_grid(stage)
    times, field_values, source_files = _read_series(stage, counts)
    current = _current_density(metadata)
    plane = plane_values[0]
    trajectories: list[dict[str, Any]] = []
    for time_s, values in zip(times, field_values):
        charge, centre_x, centre_y, edge_distance = _sample_geometry(values, counts, cell, origin, plane)
        trajectories.append(
            {
                "time_s": time_s,
                "centre": [centre_x, centre_y],
                "q": charge,
                "edge_distance_m": edge_distance,
                "current": current,
                "covariance": [[cell[0] * cell[0] / 12.0, 0.0], [0.0, cell[1] * cell[1] / 12.0]],
            }
        )
    provenance = _provenance(stage, grid, source_files, membership_bytes, metadata, graph)
    stage_id = provenance["stage_id"]
    source = {
        "magnetization_quantity_id": "m",
        "magnetization_series_id": f"{stage_id}:fields/m.zarr:{provenance['field_revision']}",
        "object_id": "fm",
        "geometry_id": "fm_geom",
        "grid_or_mesh_id": str(grid["grid_fingerprint"]),
        "support_id": f"fdm:magnetic_support:xy:z={plane}:{grid['grid_fingerprint']}",
        "topological_charge_method_version": TOPOLOGICAL_CHARGE_METHOD,
    }
    trajectory = {
        "time_s": [sample["time_s"] for sample in trajectories],
        "x_m": [sample["centre"][0] for sample in trajectories],
        "y_m": [sample["centre"][1] for sample in trajectories],
        "q": [sample["q"] for sample in trajectories],
        "edge_distance_m": [sample["edge_distance_m"] for sample in trajectories],
        "source": source,
        "provenance": provenance,
    }
    hall = _analyse(trajectories, trajectory)
    hall["provenance"] = None if hall["reason_code"] is not None else provenance
    artifact = {
        "schema_version": "skyrmion_hall_angle.v1",
        "algorithm_version": "weighted_gls.v1",
        "trajectory": trajectory,
        "hall_angle": hall,
        "producer": {
            "name": "build_skyrmion_hall_artifact.py",
            "version": "fdm_zarr_berg_luescher.v1",
            "source_kind": "accepted_fdm_magnetization_zarr",
            "uncertainty_model": UNCERTAINTY_MODEL,
            "uncertainty_calibration_status": "provisional_cell_quantization",
            "qualification_status": "analysis_only_until_managed_runtime_and_uncertainty_gate",
        },
    }
    try:
        validate_hall_artifact(artifact)
    except ValueError as error:
        raise HallBuildError(f"generated Hall artifact failed its validator: {error}") from error
    return artifact


def write_hall_artifact(stage_dir: str | Path, output: str | Path | None = None) -> Path:
    stage = Path(stage_dir)
    target = Path(output) if output is not None else stage / "analysis/skyrmion_hall_angle.v1.json"
    artifact = build_hall_artifact(stage)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".tmp")
    temporary.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(target)
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage_dir", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        target = write_hall_artifact(args.stage_dir, args.output)
    except (OSError, HallBuildError) as error:
        print(f"skyrmion Hall artifact rejected: {error}")
        return 1
    print(f"skyrmion Hall artifact written: {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
