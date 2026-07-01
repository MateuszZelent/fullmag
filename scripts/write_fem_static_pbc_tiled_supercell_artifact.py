#!/usr/bin/env python3
"""Write a same-local tiled supercell fixture from a primitive FEM PBC artifact."""

from __future__ import annotations

import argparse
import copy
import csv
import json
import math
import struct
import sys
from pathlib import Path
from typing import Any


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


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def load_metadata(root: Path) -> dict[str, Any]:
    return load_json(root / "metadata.json")


def backend_mesh(metadata: dict[str, Any]) -> dict[str, Any]:
    execution_plan = require_object(metadata.get("execution_plan"), "metadata.execution_plan")
    backend_plan = require_object(execution_plan.get("backend_plan"), "metadata.execution_plan.backend_plan")
    return require_object(backend_plan.get("mesh"), "metadata.execution_plan.backend_plan.mesh")


def backend_material(metadata: dict[str, Any]) -> dict[str, Any] | None:
    execution_plan = metadata.get("execution_plan")
    if not isinstance(execution_plan, dict):
        return None
    backend_plan = execution_plan.get("backend_plan")
    if not isinstance(backend_plan, dict):
        return None
    material = backend_plan.get("material")
    return material if isinstance(material, dict) else None


def parse_nodes(mesh: dict[str, Any]) -> list[list[float]]:
    raw_nodes = require_list(mesh.get("nodes"), "metadata mesh nodes")
    nodes: list[list[float]] = []
    for index, raw in enumerate(raw_nodes):
        node = require_list(raw, f"metadata mesh nodes[{index}]")
        require(len(node) == 3, f"metadata mesh nodes[{index}] must be a 3-vector")
        nodes.append([finite_number(node[axis], f"metadata mesh nodes[{index}][{axis}]") for axis in range(3)])
    require(nodes, "metadata mesh nodes must be non-empty")
    return nodes


def parse_elements(mesh: dict[str, Any], node_count: int) -> list[list[int]]:
    raw_elements = require_list(mesh.get("elements"), "metadata mesh elements")
    elements: list[list[int]] = []
    for element_index, raw in enumerate(raw_elements):
        element = require_list(raw, f"metadata mesh elements[{element_index}]")
        require(len(element) == 4, f"metadata mesh elements[{element_index}] must be a tetrahedron")
        parsed: list[int] = []
        for local_index, raw_node in enumerate(element):
            require(isinstance(raw_node, int), f"metadata mesh elements[{element_index}][{local_index}] must be integer")
            require(0 <= raw_node < node_count, f"metadata mesh elements[{element_index}][{local_index}] out of range")
            parsed.append(raw_node)
        elements.append(parsed)
    require(elements, "metadata mesh elements must be non-empty")
    return elements


def magnetic_mask_from_metadata(mesh: dict[str, Any], node_count: int) -> list[bool]:
    elements = parse_elements(mesh, node_count)
    raw_markers = mesh.get("element_markers")
    if raw_markers is None:
        return [True for _ in range(node_count)]
    markers = require_list(raw_markers, "metadata mesh element_markers")
    require(len(markers) == len(elements), "metadata mesh element_markers length must match elements")
    marker_values = []
    for index, marker in enumerate(markers):
        require(isinstance(marker, int), f"metadata mesh element_markers[{index}] must be integer")
        marker_values.append(marker)
    has_mixed_airbox = any(marker == 0 for marker in marker_values) and any(marker != 0 for marker in marker_values)
    magnetic = [False for _ in range(node_count)]
    for element, marker in zip(elements, marker_values):
        if has_mixed_airbox and marker == 0:
            continue
        for node_index in element:
            magnetic[node_index] = True
    require(any(magnetic), "metadata mesh must contain magnetic nodes")
    return magnetic


def load_node_geometry_mask(root: Path, node_count: int) -> list[bool] | None:
    path = root / "mesh" / "node_geometry.v1.json"
    if not path.is_file():
        return None
    payload = load_json(path)
    mask = require_list(payload.get("magnetic_node_mask"), "mesh/node_geometry.v1.json magnetic_node_mask")
    require(len(mask) == node_count, "mesh/node_geometry.v1.json magnetic_node_mask length must match mesh nodes")
    out: list[bool] = []
    for index, value in enumerate(mask):
        require(isinstance(value, bool), f"mesh/node_geometry.v1.json magnetic_node_mask[{index}] must be boolean")
        out.append(bool(value))
    require(any(out), "mesh/node_geometry.v1.json magnetic_node_mask must select magnetic nodes")
    return out


def load_m_artifact(root: Path, node_count: int, artifact_name: str) -> dict[str, Any]:
    payload = load_json(root / artifact_name)
    values_name = f"{artifact_name}.values"
    values = require_list(payload.get("values"), values_name)
    require(len(values) == node_count, f"{values_name} length must match metadata mesh nodes")
    for index, raw in enumerate(values):
        vector = require_list(raw, f"{values_name}[{index}]")
        require(len(vector) == 3, f"{values_name}[{index}] must be a 3-vector")
        for component in range(3):
            finite_number(vector[component], f"{values_name}[{index}][{component}]")
    return payload


def qualification(metadata: dict[str, Any]) -> dict[str, Any]:
    for key in ("fem_cpu_relaxation_qualification", "fem_gpu_relaxation_qualification"):
        value = metadata.get(key)
        if isinstance(value, dict):
            return value
    fail("metadata must contain fem_cpu_relaxation_qualification or fem_gpu_relaxation_qualification")


def scale_final_energy_terms(metadata: dict[str, Any], cell_count: int) -> tuple[float, float]:
    qual = qualification(metadata)
    energy_terms = require_object(qual.get("final_energy_terms_j"), "final_energy_terms_j")
    unit_e_demag = finite_number(energy_terms.get("E_demag"), "final_energy_terms_j.E_demag")
    for key, value in list(energy_terms.items()):
        if isinstance(value, (int, float)) and math.isfinite(float(value)):
            energy_terms[key] = float(value) * float(cell_count)
    torque = finite_number(qual.get("final_torque_apm"), "final_torque_apm")
    return unit_e_demag, torque


def translation_for_tile(ix: int, iy: int, repeat_x: int, repeat_y: int, periods: list[float]) -> list[float]:
    return [
        float(ix - repeat_x // 2) * periods[0],
        float(iy - repeat_y // 2) * periods[1],
        0.0,
    ]


def tile_nodes(nodes: list[list[float]], repeat_x: int, repeat_y: int, periods: list[float]) -> list[list[float]]:
    tiled: list[list[float]] = []
    for iy in range(repeat_y):
        for ix in range(repeat_x):
            offset = translation_for_tile(ix, iy, repeat_x, repeat_y, periods)
            for node in nodes:
                tiled.append([node[axis] + offset[axis] for axis in range(3)])
    return tiled


def tile_elements(elements: list[list[int]], node_count: int, repeat_x: int, repeat_y: int) -> list[list[int]]:
    tiled: list[list[int]] = []
    for tile in range(repeat_x * repeat_y):
        offset = tile * node_count
        for element in elements:
            tiled.append([node_index + offset for node_index in element])
    return tiled


def tile_list(values: list[Any], repeat_x: int, repeat_y: int) -> list[Any]:
    tiled: list[Any] = []
    for _ in range(repeat_x * repeat_y):
        tiled.extend(copy.deepcopy(values))
    return tiled


def write_node_geometry(
    output: Path,
    *,
    nodes: list[list[float]],
    magnetic_mask: list[bool],
    copied_observables: list[str],
) -> None:
    alignment = {
        "m": "node_index",
        "H_demag": "node_index",
        "demag_phi": "node_index",
    }
    for observable in copied_observables:
        alignment.setdefault(observable, "node_index")
    write_json(
        output / "mesh" / "node_geometry.v1.json",
        {
            "schema_version": "fem_mesh_node_geometry.v1",
            "artifact_path": "mesh/node_geometry.v1.json",
            "node_count": len(nodes),
            "nodes_m": nodes,
            "magnetic_node_mask": magnetic_mask,
            "magnetic_node_count": sum(1 for value in magnetic_mask if value),
            "field_cell_alignment": alignment,
        },
    )


def tile_zarr_field(unit_root: Path, output: Path, observable: str, node_count: int, repeat_x: int, repeat_y: int) -> None:
    source = unit_root / "fields" / f"{observable}.zarr"
    target = output / "fields" / f"{observable}.zarr"
    attrs = load_json(source / ".zattrs")
    array = load_json(source / ".zarray")
    require(array.get("dtype") == "<f8", f"{observable} zarr dtype must be <f8")
    require(array.get("order") == "C", f"{observable} zarr order must be C")
    shape = require_list(array.get("shape"), f"{observable}.shape")
    require(
        len(shape) == 3
        and isinstance(shape[0], int)
        and isinstance(shape[1], int)
        and isinstance(shape[2], int),
        f"{observable}.shape must be [samples, components, cells]",
    )
    sample_count = int(shape[0])
    component_count = int(shape[1])
    require(sample_count > 0 and component_count > 0, f"{observable}.shape sample/component count must be positive")
    require(int(shape[2]) == node_count, f"{observable}.shape cell count must match metadata mesh nodes")
    with (source / "samples.csv").open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    require(rows, f"{observable} samples.csv must not be empty")
    require(
        len(rows) <= sample_count,
        f"{observable} samples.csv has {len(rows)} rows but shape declares {sample_count} samples",
    )
    value_count = node_count * component_count
    tile_count = repeat_x * repeat_y
    target.mkdir(parents=True, exist_ok=True)
    write_json(target / ".zattrs", attrs)
    target_array = copy.deepcopy(array)
    target_array["shape"] = [sample_count, component_count, node_count * tile_count]
    if isinstance(target_array.get("chunks"), list) and len(target_array["chunks"]) == 3:
        target_array["chunks"] = [1, component_count, node_count * tile_count]
    write_json(target / ".zarray", target_array)
    with (target / "samples.csv").open("w", newline="", encoding="utf-8") as handle:
        fieldnames = list(rows[-1].keys())
        if "chunk_key" not in fieldnames:
            fieldnames.append("chunk_key")
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row_index, source_row in enumerate(rows):
            chunk_key = source_row.get("chunk_key")
            require(isinstance(chunk_key, str) and chunk_key, f"{observable} chunk_key must be present")
            raw = (source / chunk_key).read_bytes()
            require(len(raw) == value_count * 8, f"{observable} chunk byte length mismatch")
            values = list(struct.unpack(f"<{value_count}d", raw))
            require(all(math.isfinite(value) for value in values), f"{observable} values must be finite")
            tiled_values: list[float] = []
            for component in range(component_count):
                block = values[component * node_count : (component + 1) * node_count]
                for _ in range(tile_count):
                    tiled_values.extend(block)
            row = {key: source_row.get(key, "") for key in fieldnames}
            row["chunk_key"] = chunk_key
            if "sample" in fieldnames:
                row["sample"] = source_row.get("sample") or str(row_index)
            if "cell_count" in fieldnames:
                row["cell_count"] = str(node_count * tile_count)
            writer.writerow(row)
            (target / chunk_key).write_bytes(struct.pack(f"<{len(tiled_values)}d", *tiled_values))


def tile_zarr_fields(unit_root: Path, output: Path, node_count: int, repeat_x: int, repeat_y: int) -> list[str]:
    fields_dir = unit_root / "fields"
    require(fields_dir.is_dir(), f"missing fields directory: {fields_dir}")
    copied: list[str] = []
    for field_dir in sorted(fields_dir.glob("*.zarr")):
        observable = field_dir.name.removesuffix(".zarr")
        tile_zarr_field(unit_root, output, observable, node_count, repeat_x, repeat_y)
        copied.append(observable)
    require("H_demag" in copied, "unit artifact must contain fields/H_demag.zarr")
    require("demag_phi" in copied, "unit artifact must contain fields/demag_phi.zarr")
    return copied


def update_metadata(
    metadata: dict[str, Any],
    *,
    nodes: list[list[float]],
    elements: list[list[int]],
    repeat_x: int,
    repeat_y: int,
    node_count: int,
    periods: list[float],
    tiled_markers: list[Any] | None,
) -> tuple[float, float]:
    periodic = require_object(metadata.get("periodic_antidot_relaxation"), "metadata.periodic_antidot_relaxation")
    universe = require_list(periodic.get("universe_size_m"), "metadata.periodic_antidot_relaxation.universe_size_m")
    require(len(universe) == 3, "metadata.periodic_antidot_relaxation.universe_size_m must be a 3-vector")
    periodic["universe_size_m"] = [periods[0] * repeat_x, periods[1] * repeat_y, finite_number(universe[2], "universe_size_m[2]")]
    periodic["supercell_repeat"] = [repeat_x, repeat_y]
    periodic["tiled_same_local_fixture"] = True

    mesh = backend_mesh(metadata)
    mesh["nodes"] = nodes
    mesh["elements"] = elements
    if tiled_markers is not None:
        mesh["element_markers"] = tiled_markers

    material = backend_material(metadata)
    if material is not None and isinstance(material.get("ms_field"), list):
        ms_field = require_list(material.get("ms_field"), "metadata material ms_field")
        require(len(ms_field) == node_count, "metadata material ms_field length must match unit node count")
        material["ms_field"] = tile_list(ms_field, repeat_x, repeat_y)

    return scale_final_energy_terms(metadata, repeat_x * repeat_y)


def write_central_cell_artifact(
    output: Path,
    *,
    node_count: int,
    magnetic_mask: list[bool],
    repeat_x: int,
    repeat_y: int,
    unit_e_demag: float,
    unit_torque: float,
) -> None:
    central_tile = (repeat_y // 2) * repeat_x + (repeat_x // 2)
    offset = central_tile * node_count
    magnetic_indices = [offset + index for index, is_magnetic in enumerate(magnetic_mask) if is_magnetic]
    field_indices = [offset + index for index in range(node_count)]
    write_json(
        output / "diagnostics" / "fem_static_pbc_supercell_central_cell.v1.json",
        {
            "schema_version": "fem_static_pbc_supercell_central_cell.v1",
            "artifact_path": "diagnostics/fem_static_pbc_supercell_central_cell.v1.json",
            "repeat_x": repeat_x,
            "repeat_y": repeat_y,
            "cell_count": repeat_x * repeat_y,
            "central_cell_index": [repeat_x // 2, repeat_y // 2],
            "magnetic_node_indices": magnetic_indices,
            "field_cell_indices": field_indices,
            "central_cell_demag_energy_j": unit_e_demag,
            "central_cell_torque_apm": unit_torque,
            "index_selection": {
                "method": "tiled_same_local_central_tile",
                "description": "Indices select the copied primitive mesh in the central tile; this is a comparator fixture, not a solved supercell.",
            },
            "scalar_selection": {
                "method": "copied_from_unit_artifact",
                "description": "Central-cell scalars are copied from the primitive artifact before extensive supercell energy scaling.",
            },
        },
    )


def write_fixture_provenance(output: Path, unit_cell: Path, repeat_x: int, repeat_y: int) -> None:
    write_json(
        output / "diagnostics" / "fem_static_pbc_tiled_supercell_fixture.v1.json",
        {
            "schema_version": "fem_static_pbc_tiled_supercell_fixture.v1",
            "unit_cell_artifacts": str(unit_cell),
            "repeat_x": repeat_x,
            "repeat_y": repeat_y,
            "status": "diagnostic_fixture",
            "acceptance_scope": "comparator and same-local artifact plumbing only",
            "not_a_runtime_solve": True,
        },
    )


def write_tiled_artifact(args: argparse.Namespace) -> Path:
    require(args.unit_cell.is_dir(), f"unit-cell artifact root must be a directory: {args.unit_cell}")
    require(args.unit_cell.resolve() != args.output.resolve(), "unit-cell and output artifact roots must be different")
    require(args.repeat_x > 0 and args.repeat_y > 0, "--repeat-x and --repeat-y must be positive")
    require(args.repeat_x * args.repeat_y > 1, "tiled supercell fixture requires repeat_x * repeat_y > 1")

    metadata = load_metadata(args.unit_cell)
    periodic = require_object(metadata.get("periodic_antidot_relaxation"), "metadata.periodic_antidot_relaxation")
    universe = require_list(periodic.get("universe_size_m"), "metadata.periodic_antidot_relaxation.universe_size_m")
    require(len(universe) == 3, "metadata.periodic_antidot_relaxation.universe_size_m must be a 3-vector")
    periods = [finite_number(universe[index], f"universe_size_m[{index}]") for index in range(3)]
    require(periods[0] > 0.0 and periods[1] > 0.0, "unit lateral universe_size_m values must be positive")

    mesh = backend_mesh(metadata)
    unit_nodes = parse_nodes(mesh)
    node_count = len(unit_nodes)
    unit_elements = parse_elements(mesh, node_count)
    magnetic_mask = load_node_geometry_mask(args.unit_cell, node_count) or magnetic_mask_from_metadata(mesh, node_count)
    m_payload = load_m_artifact(args.unit_cell, node_count, "m_final.json")
    initial_m_payload = (
        load_m_artifact(args.unit_cell, node_count, "m_initial.json")
        if (args.unit_cell / "m_initial.json").is_file()
        else None
    )

    tiled_nodes = tile_nodes(unit_nodes, args.repeat_x, args.repeat_y, periods)
    tiled_elements = tile_elements(unit_elements, node_count, args.repeat_x, args.repeat_y)
    tiled_markers = None
    if "element_markers" in mesh:
        tiled_markers = tile_list(require_list(mesh.get("element_markers"), "metadata mesh element_markers"), args.repeat_x, args.repeat_y)

    output_metadata = copy.deepcopy(metadata)
    unit_e_demag, unit_torque = update_metadata(
        output_metadata,
        nodes=tiled_nodes,
        elements=tiled_elements,
        repeat_x=args.repeat_x,
        repeat_y=args.repeat_y,
        node_count=node_count,
        periods=periods,
        tiled_markers=tiled_markers,
    )

    args.output.mkdir(parents=True, exist_ok=True)
    write_json(args.output / "metadata.json", output_metadata)
    m_payload = copy.deepcopy(m_payload)
    m_payload["values"] = tile_list(require_list(m_payload.get("values"), "m_final.values"), args.repeat_x, args.repeat_y)
    write_json(args.output / "m_final.json", m_payload)
    if initial_m_payload is not None:
        initial_m_payload = copy.deepcopy(initial_m_payload)
        initial_m_payload["values"] = tile_list(
            require_list(initial_m_payload.get("values"), "m_initial.values"),
            args.repeat_x,
            args.repeat_y,
        )
        write_json(args.output / "m_initial.json", initial_m_payload)

    copied_observables = tile_zarr_fields(args.unit_cell, args.output, node_count, args.repeat_x, args.repeat_y)
    write_node_geometry(
        args.output,
        nodes=tiled_nodes,
        magnetic_mask=tile_list(magnetic_mask, args.repeat_x, args.repeat_y),
        copied_observables=copied_observables,
    )
    write_central_cell_artifact(
        args.output,
        node_count=node_count,
        magnetic_mask=magnetic_mask,
        repeat_x=args.repeat_x,
        repeat_y=args.repeat_y,
        unit_e_demag=unit_e_demag,
        unit_torque=unit_torque,
    )
    write_fixture_provenance(args.output, args.unit_cell, args.repeat_x, args.repeat_y)
    return args.output


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--unit-cell", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repeat-x", type=int, required=True)
    parser.add_argument("--repeat-y", type=int, required=True)
    return parser.parse_args()


def main() -> int:
    try:
        output = write_tiled_artifact(parse_args())
    except Exception as exc:
        print(f"invalid FEM static PBC tiled supercell fixture: {exc}", file=sys.stderr)
        return 1
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
