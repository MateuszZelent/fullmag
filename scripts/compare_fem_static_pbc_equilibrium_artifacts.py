#!/usr/bin/env python3
"""Write strict-M5 static FEM PBC equilibrium comparison reports."""

from __future__ import annotations

import argparse
import csv
import json
import math
import struct
import sys
from pathlib import Path
from typing import Any


DEFAULT_MAX_E_DEMAG_RELERR = 2.0e-2
DEFAULT_MAX_H_DEMAG_P99_RELERR = 2.0e-2
DEFAULT_MAX_DEMAG_PHI_RANGE_RELERR = 2.0e-2
DEFAULT_MAX_SUPERCELL_DEMAG_PHI_DELTA_A = 1.0e-6
DEFAULT_MAX_AVERAGE_M_L2_DELTA = 2.0e-2
DEFAULT_MAX_TORQUE_RELERR = 2.0e-1
DEFAULT_MAX_RELAXATION_STATE_MEAN_DEVIATION_RELERR = 2.0e-1
DEFAULT_MAPPED_SUPERCELL_NEAREST_DISTANCE_M = 1.0e-8
DEFAULT_MAX_MAPPED_M_P99_L2_DELTA = 2.0e-2
DEFAULT_MAX_MAPPED_H_DEMAG_P99_RELERR = 2.0e-2
DEFAULT_MAX_MAPPED_DEMAG_PHI_DELTA_A = 1.0e-6
DEFAULT_MAX_MAPPED_SUPERCELL_NEAREST_DISTANCE_M = 1.0e-12
DEFAULT_INTERPOLATION_BARYCENTRIC_TOL = 1.0e-10


def fail(message: str) -> None:
    raise ValueError(message)


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def require_object(value: Any, name: str) -> dict[str, Any]:
    require(isinstance(value, dict), f"{name} must be a JSON object")
    return value


def require_list(value: Any, name: str) -> list[Any]:
    require(isinstance(value, list), f"{name} must be a JSON list")
    return value


def finite_number(value: Any, name: str) -> float:
    require(isinstance(value, (int, float)), f"{name} must be numeric")
    number = float(value)
    require(math.isfinite(number), f"{name} must be finite")
    return number


def relative_error(actual: float, expected: float) -> float:
    scale = max(abs(actual), abs(expected), 1.0e-300)
    return abs(actual - expected) / scale


def load_json(path: Path) -> dict[str, Any]:
    require(path.is_file(), f"missing JSON file: {path}")
    return require_object(json.loads(path.read_text(encoding="utf-8")), str(path))


def load_metadata(root: Path) -> dict[str, Any]:
    return load_json(root / "metadata.json")


def initial_magnetization_state_override(root: Path) -> dict[str, Any] | None:
    metadata = load_metadata(root)
    problem_meta = metadata.get("problem_meta")
    if not isinstance(problem_meta, dict):
        return None
    runtime_metadata = problem_meta.get("runtime_metadata")
    if not isinstance(runtime_metadata, dict):
        return None
    override = runtime_metadata.get("initial_magnetization_state_override")
    if not isinstance(override, dict):
        return None
    return override


def qualification(metadata: dict[str, Any]) -> dict[str, Any]:
    for key in ("fem_cpu_relaxation_qualification", "fem_gpu_relaxation_qualification"):
        value = metadata.get(key)
        if isinstance(value, dict):
            return value
    fail("metadata must contain fem_cpu_relaxation_qualification or fem_gpu_relaxation_qualification")


def final_energy_terms(metadata: dict[str, Any]) -> dict[str, Any]:
    return require_object(qualification(metadata).get("final_energy_terms_j"), "final_energy_terms_j")


def final_e_demag(root: Path) -> float:
    return finite_number(final_energy_terms(load_metadata(root)).get("E_demag"), f"{root}/E_demag")


def final_torque(root: Path) -> float:
    return finite_number(qualification(load_metadata(root)).get("final_torque_apm"), f"{root}/final_torque_apm")


def metadata_contract(root: Path) -> dict[str, Any]:
    metadata = load_metadata(root)
    pbc = require_object(metadata.get("pbc"), f"{root}/metadata.pbc")
    require(
        pbc.get("demag") == "periodic_airbox_k0",
        f"{root}/metadata.pbc.demag must be periodic_airbox_k0",
    )
    axes = require_list(pbc.get("axes"), f"{root}/metadata.pbc.axes")
    periodic = require_object(
        metadata.get("periodic_antidot_relaxation"),
        f"{root}/metadata.periodic_antidot_relaxation",
    )
    scenario = periodic.get("scenario")
    require(isinstance(scenario, str) and scenario, f"{root}/metadata.periodic_antidot_relaxation.scenario must be non-empty")
    film_size = require_list(periodic.get("film_size_m"), f"{root}/metadata.periodic_antidot_relaxation.film_size_m")
    require(len(film_size) == 3, f"{root}/metadata.periodic_antidot_relaxation.film_size_m must be a 3-vector")
    universe_size = require_list(
        periodic.get("universe_size_m"),
        f"{root}/metadata.periodic_antidot_relaxation.universe_size_m",
    )
    require(len(universe_size) == 3, f"{root}/metadata.periodic_antidot_relaxation.universe_size_m must be a 3-vector")
    lateral_air_gap = require_list(
        periodic.get("lateral_air_gap_m"),
        f"{root}/metadata.periodic_antidot_relaxation.lateral_air_gap_m",
    )
    require(
        len(lateral_air_gap) == 2,
        f"{root}/metadata.periodic_antidot_relaxation.lateral_air_gap_m must be a 2-vector",
    )
    periodic_pair_ids = [str(value) for value in require_list(
        periodic.get("periodic_pair_ids"),
        f"{root}/metadata.periodic_antidot_relaxation.periodic_pair_ids",
    )]
    require(periodic_pair_ids, f"{root}/metadata.periodic_antidot_relaxation.periodic_pair_ids must be non-empty")
    return {
        "axes": axes,
        "scenario": scenario,
        "film_size_m": [finite_number(value, f"{root}/film_size_m[{index}]") for index, value in enumerate(film_size)],
        "universe_size_m": [
            finite_number(value, f"{root}/universe_size_m[{index}]")
            for index, value in enumerate(universe_size)
        ],
        "lateral_air_gap_m": [
            finite_number(value, f"{root}/lateral_air_gap_m[{index}]")
            for index, value in enumerate(lateral_air_gap)
        ],
        "periodic_pair_ids": periodic_pair_ids,
        "exchange_coupled_across_periods": bool(periodic.get("exchange_coupled_across_periods")),
    }


def require_same_static_workload(left_root: Path, right_root: Path) -> dict[str, Any]:
    left = metadata_contract(left_root)
    right = metadata_contract(right_root)
    for key in (
        "axes",
        "scenario",
        "film_size_m",
        "lateral_air_gap_m",
        "periodic_pair_ids",
        "exchange_coupled_across_periods",
    ):
        require(left[key] == right[key], f"{key} must match for strict M5 comparison")
    return left


def require_z_padding_workload(reference_root: Path, candidate_root: Path) -> dict[str, Any]:
    reference = metadata_contract(reference_root)
    candidate = metadata_contract(candidate_root)
    for key in (
        "axes",
        "scenario",
        "film_size_m",
        "lateral_air_gap_m",
        "periodic_pair_ids",
        "exchange_coupled_across_periods",
    ):
        require(reference[key] == candidate[key], f"{key} must match for strict M5 comparison")
    require(
        reference["axes"] == ["periodic", "periodic", "open"],
        "z-padding comparison requires x/y periodic and open z axes",
    )
    reference_universe = reference["universe_size_m"]
    candidate_universe = candidate["universe_size_m"]
    require(
        reference_universe[:2] == candidate_universe[:2],
        "z-padding comparison requires matching lateral universe_size_m",
    )
    require(
        reference_universe[2] > candidate_universe[2],
        "z-padding comparison requires different open-z universe_size_m with reference thicker than candidate",
    )
    return {
        **candidate,
        "reference_universe_size_m": reference_universe,
        "candidate_universe_size_m": candidate_universe,
    }


def require_supercell_workload(
    unit_root: Path,
    supercell_root: Path,
    *,
    repeat_x: int,
    repeat_y: int,
) -> dict[str, Any]:
    unit = metadata_contract(unit_root)
    supercell = metadata_contract(supercell_root)
    for key in (
        "axes",
        "scenario",
        "film_size_m",
        "lateral_air_gap_m",
        "periodic_pair_ids",
        "exchange_coupled_across_periods",
    ):
        require(unit[key] == supercell[key], f"{key} must match for strict M5 comparison")
    require(
        unit["axes"] == ["periodic", "periodic", "open"],
        "supercell comparison requires x/y periodic and open z axes",
    )
    unit_universe = unit["universe_size_m"]
    supercell_universe = supercell["universe_size_m"]
    expected_supercell_universe = [
        unit_universe[0] * repeat_x,
        unit_universe[1] * repeat_y,
        unit_universe[2],
    ]
    require(
        all(
            math.isclose(actual, expected, rel_tol=1.0e-12, abs_tol=1.0e-18)
            for actual, expected in zip(supercell_universe, expected_supercell_universe)
        ),
        (
            "supercell comparison requires lateral universe_size_m scaled by "
            "repeat_x/repeat_y and matching open-z universe_size_m"
        ),
    )
    return {
        **unit,
        "unit_universe_size_m": unit_universe,
        "supercell_universe_size_m": supercell_universe,
        "expected_supercell_universe_size_m": expected_supercell_universe,
    }


def load_m_values(root: Path) -> list[list[float]]:
    data = load_json(root / "m_final.json")
    values = require_list(data.get("values"), "m_final.values")
    out: list[list[float]] = []
    for index, raw in enumerate(values):
        vector = require_list(raw, f"m_final.values[{index}]")
        require(len(vector) == 3, f"m_final.values[{index}] must be a 3-vector")
        out.append([finite_number(vector[i], f"m_final.values[{index}][{i}]") for i in range(3)])
    require(out, "m_final.values must be non-empty")
    return out


def average_m(root: Path) -> list[float]:
    values = load_m_values(root)
    return average_vectors(values, magnetic_node_indices(root, len(values)), "m_final.values")


def magnetic_node_indices(root: Path, node_count: int) -> list[int]:
    geometry_path = root / "mesh" / "node_geometry.v1.json"
    if not geometry_path.is_file():
        return metadata_magnetic_node_indices(root, node_count)
    geometry = load_json(geometry_path)
    mask = require_list(geometry.get("magnetic_node_mask"), "mesh/node_geometry.v1.json magnetic_node_mask")
    require(len(mask) == node_count, "mesh/node_geometry.v1.json magnetic_node_mask length must match m_final.values")
    indices: list[int] = []
    for index, value in enumerate(mask):
        require(isinstance(value, bool), f"mesh/node_geometry.v1.json magnetic_node_mask[{index}] must be boolean")
        if value:
            indices.append(index)
    require(indices, "mesh/node_geometry.v1.json magnetic_node_mask must select at least one magnetic node")
    return indices


def metadata_magnetic_node_indices(root: Path, node_count: int) -> list[int]:
    metadata_path = root / "metadata.json"
    if not metadata_path.is_file():
        return list(range(node_count))
    metadata = load_json(metadata_path)
    execution_plan = metadata.get("execution_plan")
    if not isinstance(execution_plan, dict):
        return list(range(node_count))
    backend_plan = execution_plan.get("backend_plan")
    if not isinstance(backend_plan, dict):
        return list(range(node_count))
    mesh = backend_plan.get("mesh")
    if not isinstance(mesh, dict):
        return list(range(node_count))
    nodes = require_list(mesh.get("nodes"), "metadata.execution_plan.backend_plan.mesh.nodes")
    require(len(nodes) == node_count, "metadata mesh node count must match m_final.values")
    elements = require_list(mesh.get("elements"), "metadata.execution_plan.backend_plan.mesh.elements")
    markers = mesh.get("element_markers")
    marker_values: list[int] = []
    if markers is not None:
        raw_markers = require_list(markers, "metadata.execution_plan.backend_plan.mesh.element_markers")
        require(len(raw_markers) == len(elements), "metadata mesh element_markers length must match elements")
        marker_values = [int(value) for value in raw_markers]
    has_mixed_airbox = bool(marker_values) and any(value == 0 for value in marker_values) and any(
        value != 0 for value in marker_values
    )
    magnetic: set[int] = set()
    for element_index, raw_element in enumerate(elements):
        if has_mixed_airbox and marker_values[element_index] == 0:
            continue
        element = require_list(raw_element, f"metadata.execution_plan.backend_plan.mesh.elements[{element_index}]")
        require(len(element) == 4, f"metadata mesh element {element_index} must be a tetrahedron")
        for raw_node in element:
            require(isinstance(raw_node, int), f"metadata mesh element {element_index} node index must be integer")
            require(0 <= raw_node < node_count, f"metadata mesh element {element_index} node index out of range")
            magnetic.add(raw_node)
    require(magnetic, "metadata mesh magnetic node selection must not be empty")
    return sorted(magnetic)


def metadata_mesh(root: Path) -> tuple[list[list[float]], list[list[int]], list[int] | None]:
    metadata = load_metadata(root)
    execution_plan = require_object(metadata.get("execution_plan"), "metadata.execution_plan")
    backend_plan = require_object(
        execution_plan.get("backend_plan"),
        "metadata.execution_plan.backend_plan",
    )
    mesh = require_object(backend_plan.get("mesh"), "metadata.execution_plan.backend_plan.mesh")
    raw_nodes = require_list(mesh.get("nodes"), "metadata.execution_plan.backend_plan.mesh.nodes")
    nodes: list[list[float]] = []
    for index, raw in enumerate(raw_nodes):
        node = require_list(raw, f"metadata.execution_plan.backend_plan.mesh.nodes[{index}]")
        require(len(node) == 3, f"metadata mesh node {index} must be a 3-vector")
        nodes.append([finite_number(node[axis], f"metadata mesh node {index}[{axis}]") for axis in range(3)])
    raw_elements = require_list(mesh.get("elements"), "metadata.execution_plan.backend_plan.mesh.elements")
    elements: list[list[int]] = []
    for element_index, raw_element in enumerate(raw_elements):
        element = require_list(raw_element, f"metadata mesh element {element_index}")
        require(len(element) == 4, f"metadata mesh element {element_index} must be a tetrahedron")
        parsed: list[int] = []
        for local_index, raw_node in enumerate(element):
            require(isinstance(raw_node, int), f"metadata mesh element {element_index}[{local_index}] must be integer")
            require(0 <= raw_node < len(nodes), f"metadata mesh element {element_index}[{local_index}] out of node range")
            parsed.append(raw_node)
        elements.append(parsed)
    markers = None
    raw_markers = mesh.get("element_markers")
    if raw_markers is not None:
        marker_values = require_list(raw_markers, "metadata.execution_plan.backend_plan.mesh.element_markers")
        require(len(marker_values) == len(elements), "metadata mesh element_markers length must match elements")
        markers = []
        for index, marker in enumerate(marker_values):
            require(isinstance(marker, int), f"metadata mesh element_markers[{index}] must be integer")
            markers.append(marker)
    return nodes, elements, markers


def average_vectors(values: list[list[float]], indices: list[int], name: str) -> list[float]:
    require(indices, f"{name} index list must be non-empty")
    inv = 1.0 / float(len(indices))
    return [
        sum(values[index][component] for index in indices) * inv
        for component in range(3)
    ]


def l2_delta(a: list[float], b: list[float]) -> float:
    require(len(a) == len(b), "vectors must have the same length")
    return math.sqrt(sum((ai - bi) ** 2 for ai, bi in zip(a, b)))


def det3(a: list[float], b: list[float], c: list[float]) -> float:
    return (
        a[0] * (b[1] * c[2] - b[2] * c[1])
        - a[1] * (b[0] * c[2] - b[2] * c[0])
        + a[2] * (b[0] * c[1] - b[1] * c[0])
    )


def vec_sub(a: list[float], b: list[float]) -> list[float]:
    return [ai - bi for ai, bi in zip(a, b)]


def barycentric_weights(
    point: list[float],
    tetra: list[list[float]],
    *,
    tolerance: float,
) -> list[float] | None:
    p0, p1, p2, p3 = tetra
    e1 = vec_sub(p1, p0)
    e2 = vec_sub(p2, p0)
    e3 = vec_sub(p3, p0)
    rhs = vec_sub(point, p0)
    det = det3(e1, e2, e3)
    if abs(det) <= 1.0e-300:
        return None
    u = det3(rhs, e2, e3) / det
    v = det3(e1, rhs, e3) / det
    w = det3(e1, e2, rhs) / det
    weights = [1.0 - u - v - w, u, v, w]
    if min(weights) < -tolerance or max(weights) > 1.0 + tolerance:
        return None
    return weights


def interpolate_vector(values: list[list[float]], element: list[int], weights: list[float]) -> list[float]:
    return [
        sum(weights[local] * values[node_index][component] for local, node_index in enumerate(element))
        for component in range(3)
    ]


def interpolate_scalar(values: list[float], element: list[int], weights: list[float]) -> float:
    return sum(weights[local] * values[node_index] for local, node_index in enumerate(element))


def element_index_filter(markers: list[int] | None, *, magnetic_only: bool) -> list[int] | None:
    if not magnetic_only or markers is None:
        return None
    has_mixed_airbox = any(marker == 0 for marker in markers) and any(marker != 0 for marker in markers)
    if not has_mixed_airbox:
        return None
    return [index for index, marker in enumerate(markers) if marker != 0]


def containing_tetra(
    point: list[float],
    *,
    nodes: list[list[float]],
    elements: list[list[int]],
    candidate_element_indices: list[int] | None,
    spatial_index: dict[tuple[int, int, int], list[int]] | None = None,
    spatial_cell_size: float | None = None,
    tolerance: float,
) -> tuple[list[int], list[float], float] | None:
    if spatial_index is not None and spatial_cell_size is not None:
        spatial_candidates = element_candidates_from_spatial_index(
            point,
            spatial_index=spatial_index,
            cell_size=spatial_cell_size,
        )
        indices = spatial_candidates if spatial_candidates else (
            candidate_element_indices if candidate_element_indices is not None else range(len(elements))
        )
    else:
        indices = candidate_element_indices if candidate_element_indices is not None else range(len(elements))
    best: tuple[list[int], list[float], float] | None = None
    for element_index in indices:
        element = elements[element_index]
        tetra = [nodes[node_index] for node_index in element]
        weights = barycentric_weights(point, tetra, tolerance=tolerance)
        if weights is None:
            continue
        min_weight = min(weights)
        if best is None or min_weight > best[2]:
            best = (element, weights, min_weight)
    return best


def percentile(values: list[float], q: float) -> float:
    require(values, "percentile values must be non-empty")
    require(0.0 <= q <= 1.0, "percentile q must be in [0, 1]")
    ordered = sorted(values)
    index = min(len(ordered) - 1, int(q * (len(ordered) - 1)))
    return ordered[index]


def vector_deviation_stats(
    values: list[list[float]],
    indices: list[int],
    reference: list[float],
    name: str,
) -> dict[str, float]:
    require(indices, f"{name} index list must be non-empty")
    deviations = [l2_delta(values[index], reference) for index in indices]
    return {
        "mean_l2": sum(deviations) / float(len(deviations)),
        "max_l2": max(deviations),
    }


def load_node_geometry_nodes(root: Path, *, expected_count: int) -> list[list[float]]:
    geometry_path = root / "mesh" / "node_geometry.v1.json"
    if geometry_path.is_file():
        geometry = load_json(geometry_path)
        nodes = require_list(geometry.get("nodes_m"), "mesh/node_geometry.v1.json nodes_m")
    else:
        metadata = load_metadata(root)
        execution_plan = require_object(metadata.get("execution_plan"), "metadata.execution_plan")
        backend_plan = require_object(
            execution_plan.get("backend_plan"),
            "metadata.execution_plan.backend_plan",
        )
        mesh = require_object(backend_plan.get("mesh"), "metadata.execution_plan.backend_plan.mesh")
        nodes = require_list(mesh.get("nodes"), "metadata.execution_plan.backend_plan.mesh.nodes")
    require(
        len(nodes) == expected_count,
        "node coordinate length must match field length",
    )
    parsed: list[list[float]] = []
    for index, raw in enumerate(nodes):
        node = require_list(raw, f"mesh/node_geometry.v1.json nodes_m[{index}]")
        require(len(node) == 3, f"mesh/node_geometry.v1.json nodes_m[{index}] must be a 3-vector")
        parsed.append(
            [
                finite_number(node[axis], f"mesh/node_geometry.v1.json nodes_m[{index}][{axis}]")
                for axis in range(3)
            ]
        )
    return parsed


def reduce_periodic_coordinate(value: float, period: float) -> float:
    return ((value + 0.5 * period) % period) - 0.5 * period


def spatial_key(point: list[float], cell_size: float) -> tuple[int, int, int]:
    return (
        math.floor(point[0] / cell_size),
        math.floor(point[1] / cell_size),
        math.floor(point[2] / cell_size),
    )


def element_bbox(nodes: list[list[float]], element: list[int]) -> tuple[list[float], list[float]]:
    points = [nodes[node_index] for node_index in element]
    return (
        [min(point[axis] for point in points) for axis in range(3)],
        [max(point[axis] for point in points) for axis in range(3)],
    )


def estimate_element_cell_size(nodes: list[list[float]], elements: list[list[int]]) -> float:
    mins = [min(node[axis] for node in nodes) for axis in range(3)]
    maxs = [max(node[axis] for node in nodes) for axis in range(3)]
    spans = [maxs[axis] - mins[axis] for axis in range(3)]
    positive_spans = [span for span in spans if span > 0.0]
    if not positive_spans:
        return 1.0
    volume = 1.0
    for span in positive_spans:
        volume *= span
    characteristic = (volume / float(max(len(elements), 1))) ** (1.0 / float(len(positive_spans)))
    return max(characteristic * 4.0, max(positive_spans) * 1.0e-6, 1.0e-15)


def build_element_spatial_index(
    *,
    nodes: list[list[float]],
    elements: list[list[int]],
    candidate_element_indices: list[int] | None,
    cell_size: float,
    tolerance: float,
) -> dict[tuple[int, int, int], list[int]]:
    indices = candidate_element_indices if candidate_element_indices is not None else range(len(elements))
    index: dict[tuple[int, int, int], list[int]] = {}
    for element_index in indices:
        bbox_min, bbox_max = element_bbox(nodes, elements[element_index])
        min_key = spatial_key([bbox_min[axis] - tolerance for axis in range(3)], cell_size)
        max_key = spatial_key([bbox_max[axis] + tolerance for axis in range(3)], cell_size)
        for ix in range(min_key[0], max_key[0] + 1):
            for iy in range(min_key[1], max_key[1] + 1):
                for iz in range(min_key[2], max_key[2] + 1):
                    index.setdefault((ix, iy, iz), []).append(element_index)
    return index


def element_candidates_from_spatial_index(
    point: list[float],
    *,
    spatial_index: dict[tuple[int, int, int], list[int]],
    cell_size: float,
) -> list[int]:
    base_key = spatial_key(point, cell_size)
    seen: set[int] = set()
    candidates: list[int] = []
    for radius in (0, 1, 2):
        for dx in range(-radius, radius + 1):
            for dy in range(-radius, radius + 1):
                for dz in range(-radius, radius + 1):
                    key = (base_key[0] + dx, base_key[1] + dy, base_key[2] + dz)
                    for element_index in spatial_index.get(key, []):
                        if element_index in seen:
                            continue
                        seen.add(element_index)
                        candidates.append(element_index)
        if candidates:
            return candidates
    return candidates


def build_spatial_index(
    nodes: list[list[float]],
    indices: list[int],
    *,
    cell_size: float,
) -> dict[tuple[int, int, int], list[int]]:
    index: dict[tuple[int, int, int], list[int]] = {}
    for node_index in indices:
        index.setdefault(spatial_key(nodes[node_index], cell_size), []).append(node_index)
    return index


def nearest_periodic_unit_node(
    point: list[float],
    *,
    unit_nodes: list[list[float]],
    candidate_indices: list[int],
    unit_periods: list[float],
    spatial_index: dict[tuple[int, int, int], list[int]],
    cell_size: float,
) -> tuple[int, float]:
    reduced = [
        reduce_periodic_coordinate(point[0], unit_periods[0]),
        reduce_periodic_coordinate(point[1], unit_periods[1]),
        point[2],
    ]
    base_key = spatial_key(reduced, cell_size)
    best_index = -1
    best_distance2 = math.inf
    for radius in (1, 2, 4):
        for dx in range(-radius, radius + 1):
            for dy in range(-radius, radius + 1):
                for dz in range(-radius, radius + 1):
                    key = (base_key[0] + dx, base_key[1] + dy, base_key[2] + dz)
                    for candidate in spatial_index.get(key, []):
                        node = unit_nodes[candidate]
                        distance2 = sum((reduced[axis] - node[axis]) ** 2 for axis in range(3))
                        if distance2 < best_distance2:
                            best_index = candidate
                            best_distance2 = distance2
        if best_index >= 0:
            return best_index, math.sqrt(best_distance2)
    for candidate in candidate_indices:
        node = unit_nodes[candidate]
        distance2 = sum((reduced[axis] - node[axis]) ** 2 for axis in range(3))
        if distance2 < best_distance2:
            best_index = candidate
            best_distance2 = distance2
    require(best_index >= 0, "nearest-node mapping requires at least one candidate unit node")
    return best_index, math.sqrt(best_distance2)


def zarr_vectors(root: Path, observable: str) -> list[list[float]]:
    components, values = load_zarr_values(root, observable)
    require(components == ["x", "y", "z"], f"{observable} component_order must be x/y/z")
    cell_count = len(values) // 3
    return [
        [values[index], values[cell_count + index], values[2 * cell_count + index]]
        for index in range(cell_count)
    ]


def zarr_scalars(root: Path, observable: str) -> list[float]:
    components, values = load_zarr_values(root, observable)
    require(components == ["scalar"], f"{observable} component_order must be scalar")
    return values


def mapped_pair_indices(
    *,
    unit_nodes: list[list[float]],
    supercell_nodes: list[list[float]],
    supercell_indices: list[int],
    unit_candidate_indices: list[int],
    unit_periods: list[float],
) -> tuple[list[tuple[int, int]], list[float]]:
    cell_size = max(DEFAULT_MAPPED_SUPERCELL_NEAREST_DISTANCE_M, 1.0e-15)
    spatial_index = build_spatial_index(unit_nodes, unit_candidate_indices, cell_size=cell_size)
    pairs: list[tuple[int, int]] = []
    distances: list[float] = []
    for supercell_index in supercell_indices:
        unit_index, distance = nearest_periodic_unit_node(
            supercell_nodes[supercell_index],
            unit_nodes=unit_nodes,
            candidate_indices=unit_candidate_indices,
            unit_periods=unit_periods,
            spatial_index=spatial_index,
            cell_size=cell_size,
        )
        pairs.append((unit_index, supercell_index))
        distances.append(distance)
    return pairs, distances


def vector_pair_delta_stats(
    *,
    unit_values: list[list[float]],
    supercell_values: list[list[float]],
    pairs: list[tuple[int, int]],
) -> dict[str, float]:
    zero = [0.0, 0.0, 0.0]
    deltas = [
        l2_delta(supercell_values[supercell_index], unit_values[unit_index])
        for unit_index, supercell_index in pairs
    ]
    unit_norms = [l2_delta(unit_values[unit_index], zero) for unit_index, _ in pairs]
    supercell_norms = [l2_delta(supercell_values[supercell_index], zero) for _, supercell_index in pairs]
    scale = max(percentile(unit_norms, 0.99), percentile(supercell_norms, 0.99), 1.0e-300)
    return {
        "mean_l2_delta": sum(deltas) / float(len(deltas)),
        "p99_l2_delta": percentile(deltas, 0.99),
        "max_l2_delta": max(deltas),
        "p99_relative_error": percentile(deltas, 0.99) / scale,
    }


def scalar_pair_delta_stats_with_offset(
    *,
    unit_values: list[float],
    supercell_values: list[float],
    pairs: list[tuple[int, int]],
) -> dict[str, float]:
    offsets = [
        supercell_values[supercell_index] - unit_values[unit_index]
        for unit_index, supercell_index in pairs
    ]
    best_offset = sum(offsets) / float(len(offsets))
    residuals = [abs(offset - best_offset) for offset in offsets]
    return {
        "best_constant_offset_A": best_offset,
        "mean_abs_delta_after_offset_A": sum(residuals) / float(len(residuals)),
        "p99_abs_delta_after_offset_A": percentile(residuals, 0.99),
        "max_abs_delta_after_offset_A": max(residuals),
    }


def vector_interpolated_delta_stats(
    *,
    reference_values: list[list[float]],
    sample_values: list[list[float]],
) -> dict[str, float]:
    zero = [0.0, 0.0, 0.0]
    deltas = [l2_delta(sample, reference) for sample, reference in zip(sample_values, reference_values)]
    reference_norms = [l2_delta(value, zero) for value in reference_values]
    sample_norms = [l2_delta(value, zero) for value in sample_values]
    scale = max(percentile(reference_norms, 0.99), percentile(sample_norms, 0.99), 1.0e-300)
    return {
        "mean_l2_delta": sum(deltas) / float(len(deltas)),
        "p99_l2_delta": percentile(deltas, 0.99),
        "max_l2_delta": max(deltas),
        "p99_relative_error": percentile(deltas, 0.99) / scale,
    }


def scalar_interpolated_delta_stats_with_offset(
    *,
    reference_values: list[float],
    sample_values: list[float],
) -> dict[str, float]:
    offsets = [sample - reference for sample, reference in zip(sample_values, reference_values)]
    best_offset = sum(offsets) / float(len(offsets))
    residuals = [abs(offset - best_offset) for offset in offsets]
    return {
        "best_constant_offset_A": best_offset,
        "mean_abs_delta_after_offset_A": sum(residuals) / float(len(residuals)),
        "p99_abs_delta_after_offset_A": percentile(residuals, 0.99),
        "max_abs_delta_after_offset_A": max(residuals),
    }


def load_zarr_values(root: Path, observable: str) -> tuple[list[str], list[float]]:
    field_dir = root / "fields" / f"{observable}.zarr"
    require(field_dir.is_dir(), f"missing {observable} zarr directory: {field_dir}")
    attrs = load_json(field_dir / ".zattrs")
    array = load_json(field_dir / ".zarray")
    component_order = require_list(attrs.get("component_order"), f"{observable}.component_order")
    component_names = [str(component) for component in component_order]
    require(array.get("dtype") == "<f8", f"{observable} zarr dtype must be <f8")
    require(array.get("order") == "C", f"{observable} zarr order must be C")
    shape = require_list(array.get("shape"), f"{observable}.shape")
    require(len(shape) == 3 and shape[0] == 1, f"{observable}.shape must be [1, components, cells]")
    component_count = int(shape[1])
    cell_count = int(shape[2])
    require(component_count == len(component_names), f"{observable}.shape/component_order mismatch")
    require(component_count > 0 and cell_count > 0, f"{observable} zarr dimensions must be positive")
    with (field_dir / "samples.csv").open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    require(rows, f"{observable} samples.csv must not be empty")
    chunk_key = rows[-1].get("chunk_key")
    require(isinstance(chunk_key, str) and chunk_key, f"{observable} chunk_key must be present")
    raw = (field_dir / chunk_key).read_bytes()
    expected = component_count * cell_count
    require(len(raw) == expected * 8, f"{observable} chunk byte length mismatch")
    values = list(struct.unpack(f"<{expected}d", raw))
    return component_names, values


def require_index_list(value: Any, name: str, upper_bound: int) -> list[int]:
    raw_values = require_list(value, name)
    require(raw_values, f"{name} must be non-empty")
    indices: list[int] = []
    seen: set[int] = set()
    for position, raw in enumerate(raw_values):
        require(isinstance(raw, int), f"{name}[{position}] must be an integer")
        require(0 <= raw < upper_bound, f"{name}[{position}] must be in [0, {upper_bound})")
        require(raw not in seen, f"{name}[{position}] duplicates index {raw}")
        seen.add(raw)
        indices.append(raw)
    return indices


def h_demag_max_norm_from_indices(root: Path, indices: list[int]) -> float:
    components, values = load_zarr_values(root, "H_demag")
    require(components == ["x", "y", "z"], "H_demag component_order must be x/y/z")
    cell_count = len(values) // 3
    bounded_indices = require_index_list(indices, "central-cell field_cell_indices", cell_count)
    return max(
        math.sqrt(values[i] ** 2 + values[cell_count + i] ** 2 + values[2 * cell_count + i] ** 2)
        for i in bounded_indices
    )


def h_demag_max_norm(root: Path) -> float:
    components, values = load_zarr_values(root, "H_demag")
    require(components == ["x", "y", "z"], "H_demag component_order must be x/y/z")
    cell_count = len(values) // 3
    return h_demag_max_norm_from_indices(root, list(range(cell_count)))


def h_demag_cell_count(root: Path) -> int:
    components, values = load_zarr_values(root, "H_demag")
    require(components == ["x", "y", "z"], "H_demag component_order must be x/y/z")
    return len(values) // 3


def h_demag_norm_percentile(root: Path, percentile: float) -> float:
    require(0.0 <= percentile <= 1.0, "H_demag percentile must be in [0, 1]")
    components, values = load_zarr_values(root, "H_demag")
    require(components == ["x", "y", "z"], "H_demag component_order must be x/y/z")
    cell_count = len(values) // 3
    norms = sorted(
        math.sqrt(values[i] ** 2 + values[cell_count + i] ** 2 + values[2 * cell_count + i] ** 2)
        for i in range(cell_count)
    )
    require(norms, "H_demag norms must be non-empty")
    index = min(len(norms) - 1, int(percentile * (len(norms) - 1)))
    return norms[index]


def demag_phi_range_from_indices(root: Path, indices: list[int]) -> float:
    components, values = load_zarr_values(root, "demag_phi")
    require(components == ["scalar"], "demag_phi component_order must be scalar")
    bounded_indices = require_index_list(indices, "central-cell field_cell_indices", len(values))
    selected = [values[index] for index in bounded_indices]
    return max(selected) - min(selected)


def demag_phi_range(root: Path) -> float:
    components, values = load_zarr_values(root, "demag_phi")
    require(components == ["scalar"], "demag_phi component_order must be scalar")
    return max(values) - min(values)


def write_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def require_different_roots(left: Path, right: Path, message: str) -> None:
    require(left.resolve() != right.resolve(), message)


def load_supercell_central_cell_extraction(
    root: Path,
    *,
    repeat_x: int,
    repeat_y: int,
) -> dict[str, Any]:
    path = root / "diagnostics" / "fem_static_pbc_supercell_central_cell.v1.json"
    require(path.is_file(), f"missing supercell central-cell extraction artifact: {path}")
    payload = load_json(path)
    require(
        payload.get("schema_version") == "fem_static_pbc_supercell_central_cell.v1",
        (
            "supercell central-cell extraction schema_version must be "
            f"fem_static_pbc_supercell_central_cell.v1, got {payload.get('schema_version')!r}"
        ),
    )
    require(payload.get("repeat_x") == repeat_x, "supercell central-cell extraction repeat_x must match report repeat_x")
    require(payload.get("repeat_y") == repeat_y, "supercell central-cell extraction repeat_y must match report repeat_y")
    require(
        payload.get("cell_count") == repeat_x * repeat_y,
        "supercell central-cell extraction cell_count must equal repeat_x * repeat_y",
    )
    central_index = require_list(payload.get("central_cell_index"), "supercell central-cell extraction central_cell_index")
    require(len(central_index) == 2, "supercell central-cell extraction central_cell_index must be a 2-vector")
    for axis, (value, repeat) in enumerate(zip(central_index, [repeat_x, repeat_y])):
        require(isinstance(value, int), f"supercell central-cell extraction central_cell_index[{axis}] must be an integer")
        require(0 <= value < repeat, f"supercell central-cell extraction central_cell_index[{axis}] must be in [0, {repeat})")
    energy = finite_number(
        payload.get("central_cell_demag_energy_j"),
        "supercell central-cell extraction central_cell_demag_energy_j",
    )
    torque = finite_number(
        payload.get("central_cell_torque_apm"),
        "supercell central-cell extraction central_cell_torque_apm",
    )
    require(energy >= 0.0, "supercell central-cell extraction central_cell_demag_energy_j must be non-negative")
    require(torque >= 0.0, "supercell central-cell extraction central_cell_torque_apm must be non-negative")
    m_values = load_m_values(root)
    _, h_values = load_zarr_values(root, "H_demag")
    _, phi_values = load_zarr_values(root, "demag_phi")
    magnetic_indices = require_index_list(
        payload.get("magnetic_node_indices"),
        "supercell central-cell extraction magnetic_node_indices",
        len(m_values),
    )
    field_indices = require_index_list(
        payload.get("field_cell_indices"),
        "supercell central-cell extraction field_cell_indices",
        min(len(h_values) // 3, len(phi_values)),
    )
    return {
        "schema_version": payload["schema_version"],
        "path": str(path),
        "repeat_x": repeat_x,
        "repeat_y": repeat_y,
        "cell_count": repeat_x * repeat_y,
        "central_cell_index": central_index,
        "magnetic_node_count": len(magnetic_indices),
        "field_cell_count": len(field_indices),
        "magnetic_node_indices": magnetic_indices,
        "field_cell_indices": field_indices,
        "central_cell_demag_energy_j": energy,
        "central_cell_torque_apm": torque,
    }


def mapped_central_cell_comparability(
    unit_root: Path,
    supercell_root: Path,
    *,
    extraction: dict[str, Any],
    workload: dict[str, Any],
    unit_m_values: list[list[float]],
    unit_magnetic_indices: list[int],
    supercell_m_values: list[list[float]],
    same_local_distance_limit_m: float,
) -> dict[str, Any]:
    unit_nodes = load_node_geometry_nodes(unit_root, expected_count=len(unit_m_values))
    supercell_nodes = load_node_geometry_nodes(supercell_root, expected_count=len(supercell_m_values))
    raw_periods = require_list(workload.get("unit_universe_size_m"), "workload.unit_universe_size_m")
    unit_periods = [
        finite_number(value, f"workload.unit_universe_size_m[{index}]")
        for index, value in enumerate(raw_periods)
    ]
    magnetic_pairs, magnetic_distances = mapped_pair_indices(
        unit_nodes=unit_nodes,
        supercell_nodes=supercell_nodes,
        supercell_indices=extraction["magnetic_node_indices"],
        unit_candidate_indices=unit_magnetic_indices,
        unit_periods=unit_periods,
    )
    field_pairs, field_distances = mapped_pair_indices(
        unit_nodes=unit_nodes,
        supercell_nodes=supercell_nodes,
        supercell_indices=extraction["field_cell_indices"],
        unit_candidate_indices=list(range(len(unit_nodes))),
        unit_periods=unit_periods,
    )
    max_magnetic_distance = max(magnetic_distances)
    max_field_distance = max(field_distances)
    same_local = (
        max_magnetic_distance <= same_local_distance_limit_m
        and max_field_distance <= same_local_distance_limit_m
    )
    return {
        "schema_version": "fem_static_pbc_supercell_mapped_comparison.v1",
        "mapping": "supercell central-cell node -> modulo(x/y) nearest primitive-cell node",
        "same_local_discretization": same_local,
        "same_local_discretization_limit_m": same_local_distance_limit_m,
        "magnetic_pair_count": len(magnetic_pairs),
        "field_pair_count": len(field_pairs),
        "max_nearest_magnetic_node_distance_m": max_magnetic_distance,
        "mean_nearest_magnetic_node_distance_m": sum(magnetic_distances) / float(len(magnetic_distances)),
        "max_nearest_field_node_distance_m": max_field_distance,
        "mean_nearest_field_node_distance_m": sum(field_distances) / float(len(field_distances)),
        "m": vector_pair_delta_stats(
            unit_values=unit_m_values,
            supercell_values=supercell_m_values,
            pairs=magnetic_pairs,
        ),
        "H_demag": vector_pair_delta_stats(
            unit_values=zarr_vectors(unit_root, "H_demag"),
            supercell_values=zarr_vectors(supercell_root, "H_demag"),
            pairs=field_pairs,
        ),
        "demag_phi": scalar_pair_delta_stats_with_offset(
            unit_values=zarr_scalars(unit_root, "demag_phi"),
            supercell_values=zarr_scalars(supercell_root, "demag_phi"),
            pairs=field_pairs,
        ),
    }


def interpolated_central_cell_comparability(
    unit_root: Path,
    supercell_root: Path,
    *,
    extraction: dict[str, Any],
    workload: dict[str, Any],
    unit_m_values: list[list[float]],
    supercell_m_values: list[list[float]],
    barycentric_tolerance: float,
) -> dict[str, Any]:
    unit_nodes, unit_elements, unit_markers = metadata_mesh(unit_root)
    require(len(unit_nodes) == len(unit_m_values), "unit metadata mesh node count must match m_final.values")
    supercell_nodes = load_node_geometry_nodes(supercell_root, expected_count=len(supercell_m_values))
    raw_periods = require_list(workload.get("unit_universe_size_m"), "workload.unit_universe_size_m")
    unit_periods = [
        finite_number(value, f"workload.unit_universe_size_m[{index}]")
        for index, value in enumerate(raw_periods)
    ]
    unit_h = zarr_vectors(unit_root, "H_demag")
    unit_phi = zarr_scalars(unit_root, "demag_phi")
    require(len(unit_h) == len(unit_nodes), "unit H_demag node count must match metadata mesh nodes")
    require(len(unit_phi) == len(unit_nodes), "unit demag_phi node count must match metadata mesh nodes")
    supercell_h = zarr_vectors(supercell_root, "H_demag")
    supercell_phi = zarr_scalars(supercell_root, "demag_phi")

    magnetic_element_indices = element_index_filter(unit_markers, magnetic_only=True)
    spatial_cell_size = estimate_element_cell_size(unit_nodes, unit_elements)
    field_spatial_index = build_element_spatial_index(
        nodes=unit_nodes,
        elements=unit_elements,
        candidate_element_indices=None,
        cell_size=spatial_cell_size,
        tolerance=barycentric_tolerance,
    )
    magnetic_spatial_index = build_element_spatial_index(
        nodes=unit_nodes,
        elements=unit_elements,
        candidate_element_indices=magnetic_element_indices,
        cell_size=spatial_cell_size,
        tolerance=barycentric_tolerance,
    )
    field_sample_values: list[list[float]] = []
    field_reference_values: list[list[float]] = []
    phi_sample_values: list[float] = []
    phi_reference_values: list[float] = []
    magnetic_sample_values: list[list[float]] = []
    magnetic_reference_values: list[list[float]] = []
    min_barycentric_weight = math.inf
    missed_field = 0
    missed_magnetic = 0

    for supercell_index in extraction["field_cell_indices"]:
        reduced = [
            reduce_periodic_coordinate(supercell_nodes[supercell_index][0], unit_periods[0]),
            reduce_periodic_coordinate(supercell_nodes[supercell_index][1], unit_periods[1]),
            supercell_nodes[supercell_index][2],
        ]
        located = containing_tetra(
            reduced,
            nodes=unit_nodes,
            elements=unit_elements,
            candidate_element_indices=None,
            spatial_index=field_spatial_index,
            spatial_cell_size=spatial_cell_size,
            tolerance=barycentric_tolerance,
        )
        if located is None:
            missed_field += 1
            continue
        element, weights, min_weight = located
        min_barycentric_weight = min(min_barycentric_weight, min_weight)
        field_reference_values.append(interpolate_vector(unit_h, element, weights))
        field_sample_values.append(supercell_h[supercell_index])
        phi_reference_values.append(interpolate_scalar(unit_phi, element, weights))
        phi_sample_values.append(supercell_phi[supercell_index])

    for supercell_index in extraction["magnetic_node_indices"]:
        reduced = [
            reduce_periodic_coordinate(supercell_nodes[supercell_index][0], unit_periods[0]),
            reduce_periodic_coordinate(supercell_nodes[supercell_index][1], unit_periods[1]),
            supercell_nodes[supercell_index][2],
        ]
        located = containing_tetra(
            reduced,
            nodes=unit_nodes,
            elements=unit_elements,
            candidate_element_indices=magnetic_element_indices,
            spatial_index=magnetic_spatial_index,
            spatial_cell_size=spatial_cell_size,
            tolerance=barycentric_tolerance,
        )
        if located is None:
            missed_magnetic += 1
            continue
        element, weights, min_weight = located
        min_barycentric_weight = min(min_barycentric_weight, min_weight)
        magnetic_reference_values.append(interpolate_vector(unit_m_values, element, weights))
        magnetic_sample_values.append(supercell_m_values[supercell_index])

    field_count = int(extraction["field_cell_count"])
    magnetic_count = int(extraction["magnetic_node_count"])
    require(field_count > 0 and magnetic_count > 0, "interpolated comparison requires non-empty central-cell selections")
    require(field_sample_values, "interpolated comparison located no field samples in the primitive mesh")
    require(magnetic_sample_values, "interpolated comparison located no magnetic samples in the primitive mesh")
    if not math.isfinite(min_barycentric_weight):
        min_barycentric_weight = 0.0
    return {
        "schema_version": "fem_static_pbc_supercell_interpolated_comparison.v1",
        "mapping": "supercell central-cell node -> modulo(x/y) primitive tetrahedral linear interpolation",
        "interpolation_method": "linear_tetrahedral_barycentric",
        "barycentric_tolerance": barycentric_tolerance,
        "spatial_index_cell_size_m": spatial_cell_size,
        "field_sample_count": field_count,
        "field_located_count": len(field_sample_values),
        "field_missed_count": missed_field,
        "field_coverage_ratio": len(field_sample_values) / float(field_count),
        "magnetic_sample_count": magnetic_count,
        "magnetic_located_count": len(magnetic_sample_values),
        "magnetic_missed_count": missed_magnetic,
        "magnetic_coverage_ratio": len(magnetic_sample_values) / float(magnetic_count),
        "min_barycentric_weight": min_barycentric_weight,
        "m": vector_interpolated_delta_stats(
            reference_values=magnetic_reference_values,
            sample_values=magnetic_sample_values,
        ),
        "H_demag": vector_interpolated_delta_stats(
            reference_values=field_reference_values,
            sample_values=field_sample_values,
        ),
        "demag_phi": scalar_interpolated_delta_stats_with_offset(
            reference_values=phi_reference_values,
            sample_values=phi_sample_values,
        ),
    }


def status_from_limits(metrics: dict[str, float], limits: dict[str, float]) -> tuple[str, list[str]]:
    failures = [
        f"{name}={metrics[name]:.6e} exceeds {limit:.6e}"
        for name, limit in limits.items()
        if metrics[name] > limit
    ]
    return ("failed" if failures else "ok"), failures


def compare_z_padding(args: argparse.Namespace) -> dict[str, Any]:
    require_different_roots(
        args.reference,
        args.candidate,
        "reference and candidate artifact roots must be different",
    )
    workload = require_z_padding_workload(args.reference, args.candidate)
    candidate_h_max = h_demag_max_norm(args.candidate)
    reference_h_max = h_demag_max_norm(args.reference)
    candidate_h_p99 = h_demag_norm_percentile(args.candidate, 0.99)
    reference_h_p99 = h_demag_norm_percentile(args.reference, 0.99)
    candidate_phi_range = demag_phi_range(args.candidate)
    reference_phi_range = demag_phi_range(args.reference)
    metrics = {
        "e_demag_relative_error": relative_error(final_e_demag(args.candidate), final_e_demag(args.reference)),
        "h_demag_p99_relative_error": relative_error(candidate_h_p99, reference_h_p99),
        "demag_phi_range_relative_error": relative_error(candidate_phi_range, reference_phi_range),
        "h_demag_max_abs_delta_Apm": abs(candidate_h_max - reference_h_max),
        "h_demag_max_relative_error": relative_error(candidate_h_max, reference_h_max),
        "demag_phi_max_abs_delta_A": abs(candidate_phi_range - reference_phi_range),
    }
    limits = {
        "e_demag_relative_error": args.max_e_demag_relative_error,
        "h_demag_p99_relative_error": args.max_h_demag_p99_relative_error,
        "demag_phi_range_relative_error": args.max_demag_phi_range_relative_error,
    }
    status, failures = status_from_limits(metrics, limits)
    return {
        "schema_version": "fem_static_pbc_z_padding_validation.v1",
        "status": status,
        "reference_artifacts": str(args.reference),
        "candidate_artifacts": str(args.candidate),
        "metrics": metrics,
        "workload": workload,
        "thresholds": limits,
        "failure_reasons": failures,
    }


def compare_supercell(args: argparse.Namespace) -> dict[str, Any]:
    require_different_roots(
        args.unit_cell,
        args.supercell,
        "unit-cell and supercell artifact roots must be different",
    )
    workload = require_supercell_workload(
        args.unit_cell,
        args.supercell,
        repeat_x=args.repeat_x,
        repeat_y=args.repeat_y,
    )
    cell_count = args.repeat_x * args.repeat_y
    unit_e = final_e_demag(args.unit_cell)
    extraction = load_supercell_central_cell_extraction(
        args.supercell,
        repeat_x=args.repeat_x,
        repeat_y=args.repeat_y,
    )
    unit_m_values = load_m_values(args.unit_cell)
    unit_magnetic_indices = magnetic_node_indices(args.unit_cell, len(unit_m_values))
    unit_average_m = average_vectors(unit_m_values, unit_magnetic_indices, "m_final.values")
    supercell_m_values = load_m_values(args.supercell)
    supercell_average_m = average_vectors(
        supercell_m_values,
        extraction["magnetic_node_indices"],
        "m_final.values",
    )
    unit_field_cell_count = h_demag_cell_count(args.unit_cell)
    supercell_e_density = float(extraction["central_cell_demag_energy_j"])
    unit_h = h_demag_max_norm(args.unit_cell)
    supercell_h = h_demag_max_norm_from_indices(args.supercell, extraction["field_cell_indices"])
    unit_deviation = vector_deviation_stats(
        unit_m_values,
        unit_magnetic_indices,
        unit_average_m,
        "unit-cell m_final.values",
    )
    central_deviation = vector_deviation_stats(
        supercell_m_values,
        extraction["magnetic_node_indices"],
        unit_average_m,
        "supercell central-cell m_final.values",
    )
    relaxation_state = {
        "unit_average_m": unit_average_m,
        "central_cell_average_m": supercell_average_m,
        "central_cell_average_m_l2_delta": l2_delta(supercell_average_m, unit_average_m),
        "unit_mean_l2_deviation_from_unit_average_m": unit_deviation["mean_l2"],
        "unit_max_l2_deviation_from_unit_average_m": unit_deviation["max_l2"],
        "central_cell_mean_l2_deviation_from_unit_average_m": central_deviation["mean_l2"],
        "central_cell_max_l2_deviation_from_unit_average_m": central_deviation["max_l2"],
        "mean_l2_deviation_relative_error": relative_error(
            central_deviation["mean_l2"],
            unit_deviation["mean_l2"],
        ),
    }
    mapped_comparison = mapped_central_cell_comparability(
        args.unit_cell,
        args.supercell,
        extraction=extraction,
        workload=workload,
        unit_m_values=unit_m_values,
        unit_magnetic_indices=unit_magnetic_indices,
        supercell_m_values=supercell_m_values,
        same_local_distance_limit_m=args.max_mapped_nearest_distance_m,
    )
    interpolated_comparison = None
    if args.include_interpolated_comparison:
        interpolated_comparison = interpolated_central_cell_comparability(
            args.unit_cell,
            args.supercell,
            extraction=extraction,
            workload=workload,
            unit_m_values=unit_m_values,
            supercell_m_values=supercell_m_values,
            barycentric_tolerance=args.interpolation_barycentric_tolerance,
        )
    mesh_comparability = {
        "unit_magnetic_node_count": len(unit_magnetic_indices),
        "central_cell_magnetic_node_count": int(extraction["magnetic_node_count"]),
        "magnetic_node_count_relative_error": relative_error(
            float(extraction["magnetic_node_count"]),
            float(len(unit_magnetic_indices)),
        ),
        "unit_field_cell_count": unit_field_cell_count,
        "central_cell_field_cell_count": int(extraction["field_cell_count"]),
        "field_cell_count_relative_error": relative_error(
            float(extraction["field_cell_count"]),
            float(unit_field_cell_count),
        ),
    }
    metrics = {
        "average_m_l2_delta": relaxation_state["central_cell_average_m_l2_delta"],
        "e_demag_density_relative_error": relative_error(supercell_e_density, unit_e),
        "h_demag_stats_relative_error": relative_error(supercell_h, unit_h),
        "demag_phi_max_abs_delta_A": abs(
            demag_phi_range_from_indices(args.supercell, extraction["field_cell_indices"])
            - demag_phi_range(args.unit_cell)
        ),
        "central_cell_torque_residual_relative_error": relative_error(
            float(extraction["central_cell_torque_apm"]),
            final_torque(args.unit_cell),
        ),
        "relaxation_state_mean_deviation_relative_error": relaxation_state["mean_l2_deviation_relative_error"],
        "mapped_m_p99_l2_delta": mapped_comparison["m"]["p99_l2_delta"],
        "mapped_h_demag_p99_relative_error": mapped_comparison["H_demag"]["p99_relative_error"],
        "mapped_demag_phi_max_abs_delta_after_offset_A": mapped_comparison["demag_phi"][
            "max_abs_delta_after_offset_A"
        ],
        "mapped_max_nearest_field_node_distance_m": mapped_comparison["max_nearest_field_node_distance_m"],
        "mapped_max_nearest_magnetic_node_distance_m": mapped_comparison[
            "max_nearest_magnetic_node_distance_m"
        ],
        "magnetic_node_count_relative_error": mesh_comparability["magnetic_node_count_relative_error"],
        "field_cell_count_relative_error": mesh_comparability["field_cell_count_relative_error"],
    }
    limits = {
        "average_m_l2_delta": args.max_average_m_l2_delta,
        "e_demag_density_relative_error": args.max_e_demag_density_relative_error,
        "h_demag_stats_relative_error": args.max_h_demag_stats_relative_error,
        "demag_phi_max_abs_delta_A": args.max_demag_phi_max_abs_delta_a,
        "central_cell_torque_residual_relative_error": args.max_central_cell_torque_residual_relative_error,
        "relaxation_state_mean_deviation_relative_error": args.max_relaxation_state_mean_deviation_relative_error,
        "mapped_m_p99_l2_delta": args.max_mapped_m_p99_l2_delta,
        "mapped_h_demag_p99_relative_error": args.max_mapped_h_demag_p99_relative_error,
        "mapped_demag_phi_max_abs_delta_after_offset_A": args.max_mapped_demag_phi_max_abs_delta_after_offset_a,
        "mapped_max_nearest_field_node_distance_m": args.max_mapped_nearest_distance_m,
        "mapped_max_nearest_magnetic_node_distance_m": args.max_mapped_nearest_distance_m,
    }
    status, failures = status_from_limits(metrics, limits)
    report = {
        "schema_version": "fem_static_pbc_supercell_validation.v1",
        "status": status,
        "unit_cell_artifacts": str(args.unit_cell),
        "supercell_artifacts": str(args.supercell),
        "repeat_x": args.repeat_x,
        "repeat_y": args.repeat_y,
        "cell_count": cell_count,
        "central_cell_extraction": {
            key: value
            for key, value in extraction.items()
            if key not in {"magnetic_node_indices", "field_cell_indices"}
        },
        "mesh_comparability": mesh_comparability,
        "relaxation_state_comparability": relaxation_state,
        "mapped_central_cell_comparability": mapped_comparison,
        "metrics": metrics,
        "workload": workload,
        "thresholds": limits,
        "failure_reasons": failures,
    }
    if interpolated_comparison is not None:
        report["interpolated_central_cell_comparability"] = interpolated_comparison
    override = initial_magnetization_state_override(args.supercell)
    if override is not None:
        report["supercell_initial_magnetization_state_override"] = override
    return report


def add_common_report_arg(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--report", type=Path, required=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--allow-failed-status",
        action="store_true",
        help=(
            "Write a failed comparison report with exit status 0 when artifacts are valid "
            "but threshold metrics fail. Invalid or incompatible artifacts still fail."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    z_padding = subparsers.add_parser("z-padding")
    z_padding.add_argument("--reference", type=Path, required=True)
    z_padding.add_argument("--candidate", type=Path, required=True)
    z_padding.add_argument("--max-e-demag-relative-error", type=float, default=DEFAULT_MAX_E_DEMAG_RELERR)
    z_padding.add_argument("--max-h-demag-p99-relative-error", type=float, default=DEFAULT_MAX_H_DEMAG_P99_RELERR)
    z_padding.add_argument("--max-demag-phi-range-relative-error", type=float, default=DEFAULT_MAX_DEMAG_PHI_RANGE_RELERR)
    add_common_report_arg(z_padding)

    supercell = subparsers.add_parser("supercell")
    supercell.add_argument("--unit-cell", type=Path, required=True)
    supercell.add_argument("--supercell", type=Path, required=True)
    supercell.add_argument("--repeat-x", type=int, required=True)
    supercell.add_argument("--repeat-y", type=int, required=True)
    supercell.add_argument("--max-average-m-l2-delta", type=float, default=DEFAULT_MAX_AVERAGE_M_L2_DELTA)
    supercell.add_argument("--max-e-demag-density-relative-error", type=float, default=DEFAULT_MAX_E_DEMAG_RELERR)
    supercell.add_argument("--max-h-demag-stats-relative-error", type=float, default=DEFAULT_MAX_E_DEMAG_RELERR)
    supercell.add_argument("--max-demag-phi-max-abs-delta-a", type=float, default=DEFAULT_MAX_SUPERCELL_DEMAG_PHI_DELTA_A)
    supercell.add_argument(
        "--max-central-cell-torque-residual-relative-error",
        type=float,
        default=DEFAULT_MAX_TORQUE_RELERR,
    )
    supercell.add_argument(
        "--max-relaxation-state-mean-deviation-relative-error",
        type=float,
        default=DEFAULT_MAX_RELAXATION_STATE_MEAN_DEVIATION_RELERR,
    )
    supercell.add_argument("--max-mapped-m-p99-l2-delta", type=float, default=DEFAULT_MAX_MAPPED_M_P99_L2_DELTA)
    supercell.add_argument(
        "--max-mapped-h-demag-p99-relative-error",
        type=float,
        default=DEFAULT_MAX_MAPPED_H_DEMAG_P99_RELERR,
    )
    supercell.add_argument(
        "--max-mapped-demag-phi-max-abs-delta-after-offset-a",
        type=float,
        default=DEFAULT_MAX_MAPPED_DEMAG_PHI_DELTA_A,
    )
    supercell.add_argument(
        "--max-mapped-nearest-distance-m",
        type=float,
        default=DEFAULT_MAX_MAPPED_SUPERCELL_NEAREST_DISTANCE_M,
    )
    supercell.add_argument(
        "--include-interpolated-comparison",
        action="store_true",
        help=(
            "Add a diagnostic primitive-tetrahedron interpolation comparison for independently remeshed "
            "supercell central cells. This does not replace the strict same-local nearest-node gate."
        ),
    )
    supercell.add_argument(
        "--interpolation-barycentric-tolerance",
        type=float,
        default=DEFAULT_INTERPOLATION_BARYCENTRIC_TOL,
    )
    add_common_report_arg(supercell)

    args = parser.parse_args()
    for name, value in vars(args).items():
        if name.startswith("max_"):
            require(math.isfinite(value) and value >= 0.0, f"--{name.replace('_', '-')} must be non-negative")
    if args.command == "supercell":
        require(args.repeat_x > 0 and args.repeat_y > 0, "--repeat-x and --repeat-y must be positive")
        require(args.repeat_x * args.repeat_y > 1, "supercell comparison requires more than one repeated cell")
        require(
            math.isfinite(args.interpolation_barycentric_tolerance)
            and args.interpolation_barycentric_tolerance >= 0.0,
            "--interpolation-barycentric-tolerance must be non-negative",
        )
    return args


def main() -> int:
    try:
        args = parse_args()
        report = compare_z_padding(args) if args.command == "z-padding" else compare_supercell(args)
        write_report(args.report, report)
        if report["status"] != "ok":
            print("\n".join(report["failure_reasons"]), file=sys.stderr)
            if args.allow_failed_status:
                return 0
            return 1
        return 0
    except Exception as exc:
        print(f"invalid FEM static PBC comparison artifacts: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
