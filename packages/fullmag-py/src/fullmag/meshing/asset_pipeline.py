from __future__ import annotations

import math
import tempfile
from pathlib import Path
from typing import Any, Mapping

import numpy as np

from fullmag._progress import emit_progress, emit_progress_event
from fullmag.model.discretization import FDM, FEM, PerObjectMeshRecipe, SharedMeshAssemblyPolicy
from fullmag.model.domain_frame import geometry_bounds
from fullmag.model.geometry import (
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
    AirboxOptions,
    ComponentDescriptor,
    MeshData,
    MeshOptions,
    SharedDomainMeshResult,
    generate_mesh,
    generate_mesh_from_file,
    generate_shared_domain_mesh_from_components,
)
from .surface_assets import _geometry_to_trimesh, _import_trimesh, build_surface_preview_payload
from .voxelization import VoxelMaskData, voxelize_geometry

# PR 2: target resolution extracted into _mesh_targets
from ._mesh_targets import (
    ResolvedAirboxTarget,
    ResolvedObjectPreviewTarget,
    ResolvedSharedDomainTargets,
    ResolvedSharedObjectTarget,
    SharedDomainBuildReport,
    _unique_size_field_kinds,
    resolve_object_preview_target,
    resolve_shared_domain_targets,
)
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


def _surface_preview_to_mesh_data(preview: dict[str, object]) -> MeshData:
    nodes = np.asarray(preview.get("nodes", []), dtype=np.float64)
    boundary_faces = np.asarray(preview.get("boundary_faces", []), dtype=np.int32)
    if nodes.ndim != 2 or nodes.shape[1] != 3:
        raise ValueError("surface preview nodes must have shape (N, 3)")
    if boundary_faces.ndim != 2 or (boundary_faces.size and boundary_faces.shape[1] != 3):
        raise ValueError("surface preview boundary_faces must have shape (F, 3)")
    return MeshData(
        nodes=nodes,
        elements=np.zeros((0, 4), dtype=np.int32),
        element_markers=np.zeros((0,), dtype=np.int32),
        boundary_faces=boundary_faces,
        boundary_markers=np.ones((boundary_faces.shape[0],), dtype=np.int32),
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
                    f"{len(preview['nodes'])} vertices, {len(preview['boundary_faces'])} faces"
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
        emit_progress(
            f"Using surface-only mesh for '{geometry.geometry_name}' "
            f"with {len(preview['boundary_faces'])} boundary faces"
        )
        return _surface_preview_to_mesh_data(preview)

    if hints.mesh is not None:
        emit_progress(f"Resolving FEM mesh from source '{hints.mesh}'")
        mesh = generate_mesh_from_file(hints.mesh, hmax=target.hmax, order=target.order)
    else:
        emit_progress(
            f"Generating FEM mesh from geometry '{geometry.geometry_name}' "
            f"with maximum_element_size={target.hmax:.4e} (source={target.source})"
        )
        mesh = generate_mesh(geometry, hmax=target.hmax, order=target.order)

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
    if not study_universe:
        return tight

    mode = study_universe.get("mode")
    resolved_mode = str(mode) if isinstance(mode, str) else "auto"
    padding = _optional_vec3(study_universe.get("padding")) or (0.0, 0.0, 0.0)
    cell = tight.cell_size
    tight_cells = (tight.shape[2], tight.shape[1], tight.shape[0])
    tight_size = tuple(float(tight_cells[axis] * cell[axis]) for axis in range(3))

    if resolved_mode == "manual":
        declared_size = _optional_vec3(study_universe.get("size"))
        if declared_size is None:
            return tight
        center = _optional_vec3(study_universe.get("center")) or (0.0, 0.0, 0.0)
        domain_cells = _cells_from_size(declared_size, cell)
        realized_size = tuple(float(domain_cells[axis] * cell[axis]) for axis in range(3))
        domain_origin = tuple(
            float(center[axis] - realized_size[axis] * 0.5 - translation[axis])
            for axis in range(3)
        )
        return _expand_mask_to_domain(
            tight,
            domain_origin=domain_origin,
            domain_cells=domain_cells,
        )

    if any(component > 0.0 for component in padding):
        tight_center = tuple(
            float(tight.origin[axis] + tight_size[axis] * 0.5)
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
            tight,
            domain_origin=domain_origin,
            domain_cells=domain_cells,
        )

    return tight


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
        return (
            points[:, 0] ** 2 + points[:, 1] ** 2 <= radius * radius
        ) & (np.abs(points[:, 2]) <= height / 2.0)
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
    element_nodes = mesh.nodes[mesh.elements[mask].reshape(-1)]
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
    if mesh.elements.size == 0 or not np.any(element_mask):
        return 0
    return int(np.unique(mesh.elements[element_mask].reshape(-1)).size)


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
) -> dict[str, tuple[float, float]] | None:
    if mesh.elements.size == 0 or not np.any(element_mask):
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
    return {
        "characteristic_size": (
            float(np.min(characteristic)),
            float(np.max(characteristic)),
        ),
        "edge_span": (
            float(np.min(edge_span)),
            float(np.max(edge_span)),
        ),
    }


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
            "source": target.source,
        }
    return effective_airbox_target, effective_per_object_targets


def _build_shared_domain_build_report(
    geometries: list[Geometry],
    hints: FEM,
    *,
    airbox: AirboxOptions | None,
    mesh_workflow: Mapping[str, object] | None,
    per_object_recipes: dict[str, PerObjectMeshRecipe] | None,
    size_fields: list[dict[str, object]],
    region_markers: list[dict[str, object]],
    build_mode: str,
    fallbacks_triggered: list[str],
) -> SharedDomainBuildReport:
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
    # Attach region markers to per-object targets using dataclass replace.
    from dataclasses import replace as _dc_replace
    per_object_targets: dict[str, ResolvedSharedObjectTarget] = dict(resolved.per_object)
    for region in region_markers:
        geometry_name = region.get("geometry_name")
        marker = region.get("marker")
        if isinstance(geometry_name, str) and geometry_name in per_object_targets:
            per_object_targets[geometry_name] = _dc_replace(
                per_object_targets[geometry_name],
                marker=int(marker) if isinstance(marker, (int, np.integer)) else None,
            )
    # degraded = True when a fallback was triggered or size fields had to be
    # simplified (component identity lost).
    degraded = bool(fallbacks_triggered) or build_mode != "component_aware"
    return SharedDomainBuildReport(
        build_mode=build_mode,
        fallbacks_triggered=list(fallbacks_triggered),
        effective_airbox_target=resolved.airbox,
        effective_per_object_targets=per_object_targets,
        used_size_field_kinds=_unique_size_field_kinds(size_fields),
        degraded=degraded,
    )


def _emit_shared_domain_mesh_summary(
    mesh: MeshData,
    region_markers: list[dict[str, object]],
    *,
    requested_airbox_hmax: float | None = None,
    requested_hmax_by_geometry: Mapping[str, float | None] | None = None,
) -> None:
    emit_progress(
        "Total mesh: "
        f"{mesh.elements.shape[0]} tetrahedra, {mesh.nodes.shape[0]} nodes, "
        f"{mesh.boundary_faces.shape[0]} boundary faces"
    )

    element_markers = np.asarray(mesh.element_markers, dtype=np.int32)
    air_mask = element_markers == 0
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
            edge_span = air_metrics.get("edge_span")
            if characteristic is not None:
                parts.append(
                    "characteristic size: "
                    f"{_format_length_m(characteristic[0])} -> {_format_length_m(characteristic[1])}"
                )
            if edge_span is not None:
                parts.append(
                    "edge span: "
                    f"{_format_length_m(edge_span[0])} -> {_format_length_m(edge_span[1])}"
                )
            if parts:
                air_size_suffix = ", " + ", ".join(parts)
        emit_progress(
            "Mesh part airbox: "
            f"{int(np.count_nonzero(air_mask))} tetrahedra, "
            f"{_count_nodes_for_element_mask(mesh, air_mask)} nodes"
            f"{air_size_suffix}"
        )

    for entry in region_markers:
        geometry_name = entry.get("geometry_name")
        marker = entry.get("marker")
        if not isinstance(geometry_name, str) or not isinstance(marker, int):
            continue
        part_mask = element_markers == int(marker)
        part_label = _display_mesh_partition_name(geometry_name)
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
            edge_span = part_metrics.get("edge_span")
            if characteristic is not None:
                parts.append(
                    "characteristic size: "
                    f"{_format_length_m(characteristic[0])} -> {_format_length_m(characteristic[1])}"
                )
            if edge_span is not None:
                parts.append(
                    "edge span: "
                    f"{_format_length_m(edge_span[0])} -> {_format_length_m(edge_span[1])}"
                )
            if parts:
                part_size_suffix = ", " + ", ".join(parts)
        emit_progress(
            f"Mesh part {part_label}: "
            f"{int(np.count_nonzero(part_mask))} tetrahedra, "
            f"{_count_nodes_for_element_mask(mesh, part_mask)} nodes"
            f"{part_size_suffix}"
        )


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
        if recipe.hmax is not None and float(recipe.hmax) > 0.0:
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
) -> tuple[MeshData, list[dict[str, object]]]:
    if not geometries:
        raise ValueError("shared FEM domain mesh requires at least one geometry")

    airbox = _study_universe_airbox_options(geometries, study_universe)
    if airbox is None:
        raise ValueError(
            "shared FEM domain mesh generation requires a declared study universe "
            "(manual size/center or auto padding)"
        )

    trimesh = _import_trimesh()
    component_meshes = []
    for geometry in geometries:
        component_mesh = _geometry_to_trimesh(geometry, trimesh)
        component_meshes.append(component_mesh.copy())

    # Compute bounds directly from already-loaded, scaled component meshes (SI coords).
    # This is more reliable than geometry_bounds(source_root=None) which may fail to
    # locate ImportedGeometry STL files when the subprocess CWD differs from the script dir.
    bounds_by_name: dict[str, tuple] = {}
    for geometry, comp_mesh in zip(geometries, component_meshes):
        verts = np.asarray(comp_mesh.vertices)
        bounds_by_name[geometry.geometry_name] = (
            tuple(float(v) for v in verts.min(axis=0)),
            tuple(float(v) for v in verts.max(axis=0)),
        )

    combined_surface = trimesh.util.concatenate(component_meshes)
    with tempfile.TemporaryDirectory(prefix="fullmag-fem-domain-") as tmp_dir:
        surface_path = Path(tmp_dir) / "shared_domain_surface.stl"
        combined_surface.export(surface_path)
        emit_progress("Preparing shared FEM domain mesh asset")
        mesh_options = _mesh_options_from_runtime_metadata(
            mesh_workflow,
            geometries=geometries,
            default_hmax=float(hints.hmax),
            bounds_by_name=bounds_by_name,
        )
        # Overlay per-object recipe size fields on top of the workflow fields.
        if per_object_recipes:
            _policy = assembly_policy if assembly_policy is not None else SharedMeshAssemblyPolicy()
            recipe_fields = _resolve_per_object_mesh_options(
                geometries,
                per_object_recipes,
                _policy,
                default_hmax=float(hints.hmax),
                bounds_by_name=bounds_by_name,
            )
            if recipe_fields:
                # Remove runtime workflow fields for geometries overridden by
                # recipes so that a coarser recipe can relax the mesh without
                # the finer workflow field winning via Gmsh Min.
                existing = _strip_overridden_geometry_fields(
                    list(mesh_options.size_fields), per_object_recipes
                )
                from dataclasses import replace as _dc_replace  # local import to avoid polluting module namespace
                mesh_options = _dc_replace(mesh_options, size_fields=recipe_fields + existing)
                emit_progress(
                    f"Per-object mesh recipes active: {len(per_object_recipes)} objects, "
                    f"{len(recipe_fields)} extra size fields"
                )
        if mesh_options.size_fields:
            emit_progress(
                f"Shared-domain local sizing active ({len(mesh_options.size_fields)} size fields)"
            )
        # Raise the Gmsh CharacteristicLengthMax to the maximum of all intended element sizes
        # so coarser per-geometry overrides (VIn > hints.hmax) are not silently clamped.
        # The airbox maximum_element_size takes natural precedence as the coarsest intended size.
        effective_hmax = float(hints.hmax)
        if airbox is not None and airbox.maximum_element_size is not None and float(airbox.maximum_element_size) > effective_hmax:
            effective_hmax = float(airbox.maximum_element_size)
        for field in mesh_options.size_fields:
            vin = field.get("params", {}).get("VIn") if isinstance(field.get("params"), dict) else None
            if isinstance(vin, (int, float)) and float(vin) > effective_hmax:
                effective_hmax = float(vin)
        mesh = generate_mesh_from_file(
            surface_path,
            hmax=effective_hmax,
            order=hints.order,
            airbox=airbox,
            options=mesh_options,
        )

    source_markers = np.asarray(mesh.element_markers, dtype=np.int32)
    marker_mapping = _match_geometry_bounds_to_source_markers(geometries, mesh)
    assigned_markers = np.zeros(mesh.n_elements, dtype=np.int32)
    region_markers: list[dict[str, object]] = []
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
                {
                    "geometry_name": geometry.geometry_name,
                    "marker": used_marker,
                }
            )
    else:
        element_centroids = mesh.nodes[mesh.elements].mean(axis=1)
        used_marker = 1
        for geometry in geometries:
            inside = _contains_points_in_geometry(geometry, element_centroids)
            overlap = inside & (assigned_markers != 0)
            if np.any(overlap):
                raise ValueError(
                    f"shared FEM domain mesh classification overlapped for geometry '{geometry.geometry_name}'"
                )
            assigned_markers[inside] = used_marker
            region_markers.append(
                {
                    "geometry_name": geometry.geometry_name,
                    "marker": used_marker,
                }
            )
            used_marker += 1

        if np.any(assigned_markers == 0):
            magnetic_source_mask = source_markers == 1
            if np.any(magnetic_source_mask & (assigned_markers == 0)):
                raise ValueError(
                    "shared FEM domain mesh contains magnetic elements that could not be mapped "
                    "back to any geometry"
                )

    classified_mesh = MeshData(
        nodes=mesh.nodes,
        elements=mesh.elements,
        element_markers=assigned_markers,
        boundary_faces=mesh.boundary_faces,
        boundary_markers=mesh.boundary_markers,
        quality=mesh.quality,
        per_domain_quality=mesh.per_domain_quality,
    )
    requested_airbox_hmax, requested_hmax_by_geometry = _resolve_requested_partition_hmaxs(
        geometries,
        hints,
        airbox=airbox,
        mesh_workflow=mesh_workflow,
        per_object_recipes=per_object_recipes,
    )
    _emit_shared_domain_mesh_summary(
        classified_mesh,
        region_markers,
        requested_airbox_hmax=requested_airbox_hmax,
        requested_hmax_by_geometry=requested_hmax_by_geometry,
    )
    return classified_mesh, region_markers


def _realize_fem_domain_mesh_asset_from_components_impl(
    geometries: list[Geometry],
    hints: FEM,
    *,
    study_universe: Mapping[str, object] | None = None,
    mesh_workflow: Mapping[str, object] | None = None,
    per_object_recipes: dict[str, PerObjectMeshRecipe] | None = None,
    assembly_policy: SharedMeshAssemblyPolicy | None = None,
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

    airbox = _study_universe_airbox_options(geometries, study_universe)
    if airbox is None:
        raise ValueError(
            "shared FEM domain mesh generation requires a declared study universe "
            "(manual size/center or auto padding)"
        )
    # Keep component-aware shared-domain meshing as the default even for
    # single-body studies. This preserves the same field-stack behavior and
    # avoids OCC single-body regressions in through-thickness refinement.
    single_geometry_occ_direct = False
    if (
        isinstance(mesh_workflow, Mapping)
        and bool(mesh_workflow.get("single_geometry_occ_direct")) is True
    ):
        single_geometry_occ_direct = (
            len(geometries) == 1 and not isinstance(geometries[0], ImportedGeometry)
        )

    trimesh = _import_trimesh()
    bounds_by_name: dict[str, tuple] = {}

    with tempfile.TemporaryDirectory(prefix="fullmag-fem-domain-components-") as tmp_dir:
        component_descriptors: list[ComponentDescriptor] = []
        for geometry in geometries:
            comp_mesh = _geometry_to_trimesh(geometry, trimesh)
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

        mesh_options = _mesh_options_from_runtime_metadata(
            mesh_workflow,
            geometries=geometries,
            default_hmax=float(hints.hmax),
            bounds_by_name=bounds_by_name,
            component_aware=not single_geometry_occ_direct,
        )
        if per_object_recipes:
            _policy = assembly_policy if assembly_policy is not None else SharedMeshAssemblyPolicy()
            recipe_fields = _resolve_per_object_mesh_options(
                geometries,
                per_object_recipes,
                _policy,
                default_hmax=float(hints.hmax),
                bounds_by_name=bounds_by_name,
                component_aware=not single_geometry_occ_direct,
            )
            if recipe_fields:
                existing = _strip_overridden_geometry_fields(
                    list(mesh_options.size_fields), per_object_recipes
                )
                from dataclasses import replace as _dc_replace
                mesh_options = _dc_replace(mesh_options, size_fields=recipe_fields + existing)
        effective_airbox_target, effective_per_object_targets = _resolve_effective_shared_domain_targets(
            geometries,
            hints,
            airbox=airbox,
            mesh_workflow=mesh_workflow,
            per_object_recipes=per_object_recipes,
        )
        used_size_field_kinds = _unique_size_field_kinds(list(mesh_options.size_fields))
        emit_progress_event(
            {
                "kind": "mesh_build_started",
                "shared_domain_build_mode": (
                    "single_geometry_occ" if single_geometry_occ_direct else "component_aware"
                ),
                "effective_airbox_target": effective_airbox_target,
                "effective_per_object_targets": effective_per_object_targets,
                "used_size_field_kinds": used_size_field_kinds,
                "fallbacks_triggered": [],
                "message": "Preparing shared-domain mesh inputs",
            }
        )
        emit_progress_event(
            {
                "kind": "mesh_build_phase",
                "phase": "preparing_domain",
                "message": "Preparing shared-domain inputs and mesh size fields",
            }
        )
        if mesh_options.size_fields:
            emit_progress(
                f"Shared-domain local sizing active ({len(mesh_options.size_fields)} size fields)"
            )

        effective_hmax = float(hints.hmax)
        if airbox is not None and airbox.maximum_element_size is not None and float(airbox.maximum_element_size) > effective_hmax:
            effective_hmax = float(airbox.maximum_element_size)
        for field in mesh_options.size_fields:
            vin = field.get("params", {}).get("VIn") if isinstance(field.get("params"), dict) else None
            if isinstance(vin, (int, float)) and float(vin) > effective_hmax:
                effective_hmax = float(vin)

        result: SharedDomainMeshResult | None = None
        build_mode = "component_aware"
        fallbacks_triggered: list[str] = []
        try:
            if single_geometry_occ_direct:
                build_mode = "single_geometry_occ"
                emit_progress_event(
                    {
                        "kind": "mesh_build_phase",
                        "phase": "meshing",
                        "message": "Generating direct OCC 3D tetrahedral mesh",
                    }
                )
                emit_progress(
                    "Single-geometry OCC mesh path selected (skipping STL component import)"
                )
                mesh = generate_mesh(
                    geometries[0],
                    hmax=effective_hmax,
                    order=hints.order,
                    airbox=airbox,
                    options=mesh_options,
                )
            else:
                emit_progress_event(
                    {
                        "kind": "mesh_build_phase",
                        "phase": "meshing",
                        "message": "Generating component-aware 3D tetrahedral mesh",
                    }
                )
                try:
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
                except Exception as exc:
                    build_mode = "concatenated_stl_fallback"
                    fallbacks_triggered.append("component_aware_import_failed")
                    emit_progress(
                        f"Component-aware mesh failed ({exc!r}), falling back to concatenated STL"
                    )
                    # Rebuild mesh options for the non-component STL path so local
                    # refinement fields do not depend on recovered component tags.
                    # This preserves per-object hmax behavior (Box/Bounds thresholds)
                    # even when component-aware tagging fails.
                    mesh_options = _mesh_options_from_runtime_metadata(
                        mesh_workflow,
                        geometries=geometries,
                        default_hmax=float(hints.hmax),
                        bounds_by_name=bounds_by_name,
                        component_aware=False,
                    )
                    if per_object_recipes:
                        _policy = (
                            assembly_policy if assembly_policy is not None else SharedMeshAssemblyPolicy()
                        )
                        recipe_fields = _resolve_per_object_mesh_options(
                            geometries,
                            per_object_recipes,
                            _policy,
                            default_hmax=float(hints.hmax),
                            bounds_by_name=bounds_by_name,
                            component_aware=False,
                        )
                        if recipe_fields:
                            existing = _strip_overridden_geometry_fields(
                                list(mesh_options.size_fields), per_object_recipes
                            )
                            from dataclasses import replace as _dc_replace
                            mesh_options = _dc_replace(
                                mesh_options, size_fields=recipe_fields + existing
                            )
                    used_size_field_kinds = _unique_size_field_kinds(list(mesh_options.size_fields))
                    if mesh_options.size_fields:
                        emit_progress(
                            f"Fallback local sizing active ({len(mesh_options.size_fields)} size fields)"
                        )
                    component_meshes = [_geometry_to_trimesh(g, trimesh).copy() for g in geometries]
                    combined_surface = trimesh.util.concatenate(component_meshes)
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
            emit_progress_event(
                {
                    "kind": "mesh_build_phase",
                    "phase": "postprocessing",
                    "message": "Classifying the shared-domain mesh and finalizing region markers",
                }
            )
        except Exception as exc:
            emit_progress_event(
                {
                    "kind": "mesh_build_failed",
                    "shared_domain_build_mode": build_mode,
                    "effective_airbox_target": effective_airbox_target,
                    "effective_per_object_targets": effective_per_object_targets,
                    "used_size_field_kinds": used_size_field_kinds,
                    "fallbacks_triggered": fallbacks_triggered,
                    "error": str(exc),
                    "message": "Shared-domain mesh build failed",
                }
            )
            raise

    # Classify elements back to geometries
    source_markers = np.asarray(mesh.element_markers, dtype=np.int32)
    assigned_markers = np.zeros(mesh.n_elements, dtype=np.int32)
    region_markers: list[dict[str, object]] = []
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
            element_centroids = mesh.nodes[mesh.elements].mean(axis=1)
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

    classified_mesh = MeshData(
        nodes=mesh.nodes,
        elements=mesh.elements,
        element_markers=assigned_markers,
        boundary_faces=mesh.boundary_faces,
        boundary_markers=mesh.boundary_markers,
        quality=mesh.quality,
        per_domain_quality=mesh.per_domain_quality,
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
    )
    emit_progress_event(
        {
            "kind": "mesh_build_summary",
            "shared_domain_build_mode": report.build_mode,
            "n_nodes": classified_mesh.n_nodes,
            "n_elements": classified_mesh.n_elements,
            "n_boundary_faces": classified_mesh.n_boundary_faces,
            **{k: v for k, v in report.to_dict().items() if k != "build_mode"},
            "message": "Shared-domain mesh build finished",
        }
    )
    return classified_mesh, region_markers, report


def realize_fem_domain_mesh_asset_from_components(
    geometries: list[Geometry],
    hints: FEM,
    *,
    study_universe: Mapping[str, object] | None = None,
    mesh_workflow: Mapping[str, object] | None = None,
    per_object_recipes: dict[str, PerObjectMeshRecipe] | None = None,
    assembly_policy: SharedMeshAssemblyPolicy | None = None,
) -> tuple[MeshData, list[dict[str, object]]]:
    mesh, region_markers, _report = _realize_fem_domain_mesh_asset_from_components_impl(
        geometries,
        hints,
        study_universe=study_universe,
        mesh_workflow=mesh_workflow,
        per_object_recipes=per_object_recipes,
        assembly_policy=assembly_policy,
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
) -> tuple[MeshData, list[dict[str, object]], SharedDomainBuildReport]:
    return _realize_fem_domain_mesh_asset_from_components_impl(
        geometries,
        hints,
        study_universe=study_universe,
        mesh_workflow=mesh_workflow,
        per_object_recipes=per_object_recipes,
        assembly_policy=assembly_policy,
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
