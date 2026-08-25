from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from dataclasses import replace as _dc_replace
import math
import tempfile
from pathlib import Path
from typing import Any, Mapping

import numpy as np

from fullmag._progress import emit_progress, emit_progress_event
from fullmag.model.discretization import FDM, FEM, PerObjectMeshRecipe, SharedMeshAssemblyPolicy
from fullmag.model.domain_frame import geometry_bounds
from fullmag.model.geometry import (
    ArchWaveguide,
    Box,
    Cylinder,
    Difference,
    Ellipse,
    Ellipsoid,
    Geometry,
    ImportedGeometry,
    Intersection,
    Translate,
    Union,
)

from .gmsh_bridge import (
    ALGO_3D_DELAUNAY,
    ALGO_3D_FRONTAL,
    ALGO_3D_HXT,
    AirboxOptions,
    ComponentDescriptor,
    MeshData,
    MeshOptions,
    SharedDomainMeshResult,
    generate_mesh,
    generate_mesh_from_file,
    generate_shared_domain_mesh_from_components,
)
from ._gmsh_types import FEM_TOPOLOGY_VOLUME_EPS
from .surface_assets import _geometry_to_trimesh, _import_trimesh, build_surface_preview_payload
from .voxelization import VoxelMaskData, voxelize_geometry

# PR 2: target resolution extracted into _mesh_targets
from ._mesh_targets import (
    ResolvedAirboxTarget,
    ResolvedObjectPreviewTarget,
    ResolvedSharedDomainTargets,
    SharedDomainBuildReport,
    _unique_size_field_kinds,
    resolve_object_preview_target,
    resolve_shared_domain_targets,
)
from ._gmsh_extraction import build_per_domain_quality_from_mesh_arrays
from .mesh_build_report import _build_mesh_operation_statuses, _build_shared_domain_build_report
from ._mesh_targets import (
    _coerce_positive_float as _coerce_positive_float,
    _geometry_name_aliases as _geometry_name_aliases,
    _lookup_geometry_name_alias as _lookup_geometry_name_alias,
    _parse_per_geometry_overrides as _parse_per_geometry_overrides,
    _resolve_requested_partition_hmaxs as _mesh_targets_resolve_partition_hmaxs,
)

# PR 3: size-field planning extracted into _size_field_plan
from ._size_field_plan import (
    _NO_OP_FIELD_SIZE as _NO_OP_FIELD_SIZE,
    _build_field_stack as _build_field_stack,
    _build_interface_fields as _build_interface_fields,
    _build_manual_hotspot_fields as _build_manual_hotspot_fields,
    _build_object_bulk_fields as _build_object_bulk_fields,
    _build_transition_fields as _build_transition_fields,
    _legacy_box_size_fields,
    _mesh_options_from_runtime_metadata as _mesh_options_from_runtime_metadata,
    _resolve_per_object_mesh_options as _resolve_per_object_mesh_options,
)

_DEFAULT_AIRBOX_GROWTH_RATE = 1.3
_DEFAULT_AIRBOX_GRADING = "geometric"
_SIZE_DISTRIBUTION_HISTOGRAM_BINS = 30
_FROZEN_MAGNETIC_SUBMESH_MODE = "generated_frozen_magnetic_submesh"
_PREEMPTIVE_IMPORTED_STL_FALLBACK = "single_imported_stl_preemptive_fallback"
_SUPPORTED_DOMAIN_MESH_MODES = frozenset(
    {
        "generated_shared_domain_mesh",
        "explicit_shared_domain_mesh",
        _FROZEN_MAGNETIC_SUBMESH_MODE,
    }
)


def _is_stl_imported_geometry(geometry: Geometry) -> bool:
    return (
        isinstance(geometry, ImportedGeometry)
        and Path(geometry.source).suffix.lower() == ".stl"
    )


@dataclass(frozen=True, slots=True)
class FrozenMagneticSubmeshPayload:
    mesh: MeshData
    region_markers: list[dict[str, object]]
    interface_facet_ordinals: np.ndarray
    magnetic_submesh_signatures: list[dict[str, object]]


def _select_csr_items(
    types: np.ndarray,
    offsets: np.ndarray,
    nodes: np.ndarray,
    ordinals: np.ndarray,
    *,
    node_remap: dict[int, int] | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    selected_types = np.asarray(types[ordinals], dtype=np.str_)
    selected_offsets = [0]
    selected_nodes: list[int] = []
    for ordinal in ordinals:
        start = int(offsets[int(ordinal)])
        stop = int(offsets[int(ordinal) + 1])
        for node in nodes[start:stop]:
            node_id = int(node)
            selected_nodes.append(
                node_remap[node_id] if node_remap is not None else node_id
            )
        selected_offsets.append(len(selected_nodes))
    return (
        selected_types,
        np.asarray(selected_offsets, dtype=np.int64),
        np.asarray(selected_nodes, dtype=np.int32),
    )


def _domain_mesh_mode_from_workflow(mesh_workflow: Mapping[str, object] | None) -> str | None:
    if not isinstance(mesh_workflow, Mapping):
        return None
    mode = mesh_workflow.get("domain_mesh_mode")
    if mode is None:
        return None
    return str(mode).strip() or None


def _coerce_frozen_submesh_region_markers(raw: object) -> list[dict[str, object]]:
    if not isinstance(raw, list) or not raw:
        raise ValueError(
            "frozen_magnetic_submesh_source requires a non-empty region_markers list"
        )
    region_markers: list[dict[str, object]] = []
    seen_markers: set[int] = set()
    seen_names: set[str] = set()
    for index, entry in enumerate(raw):
        if not isinstance(entry, Mapping):
            raise ValueError(
                f"frozen_magnetic_submesh_source.region_markers[{index}] must be a mapping"
            )
        geometry_name = entry.get("geometry_name")
        marker = entry.get("marker")
        if not isinstance(geometry_name, str) or not geometry_name.strip():
            raise ValueError(
                f"frozen_magnetic_submesh_source.region_markers[{index}].geometry_name "
                "must be a non-empty string"
            )
        if not isinstance(marker, (int, np.integer)) or int(marker) <= 0:
            raise ValueError(
                f"frozen_magnetic_submesh_source.region_markers[{index}].marker "
                "must be a positive integer"
            )
        marker_int = int(marker)
        name = geometry_name.strip()
        if marker_int in seen_markers:
            raise ValueError(
                f"frozen_magnetic_submesh_source.region_markers duplicates marker {marker_int}"
            )
        if name in seen_names:
            raise ValueError(
                f"frozen_magnetic_submesh_source.region_markers duplicates geometry_name {name!r}"
            )
        seen_markers.add(marker_int)
        seen_names.add(name)
        region_markers.append({"geometry_name": name, "marker": marker_int})
    return region_markers


def _load_frozen_magnetic_submesh_source(raw_source: object) -> FrozenMagneticSubmeshPayload:
    if not isinstance(raw_source, Mapping):
        raise ValueError(
            "frozen_magnetic_submesh_source must be a mapping with mesh_source and region_markers"
        )
    mesh_source = raw_source.get("mesh_source")
    if not isinstance(mesh_source, str) or not mesh_source.strip():
        raise ValueError("frozen_magnetic_submesh_source.mesh_source must be a non-empty path")
    mesh = MeshData.load(Path(mesh_source).expanduser())
    mesh.validate_strict(require_positive_orientation=True)
    region_markers = _coerce_frozen_submesh_region_markers(raw_source.get("region_markers"))
    available_markers = {int(marker) for marker in np.unique(mesh.element_markers)}
    for entry in region_markers:
        marker = int(entry["marker"])
        if marker not in available_markers:
            raise ValueError(
                "frozen_magnetic_submesh_source.region_markers references marker "
                f"{marker}, but the frozen mesh element_markers are {sorted(available_markers)}"
            )
    report_path = Path(f"{Path(mesh_source).expanduser()}.report.json")
    if report_path.is_file():
        expected = _load_frozen_magnetic_submesh_invariants_report(report_path)
        candidate = _frozen_magnetic_submesh_invariants(mesh, region_markers)
        _assert_frozen_magnetic_submesh_invariants(
            expected,
            candidate,
            context=str(report_path),
        )
    interface_facet_ordinals = np.arange(mesh.n_boundary_faces, dtype=np.int64)
    if interface_facet_ordinals.size == 0:
        raise ValueError(
            "frozen_magnetic_submesh_source mesh must expose magnetic interface facets"
        )
    return FrozenMagneticSubmeshPayload(
        mesh=mesh,
        region_markers=region_markers,
        interface_facet_ordinals=interface_facet_ordinals,
        magnetic_submesh_signatures=_magnetic_submesh_signatures(mesh, region_markers),
    )


def _extract_frozen_magnetic_submesh(
    shared_mesh: MeshData,
    region_markers: list[dict[str, object]],
    *,
    geometry_name: str,
) -> FrozenMagneticSubmeshPayload:
    marker_entry = next(
        (
            entry
            for entry in region_markers
            if str(entry.get("geometry_name", "")).strip() == geometry_name
        ),
        None,
    )
    if marker_entry is None:
        raise ValueError(f"no region marker found for frozen magnetic geometry {geometry_name!r}")
    marker = marker_entry.get("marker")
    if not isinstance(marker, (int, np.integer)):
        raise ValueError(f"region marker for {geometry_name!r} must be an integer")
    marker_int = int(marker)
    magnetic_element_mask = np.asarray(shared_mesh.element_markers, dtype=np.int32) == marker_int
    if not np.any(magnetic_element_mask):
        raise ValueError(f"shared mesh contains no elements for magnetic marker {marker_int}")

    magnetic_ordinals = np.flatnonzero(magnetic_element_mask).astype(np.int64)
    used_nodes = np.unique(
        np.concatenate(
            [shared_mesh.cell_node_ids(int(index)) for index in magnetic_ordinals]
        )
    )
    node_remap = {int(node_id): index for index, node_id in enumerate(used_nodes)}
    cell_types, cell_offsets, cell_nodes = _select_csr_items(
        shared_mesh.cell_types,
        shared_mesh.cell_offsets,
        shared_mesh.cell_nodes,
        magnetic_ordinals,
        node_remap=node_remap,
    )

    interface_ordinals: list[int] = []
    for facet_ordinal, boundary_marker in enumerate(shared_mesh.boundary_markers):
        if int(boundary_marker) != 10:
            continue
        face = shared_mesh.facet_node_ids(facet_ordinal)
        if all(int(node_id) in node_remap for node_id in face):
            interface_ordinals.append(facet_ordinal)
    if not interface_ordinals:
        raise ValueError(
            f"shared mesh exposes no boundary/interface facets for magnetic marker {marker_int}"
        )
    selected_interface_ordinals = np.asarray(interface_ordinals, dtype=np.int64)
    facet_types, facet_offsets, facet_nodes = _select_csr_items(
        shared_mesh.facet_types,
        shared_mesh.facet_offsets,
        shared_mesh.facet_nodes,
        selected_interface_ordinals,
        node_remap=node_remap,
    )

    frozen_mesh = MeshData(
        nodes=np.asarray(shared_mesh.nodes[used_nodes], dtype=np.float64),
        cell_types=cell_types,
        cell_offsets=cell_offsets,
        cell_nodes=cell_nodes,
        cell_global_ordinals=shared_mesh.cell_global_ordinals[magnetic_ordinals],
        element_markers=np.full(len(magnetic_ordinals), marker_int, dtype=np.int32),
        facet_types=facet_types,
        facet_roles=shared_mesh.facet_roles[selected_interface_ordinals],
        facet_offsets=facet_offsets,
        facet_nodes=facet_nodes,
        boundary_markers=np.full(len(interface_ordinals), 10, dtype=np.int32),
        facet_global_ordinals=shared_mesh.facet_global_ordinals[selected_interface_ordinals],
        periodic_boundary_pairs=[
            dict(pair) for pair in shared_mesh.periodic_boundary_pairs
        ],
        periodic_node_pairs=_remap_periodic_node_pairs_by_used_nodes(
            shared_mesh.periodic_node_pairs,
            node_remap,
        ),
    )
    frozen_region_markers = [{"geometry_name": geometry_name, "marker": marker_int}]
    return FrozenMagneticSubmeshPayload(
        mesh=frozen_mesh,
        region_markers=frozen_region_markers,
        interface_facet_ordinals=np.arange(
            frozen_mesh.n_boundary_faces,
            dtype=np.int64,
        ),
        magnetic_submesh_signatures=_magnetic_submesh_signatures(
            frozen_mesh,
            frozen_region_markers,
        ),
    )


def _quantized_coordinate_key(
    coordinate: np.ndarray,
    *,
    coordinate_quantization_m: float = 1.0e-12,
) -> tuple[int, int, int]:
    return tuple(
        int(value)
        for value in np.round(np.asarray(coordinate, dtype=np.float64) / coordinate_quantization_m)
    )


def _remap_periodic_node_pairs(
    pairs: list[dict[str, object]],
    node_map: np.ndarray,
) -> list[dict[str, object]]:
    remapped: list[dict[str, object]] = []
    for pair in pairs:
        node_a = int(pair.get("node_a", -1))
        node_b = int(pair.get("node_b", -1))
        if node_a < 0 or node_a >= node_map.size or node_b < 0 or node_b >= node_map.size:
            raise ValueError("air mesh periodic_node_pairs contain invalid node indices")
        next_pair = dict(pair)
        next_pair["node_a"] = int(node_map[node_a])
        next_pair["node_b"] = int(node_map[node_b])
        if next_pair["node_a"] != next_pair["node_b"]:
            remapped.append(next_pair)
    return remapped


def _remap_periodic_node_pairs_by_used_nodes(
    pairs: list[dict[str, object]],
    node_remap: dict[int, int],
) -> list[dict[str, object]]:
    remapped: list[dict[str, object]] = []
    for pair in pairs:
        node_a = int(pair.get("node_a", -1))
        node_b = int(pair.get("node_b", -1))
        if node_a not in node_remap or node_b not in node_remap:
            continue
        next_pair = dict(pair)
        next_pair["node_a"] = int(node_remap[node_a])
        next_pair["node_b"] = int(node_remap[node_b])
        if next_pair["node_a"] != next_pair["node_b"]:
            remapped.append(next_pair)
    return remapped


def _merge_frozen_magnetic_submesh_with_air_mesh(
    frozen: FrozenMagneticSubmeshPayload,
    air_mesh: MeshData,
    *,
    coordinate_quantization_m: float = 1.0e-12,
) -> MeshData:
    magnetic_mesh = frozen.mesh
    frozen_nodes = np.asarray(magnetic_mesh.nodes, dtype=np.float64)
    merged_nodes: list[np.ndarray] = [np.array(node, copy=True) for node in frozen_nodes]
    coordinate_to_node: dict[tuple[int, int, int], int] = {
        _quantized_coordinate_key(node, coordinate_quantization_m=coordinate_quantization_m): index
        for index, node in enumerate(frozen_nodes)
    }
    air_node_map = np.empty(air_mesh.n_nodes, dtype=np.int32)
    for index, node in enumerate(np.asarray(air_mesh.nodes, dtype=np.float64)):
        key = _quantized_coordinate_key(
            node,
            coordinate_quantization_m=coordinate_quantization_m,
        )
        merged_index = coordinate_to_node.get(key)
        if merged_index is None:
            merged_index = len(merged_nodes)
            coordinate_to_node[key] = merged_index
            merged_nodes.append(np.array(node, copy=True))
        air_node_map[index] = int(merged_index)

    remapped_air_cell_nodes = air_node_map[air_mesh.cell_nodes]
    merged_cell_types = np.concatenate([magnetic_mesh.cell_types, air_mesh.cell_types])
    merged_cell_nodes = np.concatenate([magnetic_mesh.cell_nodes, remapped_air_cell_nodes])
    merged_cell_offsets = np.concatenate(
        [
            magnetic_mesh.cell_offsets,
            air_mesh.cell_offsets[1:] + len(magnetic_mesh.cell_nodes),
        ]
    )
    merged_element_markers = np.concatenate(
        [
            np.asarray(magnetic_mesh.element_markers, dtype=np.int32),
            np.zeros(air_mesh.n_elements, dtype=np.int32),
        ]
    )
    interface_face_keys = {
        tuple(sorted(int(node) for node in magnetic_mesh.facet_node_ids(int(ordinal))))
        for ordinal in frozen.interface_facet_ordinals
    }
    facet_types: list[str] = []
    facet_roles: list[str] = []
    facet_offsets = [0]
    facet_nodes: list[int] = []
    boundary_markers: list[int] = []
    for ordinal, marker in enumerate(air_mesh.boundary_markers):
        remapped_face = air_node_map[air_mesh.facet_node_ids(ordinal)]
        if tuple(sorted(int(node) for node in remapped_face)) in interface_face_keys:
            continue
        facet_types.append(str(air_mesh.facet_types[ordinal]))
        facet_roles.append(str(air_mesh.facet_roles[ordinal]))
        facet_nodes.extend(int(node) for node in remapped_face)
        facet_offsets.append(len(facet_nodes))
        boundary_markers.append(int(marker))

    # Preserve the shared magnetic-air interface as an explicit certified
    # boundary role.  It is not an exterior air face, but the planner needs
    # the physical interface marker to prove role disjointness and coverage.
    for ordinal in frozen.interface_facet_ordinals:
        facet_types.append(str(magnetic_mesh.facet_types[int(ordinal)]))
        facet_roles.append("material_interface")
        facet_nodes.extend(
            int(node) for node in magnetic_mesh.facet_node_ids(int(ordinal))
        )
        facet_offsets.append(len(facet_nodes))
        boundary_markers.append(10)

    periodic_boundary_pairs = [dict(pair) for pair in air_mesh.periodic_boundary_pairs]
    if not periodic_boundary_pairs:
        periodic_boundary_pairs = [
            dict(pair) for pair in magnetic_mesh.periodic_boundary_pairs
        ]
    periodic_node_pairs = [
        dict(pair) for pair in magnetic_mesh.periodic_node_pairs
    ]
    periodic_node_pairs.extend(
        _remap_periodic_node_pairs(
            air_mesh.periodic_node_pairs,
            air_node_map,
        )
    )

    return MeshData(
        nodes=np.asarray(merged_nodes, dtype=np.float64),
        cell_types=merged_cell_types,
        cell_offsets=merged_cell_offsets,
        cell_nodes=merged_cell_nodes,
        element_markers=merged_element_markers.astype(np.int32, copy=False),
        facet_types=facet_types,
        facet_roles=facet_roles,
        facet_offsets=facet_offsets,
        facet_nodes=facet_nodes,
        boundary_markers=np.asarray(boundary_markers, dtype=np.int32),
        cell_global_ordinals=np.arange(len(merged_cell_types), dtype=np.int64),
        facet_global_ordinals=np.arange(len(facet_types), dtype=np.int64),
        periodic_boundary_pairs=periodic_boundary_pairs,
        periodic_node_pairs=periodic_node_pairs,
    )


def _write_frozen_boundary_ascii_stl(mesh: MeshData, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="ascii") as handle:
        handle.write("solid frozen_magnetic_boundary\n")
        triangles: list[np.ndarray] = []
        for ordinal, facet_type in enumerate(mesh.facet_types):
            facet = mesh.facet_node_ids(ordinal)
            if facet_type == "tri3":
                triangles.append(facet)
            else:
                triangles.extend((facet[[0, 1, 2]], facet[[0, 2, 3]]))
        for face in triangles:
            v0, v1, v2 = np.asarray(mesh.nodes[face], dtype=np.float64)
            normal = np.cross(v1 - v0, v2 - v0)
            norm = float(np.linalg.norm(normal))
            if norm > 0.0:
                normal = normal / norm
            else:
                normal = np.zeros(3, dtype=np.float64)
            handle.write(
                f"  facet normal {normal[0]:.17g} {normal[1]:.17g} {normal[2]:.17g}\n"
            )
            handle.write("    outer loop\n")
            for vertex in (v0, v1, v2):
                handle.write(
                    f"      vertex {vertex[0]:.17g} {vertex[1]:.17g} {vertex[2]:.17g}\n"
                )
            handle.write("    endloop\n")
            handle.write("  endfacet\n")
        handle.write("endsolid frozen_magnetic_boundary\n")
    return path


def _airbox_with_clearance_for_frozen_surface(
    airbox: AirboxOptions,
    frozen_mesh: MeshData,
) -> AirboxOptions:
    if airbox.size is None or airbox.center is None or frozen_mesh.nodes.size == 0:
        return airbox

    size = np.asarray(airbox.size, dtype=np.float64)
    center = np.asarray(airbox.center, dtype=np.float64)
    air_min = center - size / 2.0
    air_max = center + size / 2.0
    frozen_nodes = np.asarray(frozen_mesh.nodes, dtype=np.float64)
    frozen_min = np.min(frozen_nodes, axis=0)
    frozen_max = np.max(frozen_nodes, axis=0)
    clearance = max(1.0e-12, float(np.max(size)) * 1.0e-6)

    adjusted = size.copy()
    for axis in range(3):
        touches_min = abs(float(frozen_min[axis] - air_min[axis])) <= clearance
        touches_max = abs(float(frozen_max[axis] - air_max[axis])) <= clearance
        if touches_min or touches_max:
            adjusted[axis] += 2.0 * clearance

    if np.array_equal(adjusted, size):
        return airbox
    return _dc_replace(airbox, size=tuple(float(value) for value in adjusted))


def _points_inside_tetra_mesh(points: np.ndarray, mesh: MeshData) -> np.ndarray:
    points = np.asarray(points, dtype=np.float64)
    inside = np.zeros(points.shape[0], dtype=bool)
    if points.size == 0 or mesh.n_elements == 0:
        return inside

    nodes = np.asarray(mesh.nodes, dtype=np.float64)
    elements = np.asarray(mesh.elements, dtype=np.int32)
    barycentric_tol = 1.0e-9
    spatial_tol = max(1.0e-15, float(np.max(np.ptp(nodes, axis=0))) * 1.0e-10)

    for element in elements:
        tetra = nodes[element]
        bbox_min = np.min(tetra, axis=0) - spatial_tol
        bbox_max = np.max(tetra, axis=0) + spatial_tol
        candidates = np.nonzero(
            (~inside)
            & np.all(points >= bbox_min.reshape(1, 3), axis=1)
            & np.all(points <= bbox_max.reshape(1, 3), axis=1)
        )[0]
        if candidates.size == 0:
            continue
        matrix = np.column_stack(
            (
                tetra[1] - tetra[0],
                tetra[2] - tetra[0],
                tetra[3] - tetra[0],
            )
        )
        try:
            inverse = np.linalg.inv(matrix)
        except np.linalg.LinAlgError:
            continue
        bary = (points[candidates] - tetra[0].reshape(1, 3)) @ inverse.T
        candidate_inside = (
            np.all(bary >= -barycentric_tol, axis=1)
            & (np.sum(bary, axis=1) <= 1.0 + barycentric_tol)
        )
        inside[candidates[candidate_inside]] = True
    return inside


def _points_strictly_inside_tetra_mesh(points: np.ndarray, mesh: MeshData) -> np.ndarray:
    points = np.asarray(points, dtype=np.float64)
    inside = np.zeros(points.shape[0], dtype=bool)
    if points.size == 0 or mesh.n_elements == 0:
        return inside

    nodes = np.asarray(mesh.nodes, dtype=np.float64)
    elements = np.asarray(mesh.elements, dtype=np.int32)
    barycentric_tol = 1.0e-9
    spatial_tol = max(1.0e-15, float(np.max(np.ptp(nodes, axis=0))) * 1.0e-10)

    for element in elements:
        tetra = nodes[element]
        bbox_min = np.min(tetra, axis=0) + spatial_tol
        bbox_max = np.max(tetra, axis=0) - spatial_tol
        candidates = np.nonzero(
            (~inside)
            & np.all(points > bbox_min.reshape(1, 3), axis=1)
            & np.all(points < bbox_max.reshape(1, 3), axis=1)
        )[0]
        if candidates.size == 0:
            continue
        matrix = np.column_stack(
            (
                tetra[1] - tetra[0],
                tetra[2] - tetra[0],
                tetra[3] - tetra[0],
            )
        )
        try:
            inverse = np.linalg.inv(matrix)
        except np.linalg.LinAlgError:
            continue
        bary = (points[candidates] - tetra[0].reshape(1, 3)) @ inverse.T
        candidate_inside = (
            np.all(bary > barycentric_tol, axis=1)
            & (np.sum(bary, axis=1) < 1.0 - barycentric_tol)
        )
        inside[candidates[candidate_inside]] = True
    return inside


def _air_element_mask_outside_frozen_magnetic_submesh(
    generated: MeshData,
    frozen: FrozenMagneticSubmeshPayload,
) -> np.ndarray:
    marker_mask = np.asarray(generated.element_markers, dtype=np.int32) == 0
    if not np.any(marker_mask):
        return marker_mask
    elements = np.asarray(generated.elements, dtype=np.int32)
    element_nodes = np.asarray(generated.nodes, dtype=np.float64)[elements]
    centroids = np.mean(element_nodes, axis=1)
    inside_frozen = _points_inside_tetra_mesh(centroids[marker_mask], frozen.mesh)
    strictly_inside_vertex = _points_strictly_inside_tetra_mesh(
        element_nodes[marker_mask].reshape(-1, 3),
        frozen.mesh,
    ).reshape(-1, 4)
    keep = marker_mask.copy()
    keep[np.nonzero(marker_mask)[0][inside_frozen | np.any(strictly_inside_vertex, axis=1)]] = False
    return keep


def _boundary_faces_for_kept_elements(
    mesh: MeshData,
    element_mask: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    elements = np.asarray(mesh.elements, dtype=np.int32)[np.asarray(element_mask, dtype=bool)]
    if elements.size == 0 or mesh.boundary_faces.size == 0:
        return (
            np.empty((0, 3), dtype=np.int32),
            np.empty((0,), dtype=np.int32),
        )
    kept_faces: set[tuple[int, int, int]] = set()
    for a, b, c, d in elements:
        kept_faces.add(tuple(sorted((int(a), int(b), int(c)))))
        kept_faces.add(tuple(sorted((int(a), int(b), int(d)))))
        kept_faces.add(tuple(sorted((int(a), int(c), int(d)))))
        kept_faces.add(tuple(sorted((int(b), int(c), int(d)))))
    boundary_keep = np.asarray(
        [
            tuple(sorted(int(node_id) for node_id in face)) in kept_faces
            for face in np.asarray(mesh.boundary_faces, dtype=np.int32)
        ],
        dtype=bool,
    )
    return (
        np.asarray(mesh.boundary_faces[boundary_keep], dtype=np.int32),
        np.asarray(mesh.boundary_markers[boundary_keep], dtype=np.int32),
    )


def _validate_domain_mesh_workflow(
    mesh_workflow: Mapping[str, object] | None,
) -> FrozenMagneticSubmeshPayload | None:
    mode = _domain_mesh_mode_from_workflow(mesh_workflow)
    if mode is None:
        return None
    if mode not in _SUPPORTED_DOMAIN_MESH_MODES:
        supported = ", ".join(sorted(_SUPPORTED_DOMAIN_MESH_MODES))
        raise ValueError(f"unknown domain_mesh_mode '{mode}'; expected one of: {supported}")
    if mode != _FROZEN_MAGNETIC_SUBMESH_MODE:
        return None
    assert isinstance(mesh_workflow, Mapping)
    if not mesh_workflow.get("frozen_magnetic_submesh_source"):
        raise ValueError(
            "generated_frozen_magnetic_submesh requires frozen_magnetic_submesh_source "
            "so the magnetic MeshData and region markers cannot be silently regenerated"
        )
    return _load_frozen_magnetic_submesh_source(
        mesh_workflow.get("frozen_magnetic_submesh_source")
    )


def _validate_declared_mesh_operations(
    mesh_workflow: Mapping[str, object] | None,
) -> None:
    """Reject authored operations that have no realized shared-mesh executor.

    Operations are part of the public authoring contract, but the shared-domain
    pipeline currently realizes sizing/algorithm options rather than a mutable
    post-mesh operation sequence.  Accepting these records would silently turn
    ``refine``, ``smooth`` or ``optimize`` into no-ops, so fail closed before any
    mesh or artifact is created.
    """
    if not isinstance(mesh_workflow, Mapping):
        return

    declared: list[tuple[str, str]] = []

    def collect(raw: object, scope: str) -> None:
        if raw is None:
            return
        if not isinstance(raw, list):
            raise ValueError(
                f"mesh operation executor unavailable: operations for scope {scope!r} "
                "must be a list"
            )
        for index, entry in enumerate(raw):
            if not isinstance(entry, Mapping):
                raise ValueError(
                    "mesh operation executor unavailable: operation entry "
                    f"{scope!r}[{index}] must be an object"
                )
            kind = entry.get("kind")
            if not isinstance(kind, str) or not kind.strip():
                raise ValueError(
                    "mesh operation executor unavailable: operation kind must be a non-empty string"
                )
            entry_scope = entry.get("geometry")
            declared.append(
                (
                    str(entry_scope).strip()
                    if isinstance(entry_scope, str) and entry_scope.strip()
                    else scope,
                    kind.strip(),
                )
            )

    collect(mesh_workflow.get("operations"), "global")
    collect(
        mesh_workflow.get("default_mesh", {}).get("operations")
        if isinstance(mesh_workflow.get("default_mesh"), Mapping)
        else None,
        "global",
    )
    raw_per_geometry = mesh_workflow.get("per_geometry")
    if isinstance(raw_per_geometry, list):
        for entry in raw_per_geometry:
            if not isinstance(entry, Mapping):
                continue
            scope = str(entry.get("geometry") or "<unknown>")
            collect(entry.get("operations"), scope)
    elif raw_per_geometry is not None:
        raise ValueError(
            "mesh operation executor unavailable: per_geometry must be a list"
        )

    if declared:
        scope, kind = declared[0]
        raise ValueError(
            "mesh operation executor unavailable: "
            f"kind={kind!r} scope={scope!r}; shared-domain realization has no "
            "validated executor for authored operations"
        )


def _validate_per_object_recipe_operations(
    per_object_recipes: Mapping[str, PerObjectMeshRecipe] | None,
) -> None:
    """Reject operation sequences authored directly on object recipes."""
    if not isinstance(per_object_recipes, Mapping):
        return

    for geometry_name, recipe in per_object_recipes.items():
        operations = getattr(recipe, "operations", None)
        if operations is None:
            continue
        if not isinstance(operations, list):
            raise ValueError(
                "mesh operation executor unavailable: operations for scope "
                f"{geometry_name!r} must be a list"
            )
        for index, operation in enumerate(operations):
            kind = (
                operation.get("kind")
                if isinstance(operation, Mapping)
                else getattr(operation, "kind", None)
            )
            if not isinstance(kind, str) or not kind.strip():
                raise ValueError(
                    "mesh operation executor unavailable: operation kind for "
                    f"scope {geometry_name!r}[{index}] must be a non-empty string"
                )
            raise ValueError(
                "mesh operation executor unavailable: "
                f"kind={kind.strip()!r} scope={str(geometry_name).strip()!r}; "
                "shared-domain realization has no validated executor for authored operations"
            )


def _frozen_magnetic_submesh_air_mesh_source(
    mesh_workflow: Mapping[str, object] | None,
) -> str | None:
    if not isinstance(mesh_workflow, Mapping):
        return None
    raw_source = mesh_workflow.get("frozen_magnetic_submesh_source")
    if not isinstance(raw_source, Mapping):
        return None
    air_mesh_source = raw_source.get("air_mesh_source")
    if not isinstance(air_mesh_source, str) or not air_mesh_source.strip():
        return None
    return air_mesh_source.strip()


def _generate_air_mesh_for_frozen_magnetic_submesh(
    *,
    frozen: FrozenMagneticSubmeshPayload,
    geometries: list[Geometry],
    hints: FEM,
    airbox: AirboxOptions,
    mesh_workflow: Mapping[str, object] | None,
    per_object_recipes: dict[str, PerObjectMeshRecipe] | None,
    object_regions: list[dict[str, object]] | None,
) -> MeshData:
    del per_object_recipes, object_regions
    with tempfile.TemporaryDirectory(prefix="fullmag-frozen-air-mesh-") as tmp_dir:
        frozen_surface_path = Path(tmp_dir) / "frozen_magnetic_boundary.stl"
        _write_frozen_boundary_ascii_stl(frozen.mesh, frozen_surface_path)
        mesh_options = _mesh_options_from_runtime_metadata(
            mesh_workflow,
            geometries=geometries,
            default_hmax=_shared_domain_size_field_default_hmax(hints, airbox),
            bounds_by_name=None,
            include_size_fields=False,
        )
        generated = generate_mesh_from_file(
            frozen_surface_path,
            hmax=float(hints.hmax),
            order=int(hints.order),
            airbox=_airbox_with_clearance_for_frozen_surface(airbox, frozen.mesh),
            options=mesh_options,
            provisional_interface_markers={10},
        )
    air_mask = _air_element_mask_outside_frozen_magnetic_submesh(generated, frozen)
    if not np.any(air_mask):
        raise ValueError(
            "generated_frozen_magnetic_submesh air generator produced no air tetrahedra"
        )
    boundary_faces, boundary_markers = _boundary_faces_for_kept_elements(generated, air_mask)
    kept_air_nodes = {
        int(node_id)
        for node_id in np.asarray(generated.elements[air_mask], dtype=np.int32).reshape(-1)
    }
    periodic_node_pairs = _remap_periodic_node_pairs_by_used_nodes(
        generated.periodic_node_pairs,
        {node_id: node_id for node_id in kept_air_nodes},
    )
    retained_pair_ids = {str(pair.get("pair_id")) for pair in periodic_node_pairs}
    return MeshData.from_legacy_tet4(
        nodes=np.asarray(generated.nodes, dtype=np.float64),
        elements=np.asarray(generated.elements[air_mask], dtype=np.int32),
        element_markers=np.zeros(int(np.count_nonzero(air_mask)), dtype=np.int32),
        boundary_faces=boundary_faces,
        boundary_markers=boundary_markers,
        periodic_boundary_pairs=[
            dict(pair)
            for pair in generated.periodic_boundary_pairs
            if str(pair.get("pair_id")) in retained_pair_ids
        ],
        periodic_node_pairs=periodic_node_pairs,
        quality=generated.quality,
        per_domain_quality=generated.per_domain_quality,
    )


def _drop_degenerate_tetrahedra(
    mesh: MeshData,
    *,
    context: str,
    fallbacks_triggered: list[str],
) -> MeshData:
    if mesh.n_elements == 0:
        return mesh
    tetra_ordinals = np.flatnonzero(mesh.cell_types == "tet4")
    if tetra_ordinals.size == 0:
        mesh.validate_strict(require_positive_orientation=True)
        return mesh
    tetra_nodes = np.asarray(
        [mesh.cell_node_ids(int(index)) for index in tetra_ordinals],
        dtype=np.int32,
    )
    p0 = mesh.nodes[tetra_nodes[:, 0]]
    p1 = mesh.nodes[tetra_nodes[:, 1]]
    p2 = mesh.nodes[tetra_nodes[:, 2]]
    p3 = mesh.nodes[tetra_nodes[:, 3]]
    volumes = (
        np.linalg.det(np.stack([p1 - p0, p2 - p0, p3 - p0], axis=2))
        / 6.0
    )
    bbox = np.ptp(mesh.nodes, axis=0) if mesh.nodes.size else np.zeros(3, dtype=np.float64)
    scale = float(np.max(bbox))
    eps = max(
        np.finfo(np.float64).tiny,
        FEM_TOPOLOGY_VOLUME_EPS,
        (scale if scale > 0.0 else 1.0) ** 3 * 1e-18,
    )
    keep_tetrahedra = np.abs(volumes) > eps
    removed = int(np.count_nonzero(~keep_tetrahedra))
    if removed == 0:
        if tetra_ordinals.size != mesh.n_elements:
            mesh.validate_strict(require_positive_orientation=True)
        return mesh
    if tetra_ordinals.size != mesh.n_elements:
        raise ValueError(
            "tetrahedral degenerate-cell cleanup is unavailable for mixed topology; "
            f"found {removed} degenerate tet4 cells"
        )
    keep = keep_tetrahedra
    if removed == mesh.n_elements:
        raise ValueError(f"{context} produced only degenerate tetrahedra")
    marker = "shared_domain_degenerate_tetra_cleanup"
    if marker not in fallbacks_triggered:
        fallbacks_triggered.append(marker)
    emit_progress(
        f"{context}: removed {removed} degenerate tetrahedra below strict volume threshold"
    )
    boundary_faces, boundary_markers = _boundary_faces_for_kept_elements(mesh, keep)
    return MeshData.from_legacy_tet4(
        nodes=mesh.nodes,
        elements=mesh.elements[keep],
        element_markers=mesh.element_markers[keep],
        boundary_faces=boundary_faces,
        boundary_markers=boundary_markers,
        periodic_boundary_pairs=mesh.periodic_boundary_pairs,
        periodic_node_pairs=mesh.periodic_node_pairs,
        quality=mesh.quality,
        per_domain_quality=None,
    )


def _conformal_occ_degenerate_retry(
    options: MeshOptions,
    attempted_algorithms: set[int],
) -> tuple[int, str, str] | None:
    algorithm_3d = int(options.algorithm_3d)
    if int(algorithm_3d) == ALGO_3D_HXT:
        if ALGO_3D_DELAUNAY in attempted_algorithms:
            return (
                ALGO_3D_FRONTAL,
                "Conformal OCC mesh: HXT produced a degenerate thin-film tetra "
                "after Delaunay was already attempted; retrying with Frontal",
                "conformal_occ_hxt_degenerate_retry_frontal",
            )
        return (
            ALGO_3D_DELAUNAY,
            "Conformal OCC mesh: HXT produced a degenerate thin-film tetra; "
            "retrying with Delaunay",
            "conformal_occ_hxt_degenerate_retry_delaunay",
        )
    if int(algorithm_3d) == ALGO_3D_DELAUNAY:
        if options.size_fields and ALGO_3D_HXT not in attempted_algorithms:
            return (
                ALGO_3D_HXT,
                "Conformal OCC mesh: Delaunay produced a degenerate thin-film tetra "
                "with active size fields; retrying with HXT",
                "conformal_occ_delaunay_degenerate_retry_hxt",
            )
        return (
            ALGO_3D_FRONTAL,
            "Conformal OCC mesh: Delaunay produced a degenerate thin-film tetra; "
            "retrying with Frontal",
            "conformal_occ_delaunay_degenerate_retry_frontal",
        )
    return None


def _execution_mesh_volume_epsilon(mesh: MeshData) -> float:
    """Return the strict volume threshold used by the Rust mesh contract.

    The native validator scales its absolute tetra-volume threshold from the
    largest domain span.  Running the same check before publishing a Python
    generated mesh keeps OCC retry decisions consistent with execution-time
    validation instead of accepting a locally non-degenerate sliver.
    """
    if mesh.nodes.size == 0:
        return 1.0e-18
    bbox_scale = float(np.max(np.ptp(mesh.nodes, axis=0)))
    scale = bbox_scale if bbox_scale > 0.0 else 1.0
    return max(np.finfo(np.float64).tiny, scale**3 * 1.0e-18)


def _conformal_occ_algorithm_name(algorithm_3d: int) -> str:
    return {
        ALGO_3D_DELAUNAY: "Delaunay",
        ALGO_3D_FRONTAL: "Frontal",
        ALGO_3D_HXT: "HXT",
    }.get(int(algorithm_3d), f"algorithm_3d={int(algorithm_3d)}")


def _surface_trimesh_kwargs_from_mesh_options(opts: MeshOptions) -> dict[str, object]:
    return {
        "through_thickness_elements": opts.through_thickness_elements,
        "through_thickness_distribution": opts.through_thickness_distribution,
        "through_thickness_element_ratio": opts.through_thickness_element_ratio,
        "through_thickness_symmetric": opts.through_thickness_symmetric,
    }


def _surface_trimesh_kwargs_for_geometry(
    geometry: Geometry,
    base_kwargs: Mapping[str, object],
    mesh_workflow: Mapping[str, object] | None,
) -> dict[str, object]:
    kwargs = dict(base_kwargs)
    per_geometry = (
        mesh_workflow.get("per_geometry")
        if isinstance(mesh_workflow, Mapping)
        else None
    )
    overrides = _parse_per_geometry_overrides(per_geometry)
    entry = _lookup_geometry_name_alias(overrides, geometry.geometry_name)
    if isinstance(entry, Mapping):
        surface_hmax = _coerce_positive_float(
            entry.get("surface_maximum_element_size")
            or entry.get("surface_hmax")
        )
        if surface_hmax is not None:
            kwargs["surface_maximum_element_size"] = surface_hmax
    return kwargs


def _sanitize_surface_mesh_for_stl_export(surface: object) -> object:
    mesh = surface.copy() if hasattr(surface, "copy") else surface
    if hasattr(mesh, "remove_unreferenced_vertices"):
        mesh.remove_unreferenced_vertices()
    if hasattr(mesh, "merge_vertices"):
        mesh.merge_vertices(digits_vertex=15)

    faces = getattr(mesh, "faces", None)
    if faces is None:
        return mesh
    face_array = np.asarray(faces)
    if face_array.ndim != 2 or face_array.shape[1] < 3 or face_array.shape[0] == 0:
        return mesh

    triangle_faces = face_array[:, :3]
    nondegenerate = np.array(
        [len(set(int(node) for node in face)) == 3 for face in triangle_faces],
        dtype=bool,
    )
    if np.any(nondegenerate):
        canonical = np.sort(triangle_faces[nondegenerate], axis=1)
        _, unique_offsets = np.unique(canonical, axis=0, return_index=True)
        nondegenerate_indices = np.flatnonzero(nondegenerate)
        keep_indices = nondegenerate_indices[np.sort(unique_offsets)]
    else:
        keep_indices = np.asarray([], dtype=np.int64)

    if keep_indices.shape[0] != face_array.shape[0]:
        if hasattr(mesh, "update_faces"):
            mesh.update_faces(keep_indices)
        else:
            mesh.faces = face_array[keep_indices]
        if hasattr(mesh, "remove_unreferenced_vertices"):
            mesh.remove_unreferenced_vertices()

    return mesh


def _surface_preview_to_mesh_data(preview: dict[str, object]) -> MeshData:
    nodes = np.asarray(preview.get("nodes", []), dtype=np.float64)
    if nodes.ndim != 2 or nodes.shape[1] != 3:
        raise ValueError("surface preview nodes must have shape (N, 3)")
    return MeshData(
        nodes=nodes,
        cell_types=preview.get("cell_types", []),
        cell_offsets=preview.get("cell_offsets", [0]),
        cell_nodes=preview.get("cell_nodes", []),
        element_markers=np.zeros((0,), dtype=np.int32),
        facet_types=preview.get("facet_types", []),
        facet_roles=preview.get("facet_roles", []),
        facet_offsets=preview.get("facet_offsets", [0]),
        facet_nodes=preview.get("facet_nodes", []),
        boundary_markers=np.ones(
            (len(preview.get("facet_types", [])),),
            dtype=np.int32,
        ),
        cell_global_ordinals=np.arange(len(preview.get("cell_types", [])), dtype=np.int64),
        facet_global_ordinals=np.arange(len(preview.get("facet_types", [])), dtype=np.int64),
    )


def realize_fem_mesh_asset(
    geometry: Geometry,
    hints: FEM,
    *,
    study_universe: Mapping[str, object] | None = None,
    mesh_workflow: Mapping[str, object] | None = None,
    per_object_recipes: dict[str, PerObjectMeshRecipe] | None = None,
) -> MeshData:
    """Resolve a FEM mesh asset from either a prebuilt mesh or geometry source.

    The effective ``hmax`` and ``order`` are determined by
    :func:`resolve_object_preview_target` which implements the standard
    precedence chain: recipe > per_geometry > default_mesh > FEM.
    """
    _ = study_universe  # reserved for future airbox-aware preview

    target = resolve_object_preview_target(
        geometry, hints,
        mesh_workflow=mesh_workflow,
        per_object_recipes=per_object_recipes,
    )
    mesh_options = _mesh_options_from_runtime_metadata(
        mesh_workflow,
        geometries=[geometry],
        default_hmax=target.hmax,
        per_object_recipes=per_object_recipes,
    )

    preview = build_surface_preview_payload(geometry)
    if preview is not None:
        emit_progress_event(
            {
                "kind": "fem_surface_preview",
                "geometry_name": geometry.geometry_name,
                "fem_mesh": preview,
                "is_preview": True,
                "message": (
                    f"Surface preview ready for '{geometry.geometry_name}': "
                    f"{len(preview['nodes'])} vertices, {len(preview['facet_types'])} faces"
                ),
            }
        )

    surface_only = (
        hints.mesh is None
        and isinstance(geometry, ImportedGeometry)
        and geometry.volume == "surface"
    )
    if surface_only:
        if preview is None:
            raise ValueError(
                f"ImportedGeometry(volume='surface') for '{geometry.geometry_name}' "
                "requires a readable surface source preview. "
                "Currently this preview path is supported for STL-backed imports."
            )
        raise ValueError(
            f"ImportedGeometry(volume='surface') for '{geometry.geometry_name}' is a "
            "surface_preview_mesh with solver_eligible=False. The FEM solver requires "
            "tetrahedral volume elements; use volume='full' for executable meshing."
        )

    if hints.mesh is not None:
        emit_progress(f"Resolving FEM mesh from source '{hints.mesh}'")
        mesh = generate_mesh_from_file(hints.mesh, hmax=target.hmax, order=target.order)
    else:
        emit_progress(
            f"Generating FEM mesh from geometry '{geometry.geometry_name}' "
            f"with maximum_element_size={target.hmax:.4e} (source={target.source})"
        )
        mesh = generate_mesh(
            geometry,
            hmax=target.hmax,
            order=target.order,
            options=mesh_options,
        )

    if mesh.n_elements == 0:
        raise ValueError(
            f"FEM mesh for '{geometry.geometry_name}' contains 0 tetrahedral elements. "
            "The geometry surface may not be watertight or manifold. "
            "Try repairing the STL in a mesh tool like MeshLab or reducing hmax."
        )

    return mesh


def _split_outer_translation(
    geometry: Geometry,
) -> tuple[Geometry, tuple[float, float, float]]:
    translation = np.zeros(3, dtype=np.float64)
    current: Geometry = geometry
    while isinstance(current, Translate):
        translation += np.asarray(current.offset, dtype=np.float64)
        current = current.geometry
    return current, (float(translation[0]), float(translation[1]), float(translation[2]))


def _optional_vec3(
    value: object,
) -> tuple[float, float, float] | None:
    if value is None:
        return None
    if isinstance(value, np.ndarray):
        array = np.asarray(value, dtype=np.float64)
    else:
        try:
            array = np.asarray(tuple(value), dtype=np.float64)  # type: ignore[arg-type]
        except TypeError:
            return None
    if array.shape != (3,) or np.any(~np.isfinite(array)):
        return None
    return (float(array[0]), float(array[1]), float(array[2]))


def _cells_from_size(
    size: tuple[float, float, float],
    cell_size: tuple[float, float, float],
) -> tuple[int, int, int]:
    return tuple(
        max(1, int(math.ceil(size[axis] / cell_size[axis] - 1e-12)))
        for axis in range(3)
    )


def _expand_mask_to_domain(
    tight: VoxelMaskData,
    *,
    domain_origin: tuple[float, float, float],
    domain_cells: tuple[int, int, int],
) -> VoxelMaskData:
    cell = np.asarray(tight.cell_size, dtype=np.float64)
    tight_origin = np.asarray(tight.origin, dtype=np.float64)
    domain_origin_vec = np.asarray(domain_origin, dtype=np.float64)
    tight_cells_xyz = np.asarray((tight.shape[2], tight.shape[1], tight.shape[0]), dtype=int)
    domain_cells_xyz = np.asarray(domain_cells, dtype=int)

    delta = (tight_origin - domain_origin_vec) / cell
    start_xyz = np.rint(delta).astype(int)
    if np.any(start_xyz < 0) or np.any(start_xyz + tight_cells_xyz > domain_cells_xyz):
        raise ValueError(
            "study universe is smaller than the realized FDM geometry extent; "
            "increase the universe size or switch back to auto mode"
        )
    actual_origin = tight_origin - start_xyz.astype(np.float64) * cell

    target = np.zeros(
        (int(domain_cells_xyz[2]), int(domain_cells_xyz[1]), int(domain_cells_xyz[0])),
        dtype=np.bool_,
    )
    sx, sy, sz = int(start_xyz[0]), int(start_xyz[1]), int(start_xyz[2])
    nx, ny, nz = int(tight_cells_xyz[0]), int(tight_cells_xyz[1]), int(tight_cells_xyz[2])
    target[sz : sz + nz, sy : sy + ny, sx : sx + nx] = tight.mask
    return VoxelMaskData(
        mask=target,
        cell_size=tight.cell_size,
        origin=(float(actual_origin[0]), float(actual_origin[1]), float(actual_origin[2])),
    )


def _apply_study_universe_to_fdm_asset(
    tight: VoxelMaskData,
    *,
    translation: tuple[float, float, float],
    study_universe: Mapping[str, object] | None,
) -> VoxelMaskData:
    # ``voxelize_geometry`` operates in the base object's frame after the
    # outer ``Translate`` chain has been peeled off.  The returned asset,
    # however, is consumed in the Cartesian/domain frame.  Keep the
    # translation in the origin before expanding into a manually declared
    # airbox; shifting the airbox origin by the opposite amount would leave
    # the active mask at the un-translated location.
    translation_vec = np.asarray(translation, dtype=np.float64)
    translated = VoxelMaskData(
        mask=tight.mask,
        cell_size=tight.cell_size,
        origin=tuple(
            float(tight.origin[axis] + translation_vec[axis])
            for axis in range(3)
        ),
    )
    if not study_universe:
        return translated

    mode = study_universe.get("mode")
    resolved_mode = str(mode) if isinstance(mode, str) else "auto"
    padding = _optional_vec3(study_universe.get("padding")) or (0.0, 0.0, 0.0)
    cell = translated.cell_size
    tight_cells = (translated.shape[2], translated.shape[1], translated.shape[0])
    tight_size = tuple(float(tight_cells[axis] * cell[axis]) for axis in range(3))

    if resolved_mode == "manual":
        declared_size = _optional_vec3(study_universe.get("size"))
        if declared_size is None:
            return tight
        center = _optional_vec3(study_universe.get("center")) or (0.0, 0.0, 0.0)
        domain_cells = _cells_from_size(declared_size, cell)
        realized_size = tuple(float(domain_cells[axis] * cell[axis]) for axis in range(3))
        domain_origin = tuple(
            float(center[axis] - realized_size[axis] * 0.5)
            for axis in range(3)
        )
        return _expand_mask_to_domain(
            translated,
            domain_origin=domain_origin,
            domain_cells=domain_cells,
        )

    if any(component > 0.0 for component in padding):
        tight_center = tuple(
            float(translated.origin[axis] + tight_size[axis] * 0.5)
            for axis in range(3)
        )
        padded_size = tuple(
            float(tight_size[axis] + 2.0 * padding[axis])
            for axis in range(3)
        )
        domain_cells = _cells_from_size(padded_size, cell)
        realized_size = tuple(float(domain_cells[axis] * cell[axis]) for axis in range(3))
        domain_origin = tuple(
            float(tight_center[axis] - realized_size[axis] * 0.5)
            for axis in range(3)
        )
        return _expand_mask_to_domain(
            translated,
            domain_origin=domain_origin,
            domain_cells=domain_cells,
        )

    return translated


def _validate_explicit_airbox_contains_geometry_bounds(
    geometries: list[Geometry],
    *,
    size: tuple[float, float, float],
    center: tuple[float, float, float],
) -> None:
    bounds = [
        geometry_bounds(geometry, source_root=None)
        for geometry in geometries
    ]
    valid_bounds = [item for item in bounds if item[0] is not None and item[1] is not None]
    if not valid_bounds:
        return

    object_min = np.asarray([item[0] for item in valid_bounds], dtype=np.float64).min(axis=0)
    object_max = np.asarray([item[1] for item in valid_bounds], dtype=np.float64).max(axis=0)
    airbox_center = np.asarray(center, dtype=np.float64)
    airbox_half_size = np.asarray(size, dtype=np.float64) * 0.5
    airbox_min = airbox_center - airbox_half_size
    airbox_max = airbox_center + airbox_half_size
    tolerance = max(float(np.max(np.abs(object_max - object_min))), float(np.max(np.abs(size))), 1.0) * 1e-12

    axis_names = ("x", "y", "z")
    for axis, axis_name in enumerate(axis_names):
        if object_min[axis] < airbox_min[axis] - tolerance or object_max[axis] > airbox_max[axis] + tolerance:
            raise ValueError(
                "study_universe.size does not contain geometry bounds on "
                f"axis {axis_name}: airbox "
                f"{_format_length_m(float(airbox_min[axis]))} -> {_format_length_m(float(airbox_max[axis]))}, "
                f"geometry {_format_length_m(float(object_min[axis]))} -> {_format_length_m(float(object_max[axis]))}; "
                "increase the airbox size or use padding"
            )


def _study_universe_airbox_options(
    geometries: list[Geometry],
    study_universe: Mapping[str, object] | None,
) -> AirboxOptions | None:
    if not study_universe:
        return None

    mode = study_universe.get("mode")
    resolved_mode = str(mode) if isinstance(mode, str) else "auto"
    declared_center = _optional_vec3(study_universe.get("center")) or (0.0, 0.0, 0.0)
    declared_size = _optional_vec3(study_universe.get("size"))
    airbox_hmax = study_universe.get("airbox_hmax")
    resolved_airbox_hmax = float(airbox_hmax) if airbox_hmax is not None else None
    airbox_hmin = study_universe.get("airbox_hmin")
    resolved_airbox_hmin = float(airbox_hmin) if airbox_hmin is not None else None
    resolved_airbox_growth_rate = _coerce_positive_float(study_universe.get("airbox_growth_rate"))
    raw_airbox_grading = study_universe.get("airbox_grading")
    resolved_airbox_grading: str | None = None
    if isinstance(raw_airbox_grading, str) and raw_airbox_grading.strip():
        resolved_airbox_grading = raw_airbox_grading.strip().lower()
        if resolved_airbox_grading == "auto":
            resolved_airbox_grading = "geometric"
        if resolved_airbox_grading not in {"geometric", "linear"}:
            raise ValueError(
                "study_universe.airbox_grading must resolve to 'geometric' or 'linear'"
            )

    # Treat an explicit declared size as an authoritative airbox, even when the
    # builder currently marks the universe as "auto". The frontend/script
    # builder can preserve auto mode while still materializing a fixed box.
    if declared_size is not None:
        if resolved_mode in {"manual", "auto"}:
            _validate_explicit_airbox_contains_geometry_bounds(
                geometries,
                size=declared_size,
                center=declared_center,
            )
            return AirboxOptions(
                size=declared_size,
                center=declared_center,
                maximum_element_size=resolved_airbox_hmax,
                minimum_element_size=resolved_airbox_hmin,
                grading_ratio=(
                    float(resolved_airbox_growth_rate)
                    if resolved_airbox_growth_rate is not None
                    else _DEFAULT_AIRBOX_GROWTH_RATE
                ),
                grading_mode=resolved_airbox_grading or _DEFAULT_AIRBOX_GRADING,
            )
        return None

    padding = _optional_vec3(study_universe.get("padding")) or (0.0, 0.0, 0.0)
    if not any(component > 0.0 for component in padding):
        return None

    per_geometry_bounds = [
        geometry_bounds(geometry, source_root=None)
        for geometry in geometries
    ]
    valid_bounds = [bounds for bounds in per_geometry_bounds if bounds is not None]
    if not valid_bounds:
        return None

    mins = np.asarray([bounds[0] for bounds in valid_bounds], dtype=np.float64)
    maxs = np.asarray([bounds[1] for bounds in valid_bounds], dtype=np.float64)
    object_min = mins.min(axis=0)
    object_max = maxs.max(axis=0)
    size = tuple(
        float(object_max[axis] - object_min[axis] + 2.0 * padding[axis])
        for axis in range(3)
    )
    center = tuple(float(0.5 * (object_min[axis] + object_max[axis])) for axis in range(3))
    return AirboxOptions(
        size=size,
        center=center,
        maximum_element_size=resolved_airbox_hmax,
        minimum_element_size=resolved_airbox_hmin,
        grading_ratio=(
            float(resolved_airbox_growth_rate)
            if resolved_airbox_growth_rate is not None
            else _DEFAULT_AIRBOX_GROWTH_RATE
        ),
        grading_mode=resolved_airbox_grading or _DEFAULT_AIRBOX_GRADING,
    )


def _rectangular_airbox_bounds_from_options(
    airbox: AirboxOptions | None,
    bounds_by_name: Mapping[str, tuple] | None,
) -> tuple[tuple[float, float, float], tuple[float, float, float]] | None:
    if airbox is None or str(airbox.shape).lower() != "bbox":
        return None
    if airbox.size is not None and airbox.center is not None:
        center = tuple(float(value) for value in airbox.center)
        size = tuple(float(value) for value in airbox.size)
        return (
            tuple(center[axis] - 0.5 * size[axis] for axis in range(3)),
            tuple(center[axis] + 0.5 * size[axis] for axis in range(3)),
        )
    if not bounds_by_name:
        return None
    valid_bounds = [
        bounds
        for bounds in bounds_by_name.values()
        if isinstance(bounds, tuple)
        and len(bounds) == 2
        and bounds[0] is not None
        and bounds[1] is not None
    ]
    if not valid_bounds:
        return None
    mins = np.asarray([bounds[0] for bounds in valid_bounds], dtype=np.float64)
    maxs = np.asarray([bounds[1] for bounds in valid_bounds], dtype=np.float64)
    object_min = mins.min(axis=0)
    object_max = maxs.max(axis=0)
    center = 0.5 * (object_min + object_max)
    size = (object_max - object_min) * float(airbox.padding_factor)
    return (
        tuple(float(center[axis] - 0.5 * size[axis]) for axis in range(3)),
        tuple(float(center[axis] + 0.5 * size[axis]) for axis in range(3)),
    )


# _coerce_positive_float, _parse_per_geometry_overrides,
# _geometry_name_aliases, _lookup_geometry_name_alias are now imported
# from _mesh_targets (see top-of-file imports).

# _shared_domain_local_size_fields, _build_field_stack and layer builders,
# _resolve_per_object_mesh_options, _mesh_options_from_runtime_metadata
# are now imported from _size_field_plan (see top-of-file imports).

# Backward-compat alias for _shared_domain_local_size_fields:
_shared_domain_local_size_fields = _legacy_box_size_fields


def _contains_points_in_geometry(
    geometry: Geometry,
    points: np.ndarray,
) -> np.ndarray:
    if points.size == 0:
        return np.zeros((0,), dtype=np.bool_)

    if isinstance(geometry, Box):
        sx, sy, sz = geometry.size
        return (
            (np.abs(points[:, 0]) <= sx / 2.0)
            & (np.abs(points[:, 1]) <= sy / 2.0)
            & (np.abs(points[:, 2]) <= sz / 2.0)
        )
    if isinstance(geometry, Cylinder):
        radius = geometry.radius
        height = geometry.height
        axis = np.asarray(geometry.axis, dtype=np.float64)
        axial = points @ axis
        radial = points - axial.reshape(-1, 1) * axis.reshape(1, 3)
        return (
            np.einsum("ij,ij->i", radial, radial) <= radius * radius
        ) & (np.abs(axial) <= height / 2.0)
    if isinstance(geometry, Ellipsoid):
        rx, ry, rz = geometry.rx, geometry.ry, geometry.rz
        return (
            (points[:, 0] / rx) ** 2
            + (points[:, 1] / ry) ** 2
            + (points[:, 2] / rz) ** 2
            <= 1.0
        )
    if isinstance(geometry, Ellipse):
        rx, ry, height = geometry.rx, geometry.ry, geometry.height
        return (
            (points[:, 0] / rx) ** 2 + (points[:, 1] / ry) ** 2 <= 1.0
        ) & (np.abs(points[:, 2]) <= height / 2.0)
    if isinstance(geometry, Difference):
        return _contains_points_in_geometry(geometry.base, points) & ~_contains_points_in_geometry(
            geometry.tool,
            points,
        )
    if isinstance(geometry, Union):
        return _contains_points_in_geometry(geometry.a, points) | _contains_points_in_geometry(
            geometry.b,
            points,
        )
    if isinstance(geometry, Intersection):
        return _contains_points_in_geometry(
            geometry.a,
            points,
        ) & _contains_points_in_geometry(geometry.b, points)
    if isinstance(geometry, Translate):
        offset = np.asarray(geometry.offset, dtype=np.float64)
        return _contains_points_in_geometry(geometry.geometry, points - offset.reshape(1, 3))
    if isinstance(geometry, ImportedGeometry):
        trimesh = _import_trimesh()
        surface = _geometry_to_trimesh(geometry, trimesh)
        return np.asarray(surface.contains(points), dtype=np.bool_)
    raise TypeError(f"unsupported geometry type for point containment: {type(geometry)!r}")


def _bounds_center(
    bounds_min: tuple[float, float, float],
    bounds_max: tuple[float, float, float],
) -> np.ndarray:
    return 0.5 * (np.asarray(bounds_min, dtype=np.float64) + np.asarray(bounds_max, dtype=np.float64))


def _bounds_intersection_volume(
    left_min: tuple[float, float, float],
    left_max: tuple[float, float, float],
    right_min: tuple[float, float, float],
    right_max: tuple[float, float, float],
) -> float:
    overlap = np.minimum(np.asarray(left_max), np.asarray(right_max)) - np.maximum(
        np.asarray(left_min),
        np.asarray(right_min),
    )
    if np.any(overlap <= 0.0):
        return 0.0
    return float(np.prod(overlap))


def _element_bounds_for_marker(
    mesh: MeshData,
    marker: int,
) -> tuple[tuple[float, float, float], tuple[float, float, float]] | None:
    mask = np.asarray(mesh.element_markers, dtype=np.int32) == int(marker)
    if not np.any(mask):
        return None
    element_nodes = mesh.nodes[
        np.concatenate(
            [
                mesh.cell_node_ids(int(ordinal))
                for ordinal in np.flatnonzero(mask)
            ]
        )
    ]
    mins = element_nodes.min(axis=0)
    maxs = element_nodes.max(axis=0)
    return (
        (float(mins[0]), float(mins[1]), float(mins[2])),
        (float(maxs[0]), float(maxs[1]), float(maxs[2])),
    )


def _match_geometry_bounds_to_source_markers(
    geometries: list[Geometry],
    mesh: MeshData,
) -> dict[str, int] | None:
    geometry_bounds_by_name: dict[str, tuple[tuple[float, float, float], tuple[float, float, float]]] = {}
    for geometry in geometries:
        bounds_min, bounds_max = geometry_bounds(geometry)
        if bounds_min is None or bounds_max is None:
            return None
        geometry_bounds_by_name[geometry.geometry_name] = (bounds_min, bounds_max)

    marker_candidates = sorted(
        int(marker)
        for marker in np.unique(np.asarray(mesh.element_markers, dtype=np.int32))
        if int(marker) > 0
    )
    if len(marker_candidates) < len(geometries):
        return None

    magnetic_markers = marker_candidates[: len(geometries)]
    source_bounds_by_marker: dict[int, tuple[tuple[float, float, float], tuple[float, float, float]]] = {}
    for marker in magnetic_markers:
        bounds = _element_bounds_for_marker(mesh, marker)
        if bounds is None:
            return None
        source_bounds_by_marker[marker] = bounds

    unmatched_geometry_names = {geometry.geometry_name for geometry in geometries}
    marker_mapping: dict[str, int] = {}
    for marker in magnetic_markers:
        source_min, source_max = source_bounds_by_marker[marker]
        source_center = _bounds_center(source_min, source_max)
        best_name: str | None = None
        best_intersection = -1.0
        best_distance = math.inf
        for geometry_name in unmatched_geometry_names:
            geometry_min, geometry_max = geometry_bounds_by_name[geometry_name]
            intersection = _bounds_intersection_volume(
                source_min,
                source_max,
                geometry_min,
                geometry_max,
            )
            geometry_center = _bounds_center(geometry_min, geometry_max)
            distance = float(np.linalg.norm(source_center - geometry_center))
            if intersection > best_intersection + 1e-30 or (
                math.isclose(intersection, best_intersection) and distance < best_distance
            ):
                best_name = geometry_name
                best_intersection = intersection
                best_distance = distance
        if best_name is None:
            return None
        marker_mapping[best_name] = marker
        unmatched_geometry_names.remove(best_name)

    if unmatched_geometry_names:
        return None
    return marker_mapping


def _count_nodes_for_element_mask(mesh: MeshData, element_mask: np.ndarray) -> int:
    return int(_node_indices_for_element_mask(mesh, element_mask).size)


def _node_indices_for_element_mask(mesh: MeshData, element_mask: np.ndarray) -> np.ndarray:
    normalized_mask = np.asarray(element_mask, dtype=np.bool_).reshape(-1)
    if normalized_mask.size != mesh.n_elements:
        raise ValueError(
            "element mask length must match the mesh element count"
        )
    if mesh.n_elements == 0 or not np.any(normalized_mask):
        return np.asarray([], dtype=np.int64)
    node_mask = np.repeat(
        normalized_mask,
        np.diff(np.asarray(mesh.cell_offsets, dtype=np.int64)),
    )
    return np.unique(np.asarray(mesh.cell_nodes)[node_mask])


def _format_length_m(value: float) -> str:
    abs_value = abs(float(value))
    if abs_value == 0.0:
        return "0 m"
    if abs_value >= 1e-3:
        return f"{value * 1e3:.3f} mm"
    if abs_value >= 1e-6:
        return f"{value * 1e6:.3f} um"
    if abs_value >= 1e-9:
        return f"{value * 1e9:.3f} nm"
    if abs_value >= 1e-12:
        return f"{value * 1e12:.3f} pm"
    return f"{value:.3e} m"


def _element_metric_summary_for_mask(
    mesh: MeshData,
    element_mask: np.ndarray,
) -> dict[str, Any] | None:
    if mesh.n_elements == 0 or not np.any(element_mask):
        return None
    if not np.all(mesh.cell_types == "tet4"):
        return None
    points = np.asarray(mesh.nodes[mesh.elements[element_mask]], dtype=np.float64)
    edge_pairs = ((0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3))
    edge_lengths = [
        np.linalg.norm(points[:, start] - points[:, end], axis=1)
        for start, end in edge_pairs
    ]
    if not edge_lengths:
        return None
    edge_span = np.concatenate(edge_lengths)
    if edge_span.size == 0:
        return None
    p0 = points[:, 0]
    p1 = points[:, 1]
    p2 = points[:, 2]
    p3 = points[:, 3]
    triple = np.einsum("ij,ij->i", p1 - p0, np.cross(p2 - p0, p3 - p0))
    volumes = np.abs(triple) / 6.0
    positive_volumes = volumes[volumes > 0.0]
    if positive_volumes.size == 0:
        return {
            "edge_span": (float(np.min(edge_span)), float(np.max(edge_span))),
        }
    # Regular-tetra equivalent edge length: V = a^3 / (6 * sqrt(2))
    characteristic = np.cbrt(positive_volumes * 6.0 * math.sqrt(2.0))
    characteristic_min = float(np.min(characteristic))
    characteristic_max = float(np.max(characteristic))
    if characteristic_max > characteristic_min and not math.isclose(characteristic_min, characteristic_max):
        bin_edges = np.geomspace(
            characteristic_min,
            characteristic_max,
            num=_SIZE_DISTRIBUTION_HISTOGRAM_BINS + 1,
        )
        if np.all(np.diff(bin_edges) > 0.0):
            bin_counts, bin_edges = np.histogram(characteristic, bins=bin_edges)
            characteristic_bins = [
                (float(bin_edges[index]), float(bin_edges[index + 1]), int(count))
                for index, count in enumerate(bin_counts)
            ]
        else:
            characteristic_bins = [
                (characteristic_min, characteristic_max, int(characteristic.size))
            ]
    else:
        characteristic_bins = [
            (characteristic_min, characteristic_max, int(characteristic.size))
        ]
    return {
        "characteristic_size": (
            characteristic_min,
            characteristic_max,
        ),
        "characteristic_size_bins": characteristic_bins,
        "edge_span": (
            float(np.min(edge_span)),
            float(np.max(edge_span)),
        ),
    }


def _format_size_bins(bins: object) -> str | None:
    if not isinstance(bins, list) or not bins:
        return None
    formatted_bins: list[str] = []
    for item in bins:
        if not isinstance(item, tuple) or len(item) != 3:
            return None
        start, end, count = item
        if not isinstance(start, float) or not isinstance(end, float) or not isinstance(count, int):
            return None
        if math.isclose(start, end):
            formatted_bins.append(f"{_format_length_m(start)}: {count}")
        else:
            formatted_bins.append(f"{_format_length_m(start)}-{_format_length_m(end)}: {count}")
    return "; ".join(formatted_bins)


def _display_mesh_partition_name(name: str) -> str:
    if name.endswith("_geom") and len(name) > len("_geom"):
        return name[: -len("_geom")]
    return name


def _resolve_requested_partition_hmaxs(
    geometries: list[Geometry],
    hints: FEM,
    *,
    airbox: AirboxOptions | None,
    mesh_workflow: Mapping[str, object] | None,
    per_object_recipes: dict[str, PerObjectMeshRecipe] | None,
) -> tuple[float | None, dict[str, float | None]]:
    """Backward-compatible wrapper — delegates to ``_mesh_targets``."""
    return _mesh_targets_resolve_partition_hmaxs(
        geometries, hints,
        airbox_hmax=float(airbox.maximum_element_size) if airbox is not None and airbox.maximum_element_size is not None else None,
        mesh_workflow=mesh_workflow,
        per_object_recipes=per_object_recipes,
    )


def _resolve_effective_shared_domain_targets(
    geometries: list[Geometry],
    hints: FEM,
    *,
    airbox: AirboxOptions | None,
    mesh_workflow: Mapping[str, object] | None,
    per_object_recipes: dict[str, PerObjectMeshRecipe] | None,
) -> tuple[dict[str, float | None], dict[str, dict[str, float | int | str | None]]]:
    """Backward-compatible wrapper — delegates to ``resolve_shared_domain_targets``.

    Returns the legacy ``(airbox_dict, per_object_dict)`` format so existing
    callers continue working until they are migrated to the typed API.
    """
    resolved = resolve_shared_domain_targets(
        geometries, hints,
        airbox_hmax=float(airbox.maximum_element_size) if airbox is not None and airbox.maximum_element_size is not None else None,
        airbox_hmin=(
            _coerce_positive_float(getattr(airbox, "minimum_element_size", None))
            if airbox is not None and getattr(airbox, "minimum_element_size", None) is not None
            else None
        ),
        airbox_growth_rate=(
            float(getattr(airbox, "grading_ratio", None))
            if airbox is not None and getattr(airbox, "grading_ratio", None) is not None
            else None
        ),
        mesh_workflow=mesh_workflow,
        per_object_recipes=per_object_recipes,
    )
    effective_airbox_target: dict[str, float | None] = {
        "hmax": resolved.airbox.hmax,
        "hmin": resolved.airbox.hmin,
        "growth_rate": resolved.airbox.growth_rate,
    }
    effective_per_object_targets: dict[str, dict[str, float | int | str | None]] = {}
    for name, target in resolved.per_object.items():
        effective_per_object_targets[name] = {
            "marker": None,
            "hmax": target.hmax,
            "interface_hmax": target.interface_hmax,
            "interface_thickness": target.interface_thickness,
            "transition_distance": target.transition_distance,
            "transition_growth": target.transition_growth,
            "edge_hmax": target.edge_hmax,
            "edge_thickness": target.edge_thickness,
            "edge_transition_distance": target.edge_transition_distance,
            "corner_hmax": target.corner_hmax,
            "corner_extent": target.corner_extent,
            "corner_transition_distance": target.corner_transition_distance,
            "source": target.source,
        }
    return effective_airbox_target, effective_per_object_targets


def _shared_domain_size_field_default_hmax(hints: FEM, airbox: AirboxOptions | None) -> float:
    default_hmax = float(hints.hmax)
    if airbox is not None and airbox.maximum_element_size is not None:
        return max(default_hmax, float(airbox.maximum_element_size))
    return default_hmax


def _emit_shared_domain_mesh_summary(
    mesh: MeshData,
    region_markers: list[dict[str, object]],
    *,
    requested_airbox_hmax: float | None = None,
    requested_hmax_by_geometry: Mapping[str, float | None] | None = None,
) -> None:
    emit_progress(
        "Total mesh: "
        f"{mesh.n_elements} "
        f"{'tetrahedra' if np.all(mesh.cell_types == 'tet4') else 'volume cells'}, "
        f"{mesh.nodes.shape[0]} nodes, {mesh.n_boundary_faces} boundary faces"
    )

    element_markers = np.asarray(mesh.element_markers, dtype=np.int32)
    air_mask = element_markers == 0
    region_masks: list[tuple[str, str, np.ndarray]] = []
    for entry in region_markers:
        geometry_name = entry.get("geometry_name")
        marker = entry.get("marker")
        if not isinstance(geometry_name, str) or not isinstance(marker, int):
            continue
        part_label = _display_mesh_partition_name(geometry_name)
        region_masks.append((geometry_name, part_label, element_markers == int(marker)))
    if region_masks or np.any(air_mask):
        covered_count = int(np.count_nonzero(air_mask))
        for _geometry_name, _label, part_mask in region_masks:
            covered_count += int(np.count_nonzero(part_mask))
        emit_progress(
            "Mesh partition check: "
            f"{covered_count}/{mesh.n_elements} "
            f"{'tetrahedra' if np.all(mesh.cell_types == 'tet4') else 'volume cells'} covered by "
            "mutually exclusive region markers"
        )
    if np.any(air_mask):
        air_metrics = _element_metric_summary_for_mask(mesh, air_mask)
        air_size_suffix = ""
        parts: list[str] = []
        if requested_airbox_hmax is not None:
            parts.append(
                "requested maximum element size: "
                f"{_format_length_m(requested_airbox_hmax)}"
            )
        if air_metrics is not None:
            characteristic = air_metrics.get("characteristic_size")
            size_bins = _format_size_bins(air_metrics.get("characteristic_size_bins"))
            edge_span = air_metrics.get("edge_span")
            if characteristic is not None:
                parts.append(
                    "characteristic size: "
                    f"{_format_length_m(characteristic[0])} -> {_format_length_m(characteristic[1])}"
                )
            if size_bins is not None:
                parts.append(f"size bins: {size_bins}")
            if edge_span is not None:
                parts.append(
                    "edge span: "
                    f"{_format_length_m(edge_span[0])} -> {_format_length_m(edge_span[1])}"
                )
            if parts:
                air_size_suffix = ", " + ", ".join(parts)
        emit_progress(
            "Mesh part airbox: "
            f"{int(np.count_nonzero(air_mask))} "
            f"{'tetrahedra' if np.all(mesh.cell_types == 'tet4') else 'volume cells'}, "
            f"{_count_nodes_for_element_mask(mesh, air_mask)} nodes"
            f"{air_size_suffix}"
        )

    air_nodes = _node_indices_for_element_mask(mesh, air_mask)
    for geometry_name, part_label, part_mask in region_masks:
        part_metrics = _element_metric_summary_for_mask(mesh, part_mask)
        part_size_suffix = ""
        parts: list[str] = []
        requested_hmax = (
            requested_hmax_by_geometry.get(geometry_name)
            if requested_hmax_by_geometry is not None
            else None
        )
        if requested_hmax is not None:
            parts.append(
                "requested maximum element size: "
                f"{_format_length_m(requested_hmax)}"
            )
        if part_metrics is not None:
            characteristic = part_metrics.get("characteristic_size")
            size_bins = _format_size_bins(part_metrics.get("characteristic_size_bins"))
            edge_span = part_metrics.get("edge_span")
            if characteristic is not None:
                parts.append(
                    "characteristic size: "
                    f"{_format_length_m(characteristic[0])} -> {_format_length_m(characteristic[1])}"
                )
            if size_bins is not None:
                parts.append(f"size bins: {size_bins}")
            if edge_span is not None:
                parts.append(
                    "edge span: "
                    f"{_format_length_m(edge_span[0])} -> {_format_length_m(edge_span[1])}"
                )
            if parts:
                part_size_suffix = ", " + ", ".join(parts)
        emit_progress(
            f"Mesh part {part_label}: "
            f"{int(np.count_nonzero(part_mask))} "
            f"{'tetrahedra' if np.all(mesh.cell_types == 'tet4') else 'volume cells'}, "
            f"{_count_nodes_for_element_mask(mesh, part_mask)} nodes"
            f"{part_size_suffix}"
        )
        if np.any(air_mask):
            part_nodes = _node_indices_for_element_mask(mesh, part_mask)
            shared_nodes = np.intersect1d(air_nodes, part_nodes, assume_unique=True)
            part_only_nodes = np.setdiff1d(part_nodes, air_nodes, assume_unique=True)
            air_only_nodes = np.setdiff1d(air_nodes, part_nodes, assume_unique=True)
            emit_progress(
                f"Mesh node sharing {part_label}: "
                f"shared_with_airbox={int(shared_nodes.size)}, "
                f"object_only={int(part_only_nodes.size)}, "
                f"airbox_only={int(air_only_nodes.size)}"
            )


def _magnetic_submesh_signatures(
    mesh: MeshData,
    region_markers: list[dict[str, object]],
) -> list[dict[str, object]]:
    if not np.all(mesh.cell_types == "tet4"):
        return []
    edge_pairs = np.asarray(
        [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]],
        dtype=np.int64,
    )
    elements = np.asarray(mesh.elements, dtype=np.int64)
    element_markers = np.asarray(mesh.element_markers, dtype=np.int32)
    nodes = np.asarray(mesh.nodes, dtype=np.float64)
    signatures: list[dict[str, object]] = []
    for marker_entry in region_markers:
        geometry_name = marker_entry.get("geometry_name")
        marker = marker_entry.get("marker")
        if not isinstance(geometry_name, str) or not isinstance(marker, (int, np.integer)):
            continue
        magnetic_elements = elements[element_markers == int(marker)]
        if magnetic_elements.size == 0:
            signatures.append(
                {
                    "geometry_name": geometry_name,
                    "marker": int(marker),
                    "node_count": 0,
                    "tetra_count": 0,
                    "edge_count": 0,
                    "coordinate_quantization_m": 1.0e-12,
                    "digest": None,
                }
            )
            continue
        edges = magnetic_elements[:, edge_pairs].reshape(-1, 2)
        edges.sort(axis=1)
        unique_edges = np.unique(edges, axis=0)
        node_ids = np.unique(magnetic_elements.reshape(-1))
        rounded_nodes = np.round(nodes[node_ids] / 1.0e-12).astype(np.int64)
        coordinate_order = np.lexsort(rounded_nodes.T[::-1])
        canonical_node_ids = node_ids[coordinate_order]
        sorted_rounded_nodes = rounded_nodes[coordinate_order]
        node_remap = {
            int(node_id): index
            for index, node_id in enumerate(canonical_node_ids)
        }
        canonical_elements = np.asarray(
            [
                sorted(node_remap[int(node_id)] for node_id in element)
                for element in magnetic_elements
            ],
            dtype=np.int32,
        )
        canonical_elements = canonical_elements[
            np.lexsort(canonical_elements.T[::-1])
        ]
        digest = hashlib.sha256()
        digest.update(sorted_rounded_nodes.tobytes())
        digest.update(canonical_elements.tobytes())
        signatures.append(
            {
                "geometry_name": geometry_name,
                "marker": int(marker),
                "node_count": int(node_ids.size),
                "tetra_count": int(magnetic_elements.shape[0]),
                "edge_count": int(unique_edges.shape[0]),
                "coordinate_quantization_m": 1.0e-12,
                "digest": digest.hexdigest(),
            }
        )
    return signatures


def _periodic_pair_counts_by_id(pairs: list[dict[str, object]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for pair in pairs:
        pair_id = str(pair.get("pair_id", "")).strip()
        if not pair_id:
            pair_id = "<missing>"
        counts[pair_id] = counts.get(pair_id, 0) + 1
    return dict(sorted(counts.items()))


def _frozen_magnetic_submesh_invariants(
    mesh: MeshData,
    region_markers: list[dict[str, object]],
) -> dict[str, object]:
    return {
        "node_count": int(mesh.n_nodes),
        "element_count": int(mesh.n_elements),
        "interface_boundary_face_count": int(np.asarray(mesh.boundary_faces).shape[0]),
        "periodic_boundary_pair_count": len(mesh.periodic_boundary_pairs),
        "periodic_node_pair_count": len(mesh.periodic_node_pairs),
        "periodic_boundary_pair_counts_by_id": _periodic_pair_counts_by_id(
            mesh.periodic_boundary_pairs
        ),
        "periodic_node_pair_counts_by_id": _periodic_pair_counts_by_id(
            mesh.periodic_node_pairs
        ),
        "magnetic_submesh_signatures": _magnetic_submesh_signatures(
            mesh,
            region_markers,
        ),
    }


def _load_frozen_magnetic_submesh_invariants_report(
    report_path: Path,
) -> dict[str, object]:
    payload = json.loads(report_path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(
            f"frozen magnetic submesh report {report_path} must contain a JSON object"
        )
    invariants = payload.get("frozen_magnetic_submesh_invariants")
    if not isinstance(invariants, Mapping):
        return {}
    return dict(invariants)


def _invariant_path(base: str, key: str) -> str:
    if base:
        return f"{base}[{key!r}]"
    return key


def _assert_frozen_magnetic_submesh_invariants(
    expected: Mapping[str, object],
    candidate: Mapping[str, object],
    *,
    context: str,
) -> None:
    ordered_keys = [
        "node_count",
        "element_count",
        "interface_boundary_face_count",
        "periodic_boundary_pair_count",
        "periodic_boundary_pair_counts_by_id",
        "periodic_node_pair_counts_by_id",
        "periodic_node_pair_count",
        "magnetic_submesh_signatures",
    ]

    def compare(expected_value: object, candidate_value: object, path: str) -> None:
        if isinstance(expected_value, Mapping) and isinstance(candidate_value, Mapping):
            for key in sorted(expected_value):
                next_path = _invariant_path(path, str(key))
                if key not in candidate_value:
                    raise ValueError(
                        "inconsistent frozen magnetic submesh "
                        f"({context}): {next_path} expected {expected_value[key]!r}, got <missing>"
                    )
                compare(expected_value[key], candidate_value[key], next_path)
            return
        if expected_value != candidate_value:
            raise ValueError(
                "inconsistent frozen magnetic submesh "
                f"({context}): {path} expected {expected_value!r}, got {candidate_value!r}"
            )

    for key in ordered_keys:
        if key not in expected:
            continue
        if key not in candidate:
            raise ValueError(
                "inconsistent frozen magnetic submesh "
                f"({context}): {key} expected {expected[key]!r}, got <missing>"
            )
        compare(expected[key], candidate[key], key)


def _strip_overridden_geometry_fields(
    existing_fields: list[dict[str, object]],
    per_object_recipes: dict[str, PerObjectMeshRecipe],
) -> list[dict[str, object]]:
    """Remove runtime workflow size fields for geometries overridden by recipes.

    This ensures that when a recipe specifies a *coarser* hmax than the workflow,
    the finer workflow field is removed so Gmsh's ``Min`` background-field rule
    doesn't silently clamp the coarser recipe back to the workflow value.
    """
    overridden_names: set[str] = set()
    for geometry_name, recipe in per_object_recipes.items():
        recipe_hmax = recipe.to_ir().get("hmax")
        if isinstance(recipe_hmax, (int, float)) and float(recipe_hmax) > 0.0:
            overridden_names.add(geometry_name.strip())
            if geometry_name.strip().endswith("_geom") and len(geometry_name.strip()) > len("_geom"):
                overridden_names.add(geometry_name.strip()[: -len("_geom")])
            else:
                overridden_names.add(f"{geometry_name.strip()}_geom")
    if not overridden_names:
        return existing_fields

    def _is_overridden(field: dict[str, object]) -> bool:
        params = field.get("params")
        if not isinstance(params, dict):
            return False
        geom_name = params.get("GeometryName")
        if isinstance(geom_name, str) and geom_name in overridden_names:
            return True
        # For Box / BoundsSurfaceThreshold fields we can't match by geometry name
        # directly — they don't carry one. We leave them; recipe fields prepended
        # with smaller VIn will still win via Min. Only component-aware fields
        # (ComponentVolumeConstant, InterfaceShellThreshold, TransitionShellThreshold)
        # are reliably matchable.
        return False

    return [f for f in existing_fields if not _is_overridden(f)]


def realize_fem_domain_mesh_asset(
    geometries: list[Geometry],
    hints: FEM,
    *,
    study_universe: Mapping[str, object] | None = None,
    mesh_workflow: Mapping[str, object] | None = None,
    per_object_recipes: dict[str, PerObjectMeshRecipe] | None = None,
    assembly_policy: SharedMeshAssemblyPolicy | None = None,
    object_regions: list[dict[str, object]] | None = None,
) -> tuple[MeshData, list[dict[str, object]]]:
    mesh, region_markers, _report = _realize_fem_domain_mesh_asset_from_components_impl(
        geometries,
        hints,
        study_universe=study_universe,
        mesh_workflow=mesh_workflow,
        per_object_recipes=per_object_recipes,
        assembly_policy=assembly_policy,
        object_regions=object_regions,
    )
    return mesh, region_markers


def _qualified_mixed_per_geometry_body_hmax(
    mesh_workflow: Mapping[str, object] | None,
    geometries: list[Geometry],
) -> float | None:
    if not isinstance(mesh_workflow, Mapping):
        return None
    raw_per_geometry = mesh_workflow.get("per_geometry")
    if raw_per_geometry in (None, []):
        return None
    if not isinstance(raw_per_geometry, list) or len(raw_per_geometry) != 1:
        raise ValueError(
            "qualified mixed shared-domain route rejects: per-geometry controls"
        )
    recipe = raw_per_geometry[0]
    if not isinstance(recipe, Mapping) or len(geometries) != 1:
        raise ValueError(
            "qualified mixed shared-domain route rejects: per-geometry controls"
        )

    allowed_keys = {
        "geometry",
        "mode",
        "hmax",
        "maximum_element_size",
        "hmin",
        "minimum_element_size",
        "order",
        "interface_hmax",
        "interface_thickness",
        "transition_distance",
        "edge_hmax",
        "edge_thickness",
        "edge_transition_distance",
        "corner_hmax",
        "corner_extent",
        "corner_transition_distance",
        "mesh_strategy",
        "through_thickness_elements",
        "through_thickness_distribution",
        "sweep_face_meshing",
        "topology",
        "sweep_direction",
        "element_family",
        "transition_policy",
        "exact_layer_count",
    }
    unsupported = sorted(str(key) for key in recipe if key not in allowed_keys)
    body_hmax = _coerce_positive_float(recipe.get("maximum_element_size"))
    alias_hmax = _coerce_positive_float(recipe.get("hmax"))
    optional_size_keys = (
        "interface_hmax",
        "interface_thickness",
        "transition_distance",
        "edge_hmax",
        "edge_thickness",
        "edge_transition_distance",
        "corner_hmax",
        "corner_extent",
        "corner_transition_distance",
    )
    invalid_size_keys = [
        key
        for key in optional_size_keys
        if recipe.get(key) is not None
        and _coerce_positive_float(recipe.get(key)) is None
    ]
    body_hmin = _coerce_positive_float(recipe.get("minimum_element_size"))
    alias_hmin = _coerce_positive_float(recipe.get("hmin"))
    hmin_is_canonical = (
        recipe.get("minimum_element_size") is None
        and recipe.get("hmin") is None
    ) or (body_hmin is not None and alias_hmin == body_hmin)
    geometry_names = _geometry_name_aliases(geometries[0].geometry_name)
    canonical = (
        recipe.get("geometry") in geometry_names
        and recipe.get("mode") == "custom"
        and body_hmax is not None
        and alias_hmax == body_hmax
        and hmin_is_canonical
        and not invalid_size_keys
        and recipe.get("order") == 1
        and recipe.get("mesh_strategy") == "swept_prism"
        and recipe.get("through_thickness_elements") is not None
        and not isinstance(recipe.get("through_thickness_elements"), bool)
        and isinstance(recipe.get("through_thickness_elements"), int)
        and int(recipe["through_thickness_elements"]) in (1, 2, 3)
        and recipe.get("through_thickness_distribution") == "fixed"
        and recipe.get("sweep_face_meshing") == "triangular"
        and recipe.get("topology") in (None, "prismatic")
        and recipe.get("sweep_direction") == "auto"
        and recipe.get("element_family") == "prism"
        and recipe.get("transition_policy") == "pyramid_to_tetrahedra"
        and recipe.get("exact_layer_count") is True
    )
    if unsupported or not canonical:
        rejected = unsupported + invalid_size_keys
        detail = f" ({', '.join(rejected)})" if rejected else ""
        raise ValueError(
            "qualified mixed shared-domain route rejects: "
            f"per-geometry controls{detail}"
        )
    return body_hmax


def _realize_fem_domain_mesh_asset_from_components_impl(
    geometries: list[Geometry],
    hints: FEM,
    *,
    study_universe: Mapping[str, object] | None = None,
    mesh_workflow: Mapping[str, object] | None = None,
    per_object_recipes: dict[str, PerObjectMeshRecipe] | None = None,
    assembly_policy: SharedMeshAssemblyPolicy | None = None,
    object_regions: list[dict[str, object]] | None = None,
) -> tuple[MeshData, list[dict[str, object]], SharedDomainBuildReport]:
    """Component-aware shared FEM domain mesh with stable geometry identity.

    Instead of concatenating all component STLs into a single anonymous file,
    each component is exported and imported individually so Gmsh maintains a
    per-component volume/surface mapping throughout the meshing pipeline.

    Falls back to the legacy concatenated path if the component-aware import
    encounters an error.
    """
    if not geometries:
        raise ValueError("shared FEM domain mesh requires at least one geometry")
    _validate_declared_mesh_operations(mesh_workflow)
    _validate_per_object_recipe_operations(per_object_recipes)
    frozen_payload = _validate_domain_mesh_workflow(mesh_workflow)

    airbox = _study_universe_airbox_options(geometries, study_universe)
    if airbox is None:
        raise ValueError(
            "shared FEM domain mesh generation requires a declared study universe "
            "(manual size/center or auto padding)"
        )

    if frozen_payload is not None:
        air_mesh_source = _frozen_magnetic_submesh_air_mesh_source(mesh_workflow)
        if air_mesh_source is None:
            air_mesh = _generate_air_mesh_for_frozen_magnetic_submesh(
                frozen=frozen_payload,
                geometries=geometries,
                hints=hints,
                airbox=airbox,
                mesh_workflow=mesh_workflow,
                per_object_recipes=per_object_recipes,
                object_regions=object_regions,
            )
        else:
            air_mesh = MeshData.load(Path(air_mesh_source).expanduser())
        merged_mesh = _merge_frozen_magnetic_submesh_with_air_mesh(
            frozen_payload,
            air_mesh,
        )
        mesh_options = _mesh_options_from_runtime_metadata(
            mesh_workflow,
            geometries=geometries,
            default_hmax=_shared_domain_size_field_default_hmax(hints, airbox),
            bounds_by_name={},
            component_aware=False,
            per_object_recipes=per_object_recipes,
            object_regions=object_regions,
        )
        region_markers = [dict(marker) for marker in frozen_payload.region_markers]
        requested_airbox_hmax, requested_hmax_by_geometry = _resolve_requested_partition_hmaxs(
            geometries, hints, airbox=airbox, mesh_workflow=mesh_workflow,
            per_object_recipes=per_object_recipes,
        )
        _emit_shared_domain_mesh_summary(
            merged_mesh,
            region_markers,
            requested_airbox_hmax=requested_airbox_hmax,
            requested_hmax_by_geometry=requested_hmax_by_geometry,
        )
        report = _build_shared_domain_build_report(
            geometries,
            hints,
            airbox=airbox,
            mesh_workflow=mesh_workflow,
            per_object_recipes=per_object_recipes,
            size_fields=list(mesh_options.size_fields),
            region_markers=region_markers,
            build_mode="frozen_magnetic_submesh_merge",
            fallbacks_triggered=[],
            mesh_options=mesh_options,
            magnetic_submesh_signatures=frozen_payload.magnetic_submesh_signatures,
        )
        emit_progress_event(
            {
                "kind": "mesh_build_summary",
                "shared_domain_build_mode": report.build_mode,
                "n_nodes": merged_mesh.n_nodes,
                "n_elements": merged_mesh.n_elements,
                "n_boundary_faces": merged_mesh.n_boundary_faces,
                "mesh_statistics": merged_mesh.to_ir("shared_domain").get("mesh_statistics"),
                **{k: v for k, v in report.to_dict().items() if k != "build_mode"},
                "message": "Frozen magnetic submesh and air mesh merge finished",
            }
        )
        return merged_mesh, region_markers, report

    from ._gmsh_occ import _region_uses_conformal_occ_realization

    conformal_object_regions = [
        region
        for region in (object_regions or [])
        if region.get("enabled", True)
        and _region_uses_conformal_occ_realization(region)
    ]
    surface_mesh_options = _mesh_options_from_runtime_metadata(
        mesh_workflow,
        geometries=geometries,
        default_hmax=float(hints.hmax),
        bounds_by_name=None,
        include_size_fields=False,
    )
    qualified_mixed_body_hmax: float | None = None
    if surface_mesh_options.mesh_strategy == "swept_prism":
        qualified_mixed_body_hmax = _qualified_mixed_per_geometry_body_hmax(
            mesh_workflow,
            geometries,
        )
        reasons: list[str] = []
        raw_mesh_options = (
            mesh_workflow.get("mesh_options", {})
            if isinstance(mesh_workflow, Mapping)
            else {}
        )
        if len(geometries) != 1 or not isinstance(geometries[0], Box):
            reasons.append("exactly one Box geometry")
        if frozen_payload is not None:
            reasons.append("frozen magnetic submesh")
        if per_object_recipes:
            reasons.append("per-object mesh recipes")
        if object_regions:
            reasons.append("object/conformal regions")
        if hints.order != 1:
            reasons.append("element order")
        if isinstance(raw_mesh_options, Mapping):
            if raw_mesh_options.get("size_fields"):
                reasons.append("local/size fields")
            if (
                raw_mesh_options.get("hmin") is not None
                or raw_mesh_options.get("minimum_element_size") is not None
            ):
                reasons.append("minimum element size")
            if raw_mesh_options.get("recombine") is True:
                reasons.append("recombine")
        for name, active in (
            ("local/size fields", bool(surface_mesh_options.size_fields)),
            ("boundary layers", surface_mesh_options.boundary_layer_count is not None),
            ("optimizer", surface_mesh_options.optimize is not None),
            ("periodic pairs", bool(surface_mesh_options.periodic_pair_ids)),
            (
                "layer count",
                surface_mesh_options.through_thickness_elements not in (None, 1, 2, 3),
            ),
            ("non-fixed distribution", surface_mesh_options.through_thickness_distribution not in (None, "fixed")),
            ("graded distribution", surface_mesh_options.through_thickness_element_ratio not in (None, 1.0)),
            ("symmetric distribution", surface_mesh_options.through_thickness_symmetric),
            ("non-triangular sweep face", surface_mesh_options.sweep_face_meshing not in (None, "triangular")),
            ("2D algorithm", surface_mesh_options.algorithm_2d != 6),
            ("3D algorithm", surface_mesh_options.algorithm_3d != 1),
        ):
            if active:
                reasons.append(name)
        if reasons:
            raise ValueError(
                "qualified mixed shared-domain route rejects: " + ", ".join(reasons)
            )
    mixed_shared_geo_direct = (
        len(geometries) == 1
        and isinstance(geometries[0], Box)
        and airbox is not None
        and surface_mesh_options.mesh_strategy == "swept_prism"
    )
    single_geometry_occ_direct = mixed_shared_geo_direct
    if (
        isinstance(mesh_workflow, Mapping)
        and bool(mesh_workflow.get("single_geometry_occ_direct")) is True
    ):
        single_geometry_occ_direct = (
            len(geometries) == 1 and not isinstance(geometries[0], ImportedGeometry)
            and not conformal_object_regions
        )

    bounds_by_name: dict[str, tuple] = {}
    fallbacks_triggered: list[str] = []
    surface_trimesh_kwargs = _surface_trimesh_kwargs_from_mesh_options(surface_mesh_options)
    conformal_occ_direct = False
    if not single_geometry_occ_direct:
        from ._gmsh_occ import is_occ_compatible

        conformal_occ_direct = is_occ_compatible(geometries)
        if conformal_object_regions and not conformal_occ_direct:
            raise ValueError(
                "automatic conformal object-region meshing requires OCC-compatible "
                "owner geometries"
            )
    preemptive_imported_stl_fallback = (
        len(geometries) == 1
        and _is_stl_imported_geometry(geometries[0])
        and not single_geometry_occ_direct
        and not conformal_occ_direct
        and not conformal_object_regions
    )

    with tempfile.TemporaryDirectory(prefix="fullmag-fem-domain-components-") as tmp_dir:
        component_descriptors: list[ComponentDescriptor] = []
        trimesh_module: object | None = None

        def _prepare_component_descriptors() -> object:
            nonlocal trimesh_module
            if component_descriptors:
                if trimesh_module is None:
                    trimesh_module = _import_trimesh()
                return trimesh_module
            trimesh_module = _import_trimesh()
            for geometry in geometries:
                comp_mesh = _geometry_to_trimesh(
                    geometry,
                    trimesh_module,
                    **_surface_trimesh_kwargs_for_geometry(
                        geometry,
                        surface_trimesh_kwargs,
                        mesh_workflow,
                    ),
                )
                comp_mesh = _sanitize_surface_mesh_for_stl_export(comp_mesh)
                verts = np.asarray(comp_mesh.vertices)
                b_min = tuple(float(v) for v in verts.min(axis=0))
                b_max = tuple(float(v) for v in verts.max(axis=0))
                bounds_by_name[geometry.geometry_name] = (b_min, b_max)
                comp_path = Path(tmp_dir) / f"{geometry.geometry_name}.stl"
                comp_mesh.export(comp_path)
                component_descriptors.append(
                    ComponentDescriptor(
                        geometry_name=geometry.geometry_name,
                        stl_path=comp_path,
                        bounds_min=b_min,
                        bounds_max=b_max,
                    )
                )
            return trimesh_module

        if not single_geometry_occ_direct and not conformal_occ_direct:
            try:
                _prepare_component_descriptors()
            except Exception as exc:
                if len(geometries) == 1 and not isinstance(geometries[0], ImportedGeometry):
                    single_geometry_occ_direct = True
                    fallbacks_triggered.append("component_surface_prep_failed")
                    emit_progress(
                        "Shared-domain surface preparation failed "
                        f"({exc!r}); falling back to direct OCC meshing for the single geometry"
                    )
                else:
                    raise

        if single_geometry_occ_direct or conformal_occ_direct:
            for geometry in geometries:
                bounds_min, bounds_max = geometry_bounds(geometry)
                if bounds_min is None or bounds_max is None:
                    continue
                bounds_by_name[geometry.geometry_name] = (
                    tuple(float(value) for value in bounds_min),
                    tuple(float(value) for value in bounds_max),
                )
        if preemptive_imported_stl_fallback:
            fallbacks_triggered.append(_PREEMPTIVE_IMPORTED_STL_FALLBACK)
            emit_progress(
                "Single imported STL shared-domain mesh is routed directly to "
                "concatenated STL fallback for numerical stability"
            )

        size_field_default_hmax = _shared_domain_size_field_default_hmax(hints, airbox)
        airbox_bounds = _rectangular_airbox_bounds_from_options(airbox, bounds_by_name)
        component_aware_mesh_options = not preemptive_imported_stl_fallback

        mesh_options = _mesh_options_from_runtime_metadata(
            mesh_workflow,
            geometries=geometries,
            default_hmax=size_field_default_hmax,
            bounds_by_name=bounds_by_name,
            airbox_bounds=airbox_bounds,
            component_aware=component_aware_mesh_options,
            per_object_recipes=per_object_recipes,
            object_regions=object_regions,
        )
        if per_object_recipes:
            _policy = assembly_policy if assembly_policy is not None else SharedMeshAssemblyPolicy()
            recipe_fields = _resolve_per_object_mesh_options(
                geometries,
                per_object_recipes,
                _policy,
                default_hmax=size_field_default_hmax,
                bounds_by_name=bounds_by_name,
                component_aware=component_aware_mesh_options,
            )
            if recipe_fields:
                existing = _strip_overridden_geometry_fields(
                    list(mesh_options.size_fields), per_object_recipes
                )
                mesh_options = _dc_replace(mesh_options, size_fields=recipe_fields + existing)
        effective_airbox_target, effective_per_object_targets = _resolve_effective_shared_domain_targets(
            geometries,
            hints,
            airbox=airbox,
            mesh_workflow=mesh_workflow,
            per_object_recipes=per_object_recipes,
        )
        used_size_field_kinds = _unique_size_field_kinds(list(mesh_options.size_fields))
        if mixed_shared_geo_direct:
            planned_build_mode = "single_geometry_geo_mixed"
        elif single_geometry_occ_direct:
            planned_build_mode = "single_geometry_occ"
        elif conformal_occ_direct:
            planned_build_mode = "conformal_occ"
        elif preemptive_imported_stl_fallback:
            planned_build_mode = "concatenated_stl_fallback"
        else:
            planned_build_mode = "component_aware"
        planned_operation_statuses = _build_mesh_operation_statuses(
            geometries,
            mesh_options,
            airbox=airbox,
            build_mode=planned_build_mode,
            fallbacks_triggered=fallbacks_triggered,
            mesh_workflow=mesh_workflow,
        )
        emit_progress_event(
            {
                "kind": "mesh_build_started",
                "shared_domain_build_mode": planned_build_mode,
                "effective_airbox_target": effective_airbox_target,
                "effective_per_object_targets": effective_per_object_targets,
                "used_size_field_kinds": used_size_field_kinds,
                "fallbacks_triggered": fallbacks_triggered,
                "operation_statuses": [
                    status.to_dict() for status in planned_operation_statuses
                ],
                "message": "Preparing shared-domain mesh inputs",
            }
        )
        result: SharedDomainMeshResult | None = None
        build_mode = "component_aware"

        def _emit_mesh_build_failed(exc: Exception) -> None:
            payload: dict[str, object] = {
                "kind": "mesh_build_failed",
                "phase": latest_mesh_phase,
                "shared_domain_build_mode": build_mode,
                "effective_airbox_target": effective_airbox_target,
                "effective_per_object_targets": effective_per_object_targets,
                "used_size_field_kinds": used_size_field_kinds,
                "fallbacks_triggered": fallbacks_triggered,
                "rejected_element_types": [
                    dict(element)
                    for element in getattr(exc, "rejected_element_types", [])
                ],
                "operation_statuses": [
                    status.to_dict()
                    for status in _build_mesh_operation_statuses(
                        geometries,
                        mesh_options,
                        airbox=airbox,
                        build_mode=build_mode,
                        fallbacks_triggered=fallbacks_triggered,
                        mesh_workflow=mesh_workflow,
                    )
                ],
                "error": str(exc),
                "message": "Shared-domain mesh build failed",
            }
            if mixed_shared_geo_direct:
                payload["mixed_layer_topology_rejection"] = {
                    "schema_version": "mixed_layer_topology_rejection.v1",
                    "certificate_status": "rejected",
                    "requested_layer_count": int(
                        mesh_options.through_thickness_elements or 0
                    ),
                    "rejection_reason": str(exc),
                }
            emit_progress_event(payload)

        latest_mesh_phase = "preparing_domain"
        try:
            emit_progress_event(
                {
                    "kind": "mesh_build_phase",
                    "phase": latest_mesh_phase,
                    "message": "Preparing shared-domain inputs and mesh size fields",
                }
            )
            if mesh_options.size_fields:
                emit_progress(
                    f"Shared-domain local sizing active ({len(mesh_options.size_fields)} size fields)"
                )

            effective_hmax = (
                qualified_mixed_body_hmax
                if mixed_shared_geo_direct and qualified_mixed_body_hmax is not None
                else float(hints.hmax)
            )
            if (
                not mixed_shared_geo_direct
                and airbox is not None
                and airbox.maximum_element_size is not None
                and float(airbox.maximum_element_size) > effective_hmax
            ):
                effective_hmax = float(airbox.maximum_element_size)
            if not mixed_shared_geo_direct:
                for field in mesh_options.size_fields:
                    vin = field.get("params", {}).get("VIn") if isinstance(field.get("params"), dict) else None
                    if isinstance(vin, (int, float)) and float(vin) > effective_hmax:
                        effective_hmax = float(vin)

            latest_mesh_phase = "meshing"
            if single_geometry_occ_direct:
                build_mode = (
                    "single_geometry_geo_mixed"
                    if mixed_shared_geo_direct
                    else "single_geometry_occ"
                )
                emit_progress_event(
                    {
                        "kind": "mesh_build_phase",
                        "phase": "meshing",
                        "message": (
                            "Generating shared-GEO prism/pyramid/tetrahedron mesh"
                            if mixed_shared_geo_direct
                            else "Generating direct OCC 3D tetrahedral mesh"
                        ),
                    }
                )
                emit_progress(
                    "Single-geometry shared-GEO mixed mesh path selected"
                    if mixed_shared_geo_direct
                    else "Single-geometry OCC mesh path selected (skipping STL component import)"
                )
                mesh = generate_mesh(
                    geometries[0],
                    hmax=effective_hmax,
                    order=hints.order,
                    airbox=airbox,
                    options=mesh_options,
                )
            else:
                # Decide between native OCC-conformal pipeline or single-pass STL pipeline
                from ._gmsh_occ import generate_shared_domain_mesh_via_occ

                is_stl_multi = len(geometries) > 1 and any(isinstance(g, ImportedGeometry) for g in geometries)

                try:
                    if conformal_occ_direct:
                        build_mode = "conformal_occ"
                        emit_progress_event(
                            {
                                "kind": "mesh_build_phase",
                                "phase": "meshing",
                                "message": "Generating native OCC-conformal 3D tetrahedral mesh",
                            }
                        )
                        attempted_algorithms = {int(mesh_options.algorithm_3d)}
                        attempt_index = 0
                        while True:
                            attempt_index += 1
                            current_algorithm_name = _conformal_occ_algorithm_name(
                                int(mesh_options.algorithm_3d)
                            )
                            emit_progress(
                                f"Conformal OCC mesh attempt {attempt_index} started with "
                                f"{current_algorithm_name} (progress is indeterminate)"
                            )
                            emit_progress_event(
                                {
                                    "kind": "mesh_build_phase",
                                    "phase": "meshing",
                                    "attempt_index": attempt_index,
                                    "algorithm_3d": current_algorithm_name,
                                    "attempt_status": "active",
                                    "progress_kind": "indeterminate",
                                    "progress_label": (
                                        f"Attempt {attempt_index} — {current_algorithm_name} — "
                                        "progress indeterminate"
                                    ),
                                    "message": (
                                        f"Conformal OCC mesh attempt {attempt_index} started "
                                        f"with {current_algorithm_name}"
                                    ),
                                }
                            )
                            result = generate_shared_domain_mesh_via_occ(
                                geometries,
                                hmax=effective_hmax,
                                order=hints.order,
                                airbox=airbox,
                                options=mesh_options,
                                object_regions=object_regions,
                            )
                            try:
                                result.mesh.validate_strict(
                                    require_positive_orientation=True,
                                    eps_volume=_execution_mesh_volume_epsilon(result.mesh),
                                )
                                emit_progress_event(
                                    {
                                        "kind": "mesh_build_phase",
                                        "phase": "meshing",
                                        "attempt_index": attempt_index,
                                        "algorithm_3d": current_algorithm_name,
                                        "attempt_status": "completed",
                                        "progress_kind": "indeterminate",
                                        "progress_label": (
                                            f"Attempt {attempt_index} — {current_algorithm_name} — "
                                            "completed"
                                        ),
                                        "message": (
                                            f"Conformal OCC mesh attempt {attempt_index} completed "
                                            f"with {current_algorithm_name}"
                                        ),
                                    }
                                )
                                break
                            except ValueError as exc:
                                retry = (
                                    _conformal_occ_degenerate_retry(
                                        mesh_options,
                                        attempted_algorithms,
                                    )
                                    if "degenerate" in str(exc) and "Jacobian" in str(exc)
                                    else None
                                )
                                if retry is None:
                                    raise
                                retry_algorithm, _retry_message, retry_marker = retry
                                if retry_algorithm in attempted_algorithms:
                                    raise
                                emit_progress_event(
                                    {
                                        "kind": "mesh_build_phase",
                                        "phase": "meshing",
                                        "attempt_index": attempt_index,
                                        "algorithm_3d": current_algorithm_name,
                                        "attempt_status": "failed_recoverable",
                                        "attempt_failure_reason": str(exc),
                                        "next_algorithm_3d": _conformal_occ_algorithm_name(
                                            retry_algorithm
                                        ),
                                        "progress_kind": "indeterminate",
                                        "progress_label": (
                                            f"Attempt {attempt_index} — {current_algorithm_name} — "
                                            "failed; retrying"
                                        ),
                                        "message": (
                                            f"Conformal OCC mesh attempt {attempt_index} failed "
                                            f"with {current_algorithm_name}; retrying with "
                                            f"{_conformal_occ_algorithm_name(retry_algorithm)}"
                                        ),
                                    }
                                )
                                emit_progress(
                                    f"Conformal OCC mesh attempt {attempt_index} failed "
                                    f"({current_algorithm_name}: {exc}); "
                                    f"starting attempt {attempt_index + 1} with "
                                    f"{_conformal_occ_algorithm_name(retry_algorithm)}"
                                )
                                fallbacks_triggered.append(retry_marker)
                                attempted_algorithms.add(retry_algorithm)
                                mesh_options = _dc_replace(
                                    mesh_options,
                                    algorithm_3d=retry_algorithm,
                                )
                        mesh = result.mesh
                        emit_progress(
                            f"Conformal OCC mesh: geometry→volume mapping established for "
                            f"{len(result.component_volume_tags)} components"
                        )
                    elif is_stl_multi:
                        build_mode = "component_aware"
                        raise RuntimeError(
                            "Multi-component STL meshing is routed to concatenated STL fallback for numerical stability"
                        )
                    elif preemptive_imported_stl_fallback:
                        build_mode = "concatenated_stl_fallback"
                        raise RuntimeError(
                            "Single imported STL meshing is routed to concatenated STL fallback for numerical stability"
                        )
                    else:
                        build_mode = "component_aware"
                        emit_progress_event(
                            {
                                "kind": "mesh_build_phase",
                                "phase": "meshing",
                                "message": "Generating component-aware 3D tetrahedral mesh",
                            }
                        )
                        result = generate_shared_domain_mesh_from_components(
                            component_descriptors,
                            hmax=effective_hmax,
                            order=hints.order,
                            airbox=airbox,
                            options=mesh_options,
                        )
                        mesh = result.mesh
                        emit_progress(
                            f"Component-aware mesh: geometry→volume mapping established for "
                            f"{len(result.component_volume_tags)} components"
                        )
                except Exception as primary_exc:
                    if conformal_object_regions:
                        raise
                    # If conformal OCC failed, fall back safely to component-aware STL mesh
                    if build_mode == "conformal_occ":
                        build_mode = "component_aware"
                        fallbacks_triggered.append("conformal_occ_failed")
                        emit_progress(
                            f"Conformal OCC mesh failed ({primary_exc!r}), falling back to STL component-aware mesh"
                        )
                        try:
                            _prepare_component_descriptors()
                            result = generate_shared_domain_mesh_from_components(
                                component_descriptors,
                                hmax=effective_hmax,
                                order=hints.order,
                                airbox=airbox,
                                options=mesh_options,
                            )
                            mesh = result.mesh
                            emit_progress(
                                f"Component-aware mesh: geometry→volume mapping established for "
                                f"{len(result.component_volume_tags)} components"
                            )
                            primary_exc = None  # successfully recovered!
                        except Exception as stl_exc:
                            primary_exc = stl_exc

                    if primary_exc is not None:
                        build_mode = "concatenated_stl_fallback"
                        if _PREEMPTIVE_IMPORTED_STL_FALLBACK in fallbacks_triggered:
                            emit_progress(
                                "Generating concatenated STL mesh for single imported STL"
                            )
                        else:
                            fallbacks_triggered.append("component_aware_import_failed")
                            emit_progress(
                                f"Component-aware mesh failed ({primary_exc!r}), falling back to concatenated STL"
                            )
                        # Rebuild mesh options for the non-component STL path so local
                        # refinement fields do not depend on recovered component tags.
                        # This preserves per-object hmax behavior (Box/Bounds thresholds)
                        # even when component-aware tagging fails.
                        mesh_options = _mesh_options_from_runtime_metadata(
                            mesh_workflow,
                            geometries=geometries,
                            default_hmax=size_field_default_hmax,
                            bounds_by_name=bounds_by_name,
                            airbox_bounds=airbox_bounds,
                            component_aware=False,
                            per_object_recipes=per_object_recipes,
                            object_regions=object_regions,
                        )
                        if per_object_recipes:
                            _policy = (
                                assembly_policy if assembly_policy is not None else SharedMeshAssemblyPolicy()
                            )
                            recipe_fields = _resolve_per_object_mesh_options(
                                geometries,
                                per_object_recipes,
                                _policy,
                                default_hmax=size_field_default_hmax,
                                bounds_by_name=bounds_by_name,
                                component_aware=False,
                            )
                            if recipe_fields:
                                existing = _strip_overridden_geometry_fields(
                                    list(mesh_options.size_fields), per_object_recipes
                                )
                                mesh_options = _dc_replace(
                                    mesh_options, size_fields=recipe_fields + existing
                                )
                        used_size_field_kinds = _unique_size_field_kinds(list(mesh_options.size_fields))
                        if mesh_options.size_fields:
                            emit_progress(
                                f"Fallback local sizing active ({len(mesh_options.size_fields)} size fields)"
                            )
                        trimesh = _prepare_component_descriptors()
                        component_meshes = [
                            _sanitize_surface_mesh_for_stl_export(
                                _geometry_to_trimesh(
                                    g,
                                    trimesh,
                                    **_surface_trimesh_kwargs_for_geometry(
                                        g,
                                        surface_trimesh_kwargs,
                                        mesh_workflow,
                                    ),
                                )
                            )
                            for g in geometries
                        ]
                        combined_surface = _sanitize_surface_mesh_for_stl_export(
                            trimesh.util.concatenate(component_meshes)
                        )
                        surface_path = Path(tmp_dir) / "shared_domain_surface.stl"
                        combined_surface.export(surface_path)
                        from .gmsh_bridge import generate_mesh_from_file
                        mesh = generate_mesh_from_file(
                            surface_path,
                            hmax=effective_hmax,
                            order=hints.order,
                            airbox=airbox,
                            options=mesh_options,
                        )
        except Exception as exc:
            _emit_mesh_build_failed(exc)
            raise

    latest_mesh_phase = "postprocessing"
    try:
        emit_progress_event(
            {
                "kind": "mesh_build_phase",
                "phase": latest_mesh_phase,
                "message": "Classifying the shared-domain mesh and finalizing region markers",
            }
        )
        if (
            build_mode != "conformal_occ"
            and getattr(mesh, "mixed_layer_topology_certificate", None) is None
        ):
            mesh = _drop_degenerate_tetrahedra(
                mesh,
                context=f"{build_mode} shared-domain mesh",
                fallbacks_triggered=fallbacks_triggered,
            )

        # Classify elements back to geometries
        source_markers = np.asarray(mesh.element_markers, dtype=np.int32)
        assigned_markers = np.zeros(mesh.n_elements, dtype=np.int32)
        region_markers: list[dict[str, object]] = []
        object_region_markers: list[dict[str, object]] = []
        if result is not None:
            for used_marker, geometry in enumerate(geometries, start=1):
                source_marker = result.component_marker_tags.get(geometry.geometry_name)
                if source_marker is None:
                    raise ValueError(
                        f"component-aware shared FEM domain mesh is missing a marker for geometry "
                        f"'{geometry.geometry_name}'"
                    )
                assigned_markers[source_markers == source_marker] = used_marker
                region_markers.append(
                    {"geometry_name": geometry.geometry_name, "marker": used_marker}
                )
            next_marker = len(geometries) + 1
            for region in conformal_object_regions:
                region_id = str(region.get("region_id", "")).strip()
                source_marker = result.object_region_marker_tags.get(region_id)
                if source_marker is None:
                    raise ValueError(
                        f"conformal shared FEM domain mesh is missing marker for "
                        f"object region '{region_id}'"
                    )
                assigned_markers[source_markers == source_marker] = next_marker
                object_region_markers.append(
                    {"geometry_name": region_id, "marker": next_marker}
                )
                next_marker += 1
        else:
            marker_mapping = _match_geometry_bounds_to_source_markers(geometries, mesh)
            if marker_mapping is not None:
                for used_marker, geometry in enumerate(geometries, start=1):
                    source_marker = marker_mapping.get(geometry.geometry_name)
                    if source_marker is None:
                        raise ValueError(
                            f"shared FEM domain mesh classification could not map geometry "
                            f"'{geometry.geometry_name}' to a source marker"
                        )
                    assigned_markers[source_markers == source_marker] = used_marker
                    region_markers.append(
                        {"geometry_name": geometry.geometry_name, "marker": used_marker}
                    )
            else:
                element_centroids = np.asarray(
                    [
                        mesh.nodes[mesh.cell_node_ids(index)].mean(axis=0)
                        for index in range(mesh.n_elements)
                    ],
                    dtype=np.float64,
                )
                used_marker = 1
                for geometry in geometries:
                    inside = _contains_points_in_geometry(geometry, element_centroids)
                    overlap = inside & (assigned_markers != 0)
                    if np.any(overlap):
                        raise ValueError(
                            f"shared FEM domain mesh classification overlapped for '{geometry.geometry_name}'"
                        )
                    assigned_markers[inside] = used_marker
                    region_markers.append(
                        {"geometry_name": geometry.geometry_name, "marker": used_marker}
                    )
                    used_marker += 1

        if result is None and np.any(assigned_markers == 0):
            magnetic_source_mask = source_markers == 1
            if np.any(magnetic_source_mask & (assigned_markers == 0)):
                raise ValueError(
                    "shared FEM domain mesh contains magnetic elements that could not be mapped "
                    "back to any geometry"
                )

        tet4_only = bool(np.all(mesh.cell_types == "tet4"))
        classified_mesh = MeshData(
            nodes=mesh.nodes,
            cell_types=mesh.cell_types,
            cell_offsets=mesh.cell_offsets,
            cell_nodes=mesh.cell_nodes,
            element_markers=assigned_markers,
            facet_types=mesh.facet_types,
            facet_roles=mesh.facet_roles,
            facet_offsets=mesh.facet_offsets,
            facet_nodes=mesh.facet_nodes,
            boundary_markers=mesh.boundary_markers,
            cell_global_ordinals=mesh.cell_global_ordinals,
            facet_global_ordinals=mesh.facet_global_ordinals,
            cell_mesh_parts=mesh.cell_mesh_parts,
            periodic_boundary_pairs=mesh.periodic_boundary_pairs,
            periodic_node_pairs=mesh.periodic_node_pairs,
            periodic_mesh_certificate=mesh.periodic_mesh_certificate,
            quality=mesh.quality,
            per_domain_quality=(
                build_per_domain_quality_from_mesh_arrays(
                    mesh.nodes,
                    mesh.elements,
                    assigned_markers,
                    mesh.quality,
                )
                if tet4_only
                else None
            ) or mesh.per_domain_quality,
            realization_report=mesh.realization_report,
            mixed_layer_topology_certificate=(
                mesh.mixed_layer_topology_certificate
                if np.array_equal(assigned_markers, mesh.element_markers)
                else None
            ),
        )
        requested_airbox_hmax, requested_hmax_by_geometry = _resolve_requested_partition_hmaxs(
            geometries, hints, airbox=airbox, mesh_workflow=mesh_workflow,
            per_object_recipes=per_object_recipes,
        )
        _emit_shared_domain_mesh_summary(
            classified_mesh, region_markers,
            requested_airbox_hmax=requested_airbox_hmax,
            requested_hmax_by_geometry=requested_hmax_by_geometry,
        )
        magnetic_submesh_signatures = _magnetic_submesh_signatures(
            classified_mesh,
            region_markers,
        )
        report = _build_shared_domain_build_report(
            geometries,
            hints,
            airbox=airbox,
            mesh_workflow=mesh_workflow,
            per_object_recipes=per_object_recipes,
            size_fields=list(mesh_options.size_fields),
            region_markers=region_markers,
            build_mode=build_mode,
            fallbacks_triggered=fallbacks_triggered,
            mesh_options=mesh_options,
            selector_resolution=result.selector_resolution if result is not None else [],
            boundary_layer_result=result.boundary_layer_result if result is not None else None,
            orphan_entities=result.orphan_entities if result is not None else [],
            magnetic_submesh_signatures=magnetic_submesh_signatures,
        )
        if classified_mesh.mixed_layer_topology_certificate is not None:
            report = _dc_replace(
                report,
                mixed_layer_topology_certificate=(
                    classified_mesh.mixed_layer_topology_certificate.to_dict()
                ),
            )
        if object_regions is not None:
            report = _dc_replace(
                report,
                object_region_markers=object_region_markers,
                authored_regions_count=max(
                    report.authored_regions_count,
                    len(object_regions),
                ),
                realized_regions_count=max(
                    report.realized_regions_count,
                    len(object_region_markers),
                ),
            )
        emit_progress_event(
            {
                "kind": "mesh_build_summary",
                "shared_domain_build_mode": report.build_mode,
                "n_nodes": classified_mesh.n_nodes,
                "n_elements": classified_mesh.n_elements,
                "n_boundary_faces": classified_mesh.n_boundary_faces,
                "mesh_statistics": classified_mesh.to_ir("shared_domain").get("mesh_statistics"),
                **{k: v for k, v in report.to_dict().items() if k != "build_mode"},
                "message": "Shared-domain mesh build finished",
            }
        )
        return classified_mesh, region_markers, report
    except Exception as exc:
        _emit_mesh_build_failed(exc)
        raise


def realize_fem_domain_mesh_asset_from_components(
    geometries: list[Geometry],
    hints: FEM,
    *,
    study_universe: Mapping[str, object] | None = None,
    mesh_workflow: Mapping[str, object] | None = None,
    per_object_recipes: dict[str, PerObjectMeshRecipe] | None = None,
    assembly_policy: SharedMeshAssemblyPolicy | None = None,
    object_regions: list[dict[str, object]] | None = None,
) -> tuple[MeshData, list[dict[str, object]]]:
    mesh, region_markers, _report = _realize_fem_domain_mesh_asset_from_components_impl(
        geometries,
        hints,
        study_universe=study_universe,
        mesh_workflow=mesh_workflow,
        per_object_recipes=per_object_recipes,
        assembly_policy=assembly_policy,
        object_regions=object_regions,
    )
    return mesh, region_markers


def realize_fem_domain_mesh_asset_from_components_with_report(
    geometries: list[Geometry],
    hints: FEM,
    *,
    study_universe: Mapping[str, object] | None = None,
    mesh_workflow: Mapping[str, object] | None = None,
    per_object_recipes: dict[str, PerObjectMeshRecipe] | None = None,
    assembly_policy: SharedMeshAssemblyPolicy | None = None,
    object_regions: list[dict[str, object]] | None = None,
) -> tuple[MeshData, list[dict[str, object]], SharedDomainBuildReport]:
    return _realize_fem_domain_mesh_asset_from_components_impl(
        geometries,
        hints,
        study_universe=study_universe,
        mesh_workflow=mesh_workflow,
        per_object_recipes=per_object_recipes,
        assembly_policy=assembly_policy,
        object_regions=object_regions,
    )


def realize_fdm_grid_asset(
    geometry: Geometry,
    hints: FDM,
    *,
    study_universe: Mapping[str, object] | None = None,
) -> VoxelMaskData:
    """Resolve an FDM grid asset by voxelizing the shared geometry contract."""

    base_geometry, translation = _split_outer_translation(geometry)
    tight = voxelize_geometry(base_geometry, hints.cell)
    return _apply_study_universe_to_fdm_asset(
        tight,
        translation=translation,
        study_universe=study_universe,
    )
