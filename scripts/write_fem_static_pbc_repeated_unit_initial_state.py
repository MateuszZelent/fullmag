#!/usr/bin/env python3
"""Write a repeated-unit magnetization state for strict-M5 supercell runs."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any


DEFAULT_FILL_VECTOR = [0.0, 0.0, 0.0]
DEFAULT_MAX_NEAREST_DISTANCE_M = 1.0e-12


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


def load_json(path: Path) -> dict[str, Any]:
    require(path.is_file(), f"missing JSON file: {path}")
    return require_object(json.loads(path.read_text(encoding="utf-8")), str(path))


def metadata_contract(root: Path) -> dict[str, Any]:
    metadata = load_json(root / "metadata.json")
    pbc = require_object(metadata.get("pbc"), f"{root}/metadata.pbc")
    require(pbc.get("demag") == "periodic_airbox_k0", f"{root}/metadata.pbc.demag must be periodic_airbox_k0")
    axes = require_list(pbc.get("axes"), f"{root}/metadata.pbc.axes")
    require(axes == ["periodic", "periodic", "open"], "repeated unit-state writer requires x/y periodic and open z")
    periodic = require_object(
        metadata.get("periodic_antidot_relaxation"),
        f"{root}/metadata.periodic_antidot_relaxation",
    )
    universe = require_list(periodic.get("universe_size_m"), f"{root}/metadata.periodic_antidot_relaxation.universe_size_m")
    require(len(universe) == 3, f"{root}/metadata.periodic_antidot_relaxation.universe_size_m must be a 3-vector")
    universe_size = [finite_number(value, f"unit universe_size_m[{index}]") for index, value in enumerate(universe)]
    require(universe_size[0] > 0.0 and universe_size[1] > 0.0, "unit lateral universe_size_m values must be positive")
    return {
        "scenario": str(periodic.get("scenario") or ""),
        "universe_size_m": universe_size,
    }


def load_unit_mesh(root: Path) -> tuple[list[list[float]], list[int]]:
    metadata = load_json(root / "metadata.json")
    plan = require_object(metadata.get("execution_plan"), "metadata.execution_plan")
    backend_plan = require_object(plan.get("backend_plan"), "metadata.execution_plan.backend_plan")
    mesh = require_object(backend_plan.get("mesh"), "metadata.execution_plan.backend_plan.mesh")
    raw_nodes = require_list(mesh.get("nodes"), "metadata mesh nodes")
    nodes: list[list[float]] = []
    for index, raw_node in enumerate(raw_nodes):
        node = require_list(raw_node, f"metadata mesh nodes[{index}]")
        require(len(node) == 3, f"metadata mesh nodes[{index}] must be a 3-vector")
        nodes.append([finite_number(node[axis], f"metadata mesh nodes[{index}][{axis}]") for axis in range(3)])

    elements = require_list(mesh.get("elements"), "metadata mesh elements")
    markers = require_list(mesh.get("element_markers"), "metadata mesh element_markers")
    require(len(markers) == len(elements), "metadata mesh element_markers length must match elements")
    marker_values = [int(marker) for marker in markers]
    has_mixed_airbox = any(marker == 0 for marker in marker_values) and any(marker != 0 for marker in marker_values)
    magnetic: set[int] = set()
    for element_index, raw_element in enumerate(elements):
        if has_mixed_airbox and marker_values[element_index] == 0:
            continue
        element = require_list(raw_element, f"metadata mesh elements[{element_index}]")
        require(len(element) == 4, f"metadata mesh elements[{element_index}] must be a tetrahedron")
        for raw_node_index in element:
            require(isinstance(raw_node_index, int), f"metadata mesh elements[{element_index}] node index must be integer")
            require(0 <= raw_node_index < len(nodes), f"metadata mesh elements[{element_index}] node index out of range")
            magnetic.add(raw_node_index)
    require(magnetic, "unit metadata mesh must contain magnetic nodes")
    return nodes, sorted(magnetic)


def load_m_values(root: Path, expected_count: int) -> list[list[float]]:
    data = load_json(root / "m_final.json")
    values = require_list(data.get("values"), "m_final.values")
    require(len(values) == expected_count, "m_final.values length must match unit mesh nodes")
    out: list[list[float]] = []
    for index, raw_vector in enumerate(values):
        vector = require_list(raw_vector, f"m_final.values[{index}]")
        require(len(vector) == 3, f"m_final.values[{index}] must be a 3-vector")
        out.append([finite_number(vector[axis], f"m_final.values[{index}][{axis}]") for axis in range(3)])
    return out


def load_supercell_node_geometry(root: Path) -> tuple[list[list[float]], list[bool]]:
    geometry = load_json(root / "mesh" / "node_geometry.v1.json")
    require(
        geometry.get("schema_version") == "fem_mesh_node_geometry.v1",
        "mesh/node_geometry.v1.json schema_version must be fem_mesh_node_geometry.v1",
    )
    node_count = geometry.get("node_count")
    raw_nodes = require_list(geometry.get("nodes_m"), "mesh/node_geometry.v1.json nodes_m")
    mask = require_list(geometry.get("magnetic_node_mask"), "mesh/node_geometry.v1.json magnetic_node_mask")
    require(isinstance(node_count, int) and node_count == len(raw_nodes), "node_count must match nodes_m length")
    require(len(mask) == len(raw_nodes), "magnetic_node_mask length must match nodes_m")
    nodes: list[list[float]] = []
    magnetic_mask: list[bool] = []
    for index, raw_node in enumerate(raw_nodes):
        node = require_list(raw_node, f"mesh/node_geometry.v1.json nodes_m[{index}]")
        require(len(node) == 3, f"mesh/node_geometry.v1.json nodes_m[{index}] must be a 3-vector")
        nodes.append([finite_number(node[axis], f"mesh/node_geometry.v1.json nodes_m[{index}][{axis}]") for axis in range(3)])
        require(isinstance(mask[index], bool), f"mesh/node_geometry.v1.json magnetic_node_mask[{index}] must be boolean")
        magnetic_mask.append(bool(mask[index]))
    require(nodes, "supercell node geometry must contain nodes")
    require(any(magnetic_mask), "supercell node geometry must contain magnetic nodes")
    return nodes, magnetic_mask


def reduce_periodic_coordinate(value: float, period: float) -> float:
    return ((value + 0.5 * period) % period) - 0.5 * period


def spatial_key(point: list[float], cell_size: float) -> tuple[int, int, int]:
    return (
        math.floor(point[0] / cell_size),
        math.floor(point[1] / cell_size),
        math.floor(point[2] / cell_size),
    )


def estimate_spatial_cell_size(unit_nodes: list[list[float]], magnetic_indices: list[int]) -> float:
    xs = [unit_nodes[index][0] for index in magnetic_indices]
    ys = [unit_nodes[index][1] for index in magnetic_indices]
    zs = [unit_nodes[index][2] for index in magnetic_indices]
    spans = [
        max(xs) - min(xs),
        max(ys) - min(ys),
        max(zs) - min(zs),
    ]
    positive_spans = [span for span in spans if span > 0.0]
    if not positive_spans:
        return 1.0
    volume = 1.0
    for span in positive_spans:
        volume *= span
    spacing = (volume / float(max(len(magnetic_indices), 1))) ** (1.0 / float(len(positive_spans)))
    return max(spacing * 2.0, max(positive_spans) * 1.0e-6, 1.0e-15)


def build_unit_spatial_index(
    *,
    unit_nodes: list[list[float]],
    magnetic_indices: list[int],
    cell_size: float,
) -> dict[tuple[int, int, int], list[int]]:
    index: dict[tuple[int, int, int], list[int]] = {}
    for node_index in magnetic_indices:
        index.setdefault(spatial_key(unit_nodes[node_index], cell_size), []).append(node_index)
    return index


def nearest_unit_magnetic_node(
    point: list[float],
    *,
    unit_nodes: list[list[float]],
    magnetic_indices: list[int],
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
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                for candidate in spatial_index.get((base_key[0] + dx, base_key[1] + dy, base_key[2] + dz), []):
                    node = unit_nodes[candidate]
                    distance2 = sum((reduced[axis] - node[axis]) ** 2 for axis in range(3))
                    if distance2 < best_distance2:
                        best_index = candidate
                        best_distance2 = distance2
    require(best_index >= 0, "unit magnetic node index is empty")
    return best_index, math.sqrt(best_distance2)


def write_repeated_state(args: argparse.Namespace) -> dict[str, Any]:
    unit_contract = metadata_contract(args.unit_cell)
    unit_nodes, unit_magnetic_indices = load_unit_mesh(args.unit_cell)
    unit_m = load_m_values(args.unit_cell, len(unit_nodes))
    supercell_nodes, supercell_magnetic_mask = load_supercell_node_geometry(args.supercell)
    unit_periods = unit_contract["universe_size_m"]
    cell_size = max(
        args.max_nearest_distance_m,
        estimate_spatial_cell_size(unit_nodes, unit_magnetic_indices),
    )
    spatial_index = build_unit_spatial_index(
        unit_nodes=unit_nodes,
        magnetic_indices=unit_magnetic_indices,
        cell_size=cell_size,
    )

    fill_vector = [float(value) for value in args.air_or_nonmagnetic_fill_vector]
    repeated_values: list[list[float]] = []
    max_distance = 0.0
    sum_distance = 0.0
    mapped_count = 0
    for node, is_magnetic in zip(supercell_nodes, supercell_magnetic_mask):
        if not is_magnetic:
            repeated_values.append(fill_vector)
            continue
        unit_index, distance = nearest_unit_magnetic_node(
            node,
            unit_nodes=unit_nodes,
            magnetic_indices=unit_magnetic_indices,
            unit_periods=unit_periods,
            spatial_index=spatial_index,
            cell_size=cell_size,
        )
        repeated_values.append(unit_m[unit_index])
        mapped_count += 1
        sum_distance += distance
        max_distance = max(max_distance, distance)

    require(mapped_count > 0, "no supercell magnetic nodes were mapped")
    require(
        max_distance <= args.max_nearest_distance_m,
        (
            "nearest unit node distance exceeds "
            f"{args.max_nearest_distance_m:.6e}: {max_distance:.6e}"
        ),
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(
            {
                "kind": "magnetization_state",
                "observable": "m",
                "format": "json",
                "vector_count": len(repeated_values),
                "values": repeated_values,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    report = {
        "schema_version": "fem_static_pbc_repeated_unit_initial_state.v1",
        "unit_cell_artifacts": str(args.unit_cell),
        "supercell_artifacts": str(args.supercell),
        "output": str(args.output),
        "repeat_x": args.repeat_x,
        "repeat_y": args.repeat_y,
        "unit_universe_size_m": unit_periods,
        "unit_magnetic_node_count": len(unit_magnetic_indices),
        "supercell_node_count": len(supercell_nodes),
        "supercell_magnetic_node_count": sum(1 for value in supercell_magnetic_mask if value),
        "mapped_magnetic_node_count": mapped_count,
        "air_or_nonmagnetic_fill_vector": fill_vector,
        "max_nearest_unit_node_distance_m": max_distance,
        "mean_nearest_unit_node_distance_m": sum_distance / float(mapped_count),
        "max_nearest_distance_tolerance_m": args.max_nearest_distance_m,
        "mapping": "supercell magnetic node -> modulo(x/y) nearest unit magnetic node",
    }
    report_path = args.report or args.output.with_suffix(args.output.suffix + ".report.json")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--unit-cell", type=Path, required=True)
    parser.add_argument("--supercell", type=Path, required=True)
    parser.add_argument("--repeat-x", type=int, required=True)
    parser.add_argument("--repeat-y", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path, default=None)
    parser.add_argument("--max-nearest-distance-m", type=float, default=DEFAULT_MAX_NEAREST_DISTANCE_M)
    parser.add_argument(
        "--air-or-nonmagnetic-fill-vector",
        type=float,
        nargs=3,
        default=DEFAULT_FILL_VECTOR,
        metavar=("MX", "MY", "MZ"),
    )
    return parser


def parse_args() -> argparse.Namespace:
    args = build_parser().parse_args()
    require(args.unit_cell.is_dir(), f"--unit-cell must be an artifact directory: {args.unit_cell}")
    require(args.supercell.is_dir(), f"--supercell must be an artifact directory: {args.supercell}")
    require(args.repeat_x > 0 and args.repeat_y > 0, "--repeat-x and --repeat-y must be positive")
    require(args.repeat_x * args.repeat_y > 1, "repeated unit-state preparation requires a real supercell")
    require(
        math.isfinite(args.max_nearest_distance_m) and args.max_nearest_distance_m >= 0.0,
        "--max-nearest-distance-m must be a non-negative finite number",
    )
    return args


def main() -> int:
    try:
        write_repeated_state(parse_args())
        return 0
    except Exception as exc:
        print(f"invalid FEM static PBC repeated-unit initial-state inputs: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
