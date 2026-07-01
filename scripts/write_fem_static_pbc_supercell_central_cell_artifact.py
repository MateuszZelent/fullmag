#!/usr/bin/env python3
"""Write strict-M5 FEM static PBC supercell central-cell extraction artifacts."""

from __future__ import annotations

import argparse
import csv
import json
import math
import struct
import sys
from pathlib import Path
from typing import Any

MU0_H_PER_M = 1.25663706212e-6


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


def parse_index_tokens(raw: str) -> list[str]:
    return [token.strip() for token in raw.strip().replace("\n", ",").split(",")]


def parse_indices_payload(raw: str, name: str) -> list[int]:
    require(raw.strip() != "", f"{name} must contain at least one index")
    stripped = raw.strip()
    if stripped.startswith("[") or stripped.startswith("{"):
        try:
            payload = json.loads(stripped)
        except json.JSONDecodeError as exc:
            fail(f"{name} contains invalid JSON: {exc}")
        if isinstance(payload, dict):
            payload = payload.get("indices")
        require(isinstance(payload, list), f"{name} JSON payload must be a list or object with indices")
        tokens = [str(value) for value in payload]
    else:
        tokens = parse_index_tokens(raw)
    indices: list[int] = []
    seen: set[int] = set()
    for position, token in enumerate(tokens):
        require(token != "", f"{name} contains an empty index at position {position}")
        try:
            index = int(token)
        except ValueError:
            fail(f"{name} contains non-integer index {token!r}")
        require(index >= 0, f"{name} contains negative index {index}")
        require(index not in seen, f"{name} contains duplicate index {index}")
        seen.add(index)
        indices.append(index)
    return indices


def parse_indices(raw: str, name: str) -> list[int]:
    candidate_path = Path(raw.strip())
    if candidate_path.is_file():
        return parse_indices_payload(candidate_path.read_text(encoding="utf-8"), f"{name} file {candidate_path}")
    return parse_indices_payload(raw, name)


def load_json(path: Path) -> dict[str, Any]:
    require(path.is_file(), f"missing JSON file: {path}")
    return require_object(json.loads(path.read_text(encoding="utf-8")), str(path))


def qualification(root: Path) -> dict[str, Any]:
    metadata = load_json(root / "metadata.json")
    for key in ("fem_cpu_relaxation_qualification", "fem_gpu_relaxation_qualification"):
        value = metadata.get(key)
        if isinstance(value, dict):
            return value
    fail("metadata must contain fem_cpu_relaxation_qualification or fem_gpu_relaxation_qualification")


def final_supercell_scalars(root: Path) -> tuple[float, float]:
    qual = qualification(root)
    energy_terms = require_object(qual.get("final_energy_terms_j"), "metadata final_energy_terms_j")
    e_demag = finite_number(energy_terms.get("E_demag"), "metadata final E_demag")
    torque = finite_number(qual.get("final_torque_apm"), "metadata final_torque_apm")
    require(e_demag >= 0.0, "metadata final E_demag must be non-negative")
    require(torque >= 0.0, "metadata final_torque_apm must be non-negative")
    return e_demag, torque


def periodic_metadata(root: Path) -> dict[str, Any]:
    metadata = load_json(root / "metadata.json")
    return require_object(
        metadata.get("periodic_antidot_relaxation"),
        "metadata.periodic_antidot_relaxation",
    )


def magnetic_node_count(root: Path) -> int:
    data = load_json(root / "m_final.json")
    values = require_list(data.get("values"), "m_final.values")
    require(values, "m_final.values must be non-empty")
    for index, raw_vector in enumerate(values):
        vector = require_list(raw_vector, f"m_final.values[{index}]")
        require(len(vector) == 3, f"m_final.values[{index}] must be a 3-vector")
        for component_index, component in enumerate(vector):
            finite_number(component, f"m_final.values[{index}][{component_index}]")
    return len(values)


def zarr_cell_count(root: Path, observable: str, expected_components: list[str]) -> int:
    field_dir = root / "fields" / f"{observable}.zarr"
    require(field_dir.is_dir(), f"missing {observable} zarr directory: {field_dir}")
    attrs = load_json(field_dir / ".zattrs")
    array = load_json(field_dir / ".zarray")
    component_order = [str(value) for value in require_list(attrs.get("component_order"), f"{observable}.component_order")]
    require(
        component_order == expected_components,
        f"{observable}.component_order must be {expected_components!r}, got {component_order!r}",
    )
    require(array.get("dtype") == "<f8", f"{observable} zarr dtype must be <f8")
    require(array.get("order") == "C", f"{observable} zarr order must be C")
    shape = require_list(array.get("shape"), f"{observable}.shape")
    require(
        len(shape) == 3 and shape[0] == 1 and shape[1] == len(expected_components),
        f"{observable}.shape must be [1, {len(expected_components)}, cells]",
    )
    cell_count = int(shape[2])
    require(cell_count > 0, f"{observable} zarr cell count must be positive")
    samples_path = field_dir / "samples.csv"
    require(samples_path.is_file(), f"missing {observable} samples.csv: {samples_path}")
    with samples_path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    require(rows, f"{observable} samples.csv must not be empty")
    chunk_key = rows[-1].get("chunk_key")
    require(isinstance(chunk_key, str) and chunk_key, f"{observable} chunk_key must be present")
    raw = (field_dir / chunk_key).read_bytes()
    expected_value_count = cell_count * len(expected_components)
    require(
        len(raw) == expected_value_count * 8,
        f"{observable} zarr chunk byte length mismatch",
    )
    values = struct.unpack(f"<{expected_value_count}d", raw)
    require(all(math.isfinite(value) for value in values), f"{observable} zarr values must be finite")
    return cell_count


def load_zarr_vectors(root: Path, observable: str, expected_components: list[str]) -> list[list[float]]:
    field_dir = root / "fields" / f"{observable}.zarr"
    require(field_dir.is_dir(), f"missing {observable} zarr directory: {field_dir}")
    attrs = load_json(field_dir / ".zattrs")
    array = load_json(field_dir / ".zarray")
    component_order = [str(value) for value in require_list(attrs.get("component_order"), f"{observable}.component_order")]
    require(
        component_order == expected_components,
        f"{observable}.component_order must be {expected_components!r}, got {component_order!r}",
    )
    require(array.get("dtype") == "<f8", f"{observable} zarr dtype must be <f8")
    require(array.get("order") == "C", f"{observable} zarr order must be C")
    shape = require_list(array.get("shape"), f"{observable}.shape")
    require(
        len(shape) == 3 and shape[0] == 1 and shape[1] == len(expected_components),
        f"{observable}.shape must be [1, {len(expected_components)}, cells]",
    )
    cell_count = int(shape[2])
    require(cell_count > 0, f"{observable} zarr cell count must be positive")
    samples_path = field_dir / "samples.csv"
    require(samples_path.is_file(), f"missing {observable} samples.csv: {samples_path}")
    with samples_path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    require(rows, f"{observable} samples.csv must not be empty")
    chunk_key = rows[-1].get("chunk_key")
    require(isinstance(chunk_key, str) and chunk_key, f"{observable} chunk_key must be present")
    raw = (field_dir / chunk_key).read_bytes()
    expected_value_count = cell_count * len(expected_components)
    require(
        len(raw) == expected_value_count * 8,
        f"{observable} zarr chunk byte length mismatch",
    )
    flat_values = struct.unpack(f"<{expected_value_count}d", raw)
    require(all(math.isfinite(value) for value in flat_values), f"{observable} zarr values must be finite")
    return [
        [float(flat_values[component * cell_count + index]) for component in range(len(expected_components))]
        for index in range(cell_count)
    ]


def load_node_geometry(root: Path) -> dict[str, Any]:
    path = root / "mesh" / "node_geometry.v1.json"
    geometry = load_json(path)
    require(
        geometry.get("schema_version") == "fem_mesh_node_geometry.v1",
        "mesh/node_geometry.v1.json schema_version must be fem_mesh_node_geometry.v1",
    )
    alignment = require_object(
        geometry.get("field_cell_alignment"),
        "mesh/node_geometry.v1.json field_cell_alignment",
    )
    for observable in ("m", "H_demag", "demag_phi"):
        require(
            alignment.get(observable) == "node_index",
            f"mesh/node_geometry.v1.json field_cell_alignment.{observable} must be node_index",
        )
    return geometry


def cross(a: list[float], b: list[float]) -> list[float]:
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]


def dot(a: list[float], b: list[float]) -> float:
    return sum(ai * bi for ai, bi in zip(a, b))


def sub(a: list[float], b: list[float]) -> list[float]:
    return [ai - bi for ai, bi in zip(a, b)]


def norm(a: list[float]) -> float:
    return math.sqrt(dot(a, a))


def tetra_volume(p0: list[float], p1: list[float], p2: list[float], p3: list[float]) -> float:
    return abs(dot(sub(p1, p0), cross(sub(p2, p0), sub(p3, p0)))) / 6.0


def magnetic_element_mask(markers: list[Any], element_count: int) -> list[bool]:
    require(len(markers) == element_count, "metadata mesh element_markers length must match elements")
    parsed = []
    for index, marker in enumerate(markers):
        require(isinstance(marker, int), f"metadata mesh element_markers[{index}] must be an integer")
        require(marker >= 0, f"metadata mesh element_markers[{index}] must be non-negative")
        parsed.append(marker)
    has_air = any(marker == 0 for marker in parsed)
    has_magnetic = any(marker != 0 for marker in parsed)
    if has_air and has_magnetic:
        return [marker != 0 for marker in parsed]
    return [True for _ in parsed]


def backend_plan(root: Path) -> dict[str, Any]:
    metadata = load_json(root / "metadata.json")
    execution_plan = require_object(metadata.get("execution_plan"), "metadata.execution_plan")
    return require_object(execution_plan.get("backend_plan"), "metadata.execution_plan.backend_plan")


def load_mesh_nodes_elements_masks(root: Path) -> tuple[list[list[float]], list[list[int]], list[bool]]:
    plan = backend_plan(root)
    mesh = require_object(plan.get("mesh"), "metadata.execution_plan.backend_plan.mesh")
    raw_nodes = require_list(mesh.get("nodes"), "metadata mesh nodes")
    nodes: list[list[float]] = []
    for index, raw_node in enumerate(raw_nodes):
        node = require_list(raw_node, f"metadata mesh nodes[{index}]")
        require(len(node) == 3, f"metadata mesh nodes[{index}] must be a 3-vector")
        nodes.append([finite_number(node[axis], f"metadata mesh nodes[{index}][{axis}]") for axis in range(3)])
    raw_elements = require_list(mesh.get("elements"), "metadata mesh elements")
    masks = magnetic_element_mask(require_list(mesh.get("element_markers"), "metadata mesh element_markers"), len(raw_elements))
    elements: list[list[int]] = []
    for element_index, raw_element in enumerate(raw_elements):
        element = require_list(raw_element, f"metadata mesh elements[{element_index}]")
        require(len(element) == 4, f"metadata mesh elements[{element_index}] must be a tetrahedron")
        node_indices: list[int] = []
        for local_index, raw_node_index in enumerate(element):
            require(isinstance(raw_node_index, int), f"metadata mesh elements[{element_index}][{local_index}] must be an integer")
            require(0 <= raw_node_index < len(nodes), f"metadata mesh elements[{element_index}][{local_index}] is outside nodes")
            node_indices.append(raw_node_index)
        elements.append(node_indices)
    return nodes, elements, masks


def saturation_magnetisation_values(root: Path, node_count: int) -> list[float]:
    plan = backend_plan(root)
    material = require_object(plan.get("material"), "metadata.execution_plan.backend_plan.material")
    raw_ms_field = material.get("ms_field")
    if raw_ms_field is not None:
        ms_field = require_list(raw_ms_field, "metadata material ms_field")
        require(len(ms_field) == node_count, "metadata material ms_field length must match node count")
        return [finite_number(value, f"metadata material ms_field[{index}]") for index, value in enumerate(ms_field)]
    uniform = finite_number(
        material.get("saturation_magnetisation"),
        "metadata material saturation_magnetisation",
    )
    require(uniform > 0.0, "metadata material saturation_magnetisation must be positive")
    return [uniform for _ in range(node_count)]


def load_m_values(root: Path) -> list[list[float]]:
    data = load_json(root / "m_final.json")
    values = require_list(data.get("values"), "m_final.values")
    out: list[list[float]] = []
    for index, raw_vector in enumerate(values):
        vector = require_list(raw_vector, f"m_final.values[{index}]")
        require(len(vector) == 3, f"m_final.values[{index}] must be a 3-vector")
        out.append([finite_number(vector[axis], f"m_final.values[{index}][{axis}]") for axis in range(3)])
    require(out, "m_final.values must be non-empty")
    return out


def compute_central_cell_scalars(
    root: Path,
    *,
    magnetic_indices: list[int],
    x_bounds: tuple[float, float],
    y_bounds: tuple[float, float],
) -> tuple[float, float, dict[str, Any]]:
    mesh_nodes, elements, masks = load_mesh_nodes_elements_masks(root)
    m_values = load_m_values(root)
    h_demag = load_zarr_vectors(root, "H_demag", ["x", "y", "z"])
    h_eff = load_zarr_vectors(root, "H_eff", ["x", "y", "z"])
    node_count = len(mesh_nodes)
    require(len(m_values) == node_count, "m_final.values length must match metadata mesh nodes")
    require(len(h_demag) == node_count, "H_demag zarr length must match metadata mesh nodes")
    require(len(h_eff) == node_count, "H_eff zarr length must match metadata mesh nodes")
    ms_values = saturation_magnetisation_values(root, node_count)

    demag_integral = 0.0
    central_magnetic_volume = 0.0
    used_element_count = 0
    for element_index, node_indices in enumerate(elements):
        if not masks[element_index]:
            continue
        centroid_x = sum(mesh_nodes[node_index][0] for node_index in node_indices) / 4.0
        centroid_y = sum(mesh_nodes[node_index][1] for node_index in node_indices) / 4.0
        if not (x_bounds[0] <= centroid_x <= x_bounds[1] and y_bounds[0] <= centroid_y <= y_bounds[1]):
            continue
        volume = tetra_volume(*(mesh_nodes[node_index] for node_index in node_indices))
        require(volume > 0.0 and math.isfinite(volume), f"metadata mesh elements[{element_index}] volume must be positive")
        used_element_count += 1
        central_magnetic_volume += volume
        demag_integral += (
            sum(ms_values[node_index] * dot(m_values[node_index], h_demag[node_index]) for node_index in node_indices)
            / 4.0
        ) * volume
    require(used_element_count > 0, "auto scalar computation found no central-cell magnetic elements")

    max_torque = 0.0
    used_node_count = 0
    for node in magnetic_indices:
        require(0 <= node < node_count, f"central-cell magnetic node index {node} is outside metadata mesh nodes")
        used_node_count += 1
        max_torque = max(max_torque, norm(cross(m_values[node], h_eff[node])))
    require(used_node_count > 0, "auto scalar computation found no central-cell magnetic nodes")
    energy = -0.5 * MU0_H_PER_M * demag_integral
    if energy < 0.0 and abs(energy) <= 1.0e-30:
        energy = 0.0
    require(energy >= 0.0, "computed central-cell demag energy must be non-negative")
    selection = {
        "method": "element_centroid_mesh_integral",
        "mesh_source": "metadata.execution_plan.backend_plan.mesh",
        "element_selection": "magnetic_element_centroid_in_central_cell",
        "central_cell_x_bounds_m": list(x_bounds),
        "central_cell_y_bounds_m": list(y_bounds),
        "magnetization_artifact": "m_final.json",
        "h_demag_artifact": "fields/H_demag.zarr",
        "h_eff_artifact": "fields/H_eff.zarr",
        "central_magnetic_node_count": used_node_count,
        "central_magnetic_element_count": used_element_count,
        "central_magnetic_volume_m3": central_magnetic_volume,
        "demag_energy_formula": "-0.5*mu0*sum_elements(volume_e*mean_vertices(Ms_i*dot(m_i,H_demag_i)))",
        "torque_formula": "max(norm(cross(m_i,H_eff_i)))",
    }
    return energy, max_torque, selection


def central_cell_bounds(
    root: Path,
    *,
    repeat_x: int,
    repeat_y: int,
    cell_index: list[int],
) -> tuple[tuple[float, float], tuple[float, float]]:
    metadata = periodic_metadata(root)
    film_size = [
        finite_number(value, f"metadata.periodic_antidot_relaxation.film_size_m[{index}]")
        for index, value in enumerate(
            require_list(metadata.get("film_size_m"), "metadata.periodic_antidot_relaxation.film_size_m")
        )
    ]
    require(len(film_size) == 3, "metadata.periodic_antidot_relaxation.film_size_m must be a 3-vector")
    universe_size = [
        finite_number(value, f"metadata.periodic_antidot_relaxation.universe_size_m[{index}]")
        for index, value in enumerate(
            require_list(metadata.get("universe_size_m"), "metadata.periodic_antidot_relaxation.universe_size_m")
        )
    ]
    require(len(universe_size) == 3, "metadata.periodic_antidot_relaxation.universe_size_m must be a 3-vector")
    expected_universe_x = film_size[0] * repeat_x
    expected_universe_y = film_size[1] * repeat_y
    require(
        math.isclose(universe_size[0], expected_universe_x, rel_tol=1.0e-12, abs_tol=1.0e-18),
        "metadata universe_size_m[0] must equal film_size_m[0] * repeat_x",
    )
    require(
        math.isclose(universe_size[1], expected_universe_y, rel_tol=1.0e-12, abs_tol=1.0e-18),
        "metadata universe_size_m[1] must equal film_size_m[1] * repeat_y",
    )
    x_min = -0.5 * universe_size[0] + cell_index[0] * film_size[0]
    y_min = -0.5 * universe_size[1] + cell_index[1] * film_size[1]
    return (
        (x_min, x_min + film_size[0]),
        (y_min, y_min + film_size[1]),
    )


def auto_select_central_cell_indices(
    root: Path,
    *,
    repeat_x: int,
    repeat_y: int,
    cell_index: list[int],
) -> tuple[list[int], list[int], dict[str, Any]]:
    geometry = load_node_geometry(root)
    node_count = geometry.get("node_count")
    nodes = require_list(geometry.get("nodes_m"), "mesh/node_geometry.v1.json nodes_m")
    magnetic_mask = require_list(
        geometry.get("magnetic_node_mask"),
        "mesh/node_geometry.v1.json magnetic_node_mask",
    )
    require(
        isinstance(node_count, int) and len(nodes) == node_count,
        "mesh/node_geometry.v1.json nodes_m length must match node_count",
    )
    require(
        len(magnetic_mask) == node_count and all(isinstance(value, bool) for value in magnetic_mask),
        "mesh/node_geometry.v1.json magnetic_node_mask must contain node_count booleans",
    )
    x_bounds, y_bounds = central_cell_bounds(
        root,
        repeat_x=repeat_x,
        repeat_y=repeat_y,
        cell_index=cell_index,
    )
    tolerance = 1.0e-15
    field_indices: list[int] = []
    magnetic_indices: list[int] = []
    for index, raw_node in enumerate(nodes):
        node = require_list(raw_node, f"mesh/node_geometry.v1.json nodes_m[{index}]")
        require(len(node) == 3, f"mesh/node_geometry.v1.json nodes_m[{index}] must be a 3-vector")
        x = finite_number(node[0], f"mesh/node_geometry.v1.json nodes_m[{index}][0]")
        y = finite_number(node[1], f"mesh/node_geometry.v1.json nodes_m[{index}][1]")
        in_cell = (
            x_bounds[0] - tolerance <= x <= x_bounds[1] + tolerance
            and y_bounds[0] - tolerance <= y <= y_bounds[1] + tolerance
        )
        if not in_cell:
            continue
        field_indices.append(index)
        if bool(magnetic_mask[index]):
            magnetic_indices.append(index)
    require(field_indices, "auto central-cell selection produced no field indices")
    require(magnetic_indices, "auto central-cell selection produced no magnetic node indices")
    selection = {
        "method": "node_geometry_bounds",
        "geometry_artifact": "mesh/node_geometry.v1.json",
        "x_bounds_m": list(x_bounds),
        "y_bounds_m": list(y_bounds),
        "field_cell_count": len(field_indices),
        "magnetic_node_count": len(magnetic_indices),
    }
    return magnetic_indices, field_indices, selection


def require_indices_in_range(indices: list[int], *, upper_bound: int, name: str) -> None:
    for index in indices:
        require(index < upper_bound, f"{name} contains index {index} outside [0, {upper_bound})")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact_root", type=Path)
    parser.add_argument("--repeat-x", type=int, required=True)
    parser.add_argument("--repeat-y", type=int, required=True)
    parser.add_argument("--central-cell-index", default=None, help="Optional i,j index; defaults to floor(repeat/2).")
    parser.add_argument(
        "--auto-central-cell-indices",
        action="store_true",
        help="Select central-cell node-aligned indices from mesh/node_geometry.v1.json.",
    )
    parser.add_argument(
        "--auto-central-cell-scalars",
        action="store_true",
        help="Compute central-cell demag energy and torque from mesh weights, m, H_demag, and H_eff.",
    )
    parser.add_argument("--magnetic-node-indices")
    parser.add_argument("--field-cell-indices")
    parser.add_argument("--central-cell-demag-energy-j", type=float)
    parser.add_argument("--central-cell-torque-apm", type=float)
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Defaults to artifact_root/diagnostics/fem_static_pbc_supercell_central_cell.v1.json.",
    )
    args = parser.parse_args()
    require(args.artifact_root.is_dir(), f"artifact_root must be a directory: {args.artifact_root}")
    require(args.repeat_x > 0 and args.repeat_y > 0, "--repeat-x and --repeat-y must be positive")
    require(args.repeat_x * args.repeat_y > 1, "supercell extraction requires repeat_x * repeat_y > 1")
    if args.auto_central_cell_indices:
        require(
            args.magnetic_node_indices is None and args.field_cell_indices is None,
            "--auto-central-cell-indices cannot be combined with explicit index lists",
        )
    else:
        require(args.magnetic_node_indices is not None, "--magnetic-node-indices is required without --auto-central-cell-indices")
        require(args.field_cell_indices is not None, "--field-cell-indices is required without --auto-central-cell-indices")
    if args.auto_central_cell_scalars:
        require(
            args.central_cell_demag_energy_j is None and args.central_cell_torque_apm is None,
            "--auto-central-cell-scalars cannot be combined with explicit central-cell scalar values",
        )
    else:
        require(args.central_cell_demag_energy_j is not None, "--central-cell-demag-energy-j is required without --auto-central-cell-scalars")
        require(args.central_cell_torque_apm is not None, "--central-cell-torque-apm is required without --auto-central-cell-scalars")
        require(
            math.isfinite(args.central_cell_demag_energy_j) and args.central_cell_demag_energy_j >= 0.0,
            "--central-cell-demag-energy-j must be finite and non-negative",
        )
        require(
            math.isfinite(args.central_cell_torque_apm) and args.central_cell_torque_apm >= 0.0,
            "--central-cell-torque-apm must be finite and non-negative",
        )
    return args


def central_cell_index(args: argparse.Namespace) -> list[int]:
    if args.central_cell_index is None:
        return [args.repeat_x // 2, args.repeat_y // 2]
    parts = [part.strip() for part in args.central_cell_index.split(",")]
    require(len(parts) == 2, "--central-cell-index must have form i,j")
    try:
        value = [int(parts[0]), int(parts[1])]
    except ValueError:
        fail("--central-cell-index must contain integer indices")
    require(0 <= value[0] < args.repeat_x, "--central-cell-index i is outside repeat_x")
    require(0 <= value[1] < args.repeat_y, "--central-cell-index j is outside repeat_y")
    return value


def write_artifact(args: argparse.Namespace) -> Path:
    cell_index = central_cell_index(args)
    index_selection = None
    scalar_selection = None
    if args.auto_central_cell_indices:
        magnetic_indices, field_indices, index_selection = auto_select_central_cell_indices(
            args.artifact_root,
            repeat_x=args.repeat_x,
            repeat_y=args.repeat_y,
            cell_index=cell_index,
        )
    else:
        magnetic_indices = parse_indices(args.magnetic_node_indices, "--magnetic-node-indices")
        field_indices = parse_indices(args.field_cell_indices, "--field-cell-indices")
    require_indices_in_range(
        magnetic_indices,
        upper_bound=magnetic_node_count(args.artifact_root),
        name="--magnetic-node-indices",
    )
    h_count = zarr_cell_count(args.artifact_root, "H_demag", ["x", "y", "z"])
    phi_count = zarr_cell_count(args.artifact_root, "demag_phi", ["scalar"])
    require_indices_in_range(
        field_indices,
        upper_bound=min(h_count, phi_count),
        name="--field-cell-indices",
    )
    if args.auto_central_cell_scalars:
        x_bounds, y_bounds = central_cell_bounds(
            args.artifact_root,
            repeat_x=args.repeat_x,
            repeat_y=args.repeat_y,
            cell_index=cell_index,
        )
        central_cell_demag_energy_j, central_cell_torque_apm, scalar_selection = compute_central_cell_scalars(
            args.artifact_root,
            magnetic_indices=magnetic_indices,
            x_bounds=x_bounds,
            y_bounds=y_bounds,
        )
    else:
        central_cell_demag_energy_j = float(args.central_cell_demag_energy_j)
        central_cell_torque_apm = float(args.central_cell_torque_apm)
    total_e_demag, total_torque = final_supercell_scalars(args.artifact_root)
    require(
        central_cell_demag_energy_j <= total_e_demag,
        "--central-cell-demag-energy-j exceeds metadata final E_demag",
    )
    require(
        central_cell_torque_apm <= total_torque,
        "--central-cell-torque-apm exceeds metadata final_torque_apm",
    )
    output = args.output or (
        args.artifact_root
        / "diagnostics"
        / "fem_static_pbc_supercell_central_cell.v1.json"
    )
    payload = {
        "schema_version": "fem_static_pbc_supercell_central_cell.v1",
        "artifact_path": str(output.relative_to(args.artifact_root)) if output.is_relative_to(args.artifact_root) else str(output),
        "repeat_x": args.repeat_x,
        "repeat_y": args.repeat_y,
        "cell_count": args.repeat_x * args.repeat_y,
        "central_cell_index": cell_index,
        "magnetic_node_indices": magnetic_indices,
        "field_cell_indices": field_indices,
        "central_cell_demag_energy_j": central_cell_demag_energy_j,
        "central_cell_torque_apm": central_cell_torque_apm,
    }
    if index_selection is not None:
        payload["index_selection"] = index_selection
    if scalar_selection is not None:
        payload["scalar_selection"] = scalar_selection
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return output


def main() -> int:
    try:
        output = write_artifact(parse_args())
    except Exception as exc:
        print(f"invalid FEM static PBC supercell central-cell extraction: {exc}", file=sys.stderr)
        return 1
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
