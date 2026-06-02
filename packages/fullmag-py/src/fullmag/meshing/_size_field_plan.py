"""Semantic size-field planning layer.

PR 3 — Separates field-stack construction from the asset pipeline so that
size fields can be reasoned about and tested as a pure-data layer.

The functions in this module build *field descriptors* — plain dicts with
``kind`` and ``params`` keys — that are later realized as Gmsh background
fields by ``gmsh_bridge._apply_mesh_options()``.

Field kinds:

Component-aware path (when Gmsh has volume-tag identity):
  - ``ComponentVolumeConstant`` — set size inside a named component volume
  - ``InterfaceShellThreshold`` — refine near component surface (shell)
  - ``TransitionShellThreshold`` — smooth transition from shell to airbox
  - ``AxisAlignedBoxDistanceThreshold`` — analytic air shell around a box-like body
  - ``EdgeDistanceThreshold`` — refine near component boundary curves
  - ``CornerDistanceThreshold`` — refine near component boundary curve endpoints
  - ``ComponentRestrictedBox`` — refine inside a named component sub-box
  - ``ComponentRestrictedCylinder`` — refine inside a named component radial disk

Bounds-based fallback (concatenated-STL or unknown topology):
  - ``Box`` — set size inside an axis-aligned bounding box
  - ``BoundsSurfaceThreshold`` — refine near an inferred surface (bounds)
"""
from __future__ import annotations

import math
from typing import Mapping, Sequence

from fullmag._progress import emit_progress
from fullmag.model.discretization import PerObjectMeshRecipe, SharedMeshAssemblyPolicy
from fullmag.model.domain_frame import geometry_bounds
from fullmag.model.geometry import ArchWaveguide, Box, Geometry, Translate

from .gmsh_bridge import MeshOptions

from ._mesh_targets import (
    _coerce_positive_float,
    _lookup_geometry_name_alias,
    _parse_per_geometry_overrides,
)

_NO_OP_FIELD_SIZE = 1.0e22
_AIRBOX_BOUNDARY_TRANSITION_TOKENS = {"airbox_boundary", "airbox-boundary", "auto_boundary"}


def _is_airbox_boundary_transition(value: object) -> bool:
    return (
        isinstance(value, str)
        and value.strip().lower() in _AIRBOX_BOUNDARY_TRANSITION_TOKENS
    )


def _airbox_boundary_clearance(
    *,
    bounds_min: Sequence[float],
    bounds_max: Sequence[float],
    airbox_bounds: tuple[Sequence[float], Sequence[float]] | None,
    mode: str,
) -> float | None:
    if airbox_bounds is None:
        return None
    airbox_min, airbox_max = airbox_bounds
    gaps = [
        max(
            float(bounds_min[axis]) - float(airbox_min[axis]),
            float(airbox_max[axis]) - float(bounds_max[axis]),
            0.0,
        )
        for axis in range(3)
    ]
    if not any(gap > 0.0 for gap in gaps):
        return None
    if mode == "corner":
        return math.sqrt(sum(gap * gap for gap in gaps))
    return max(gaps)


def _resolve_airbox_boundary_transition_span(
    value: object,
    *,
    bounds_min: Sequence[float],
    bounds_max: Sequence[float],
    airbox_bounds: tuple[Sequence[float], Sequence[float]] | None,
    dist_min: float,
    mode: str,
    context: str,
) -> float | None:
    if not _is_airbox_boundary_transition(value):
        return None
    clearance = _airbox_boundary_clearance(
        bounds_min=bounds_min,
        bounds_max=bounds_max,
        airbox_bounds=airbox_bounds,
        mode=mode,
    )
    if clearance is None:
        raise ValueError(
            f"{context}: airbox_boundary transition distance requires rectangular airbox bounds"
        )
    span = clearance - float(dist_min)
    return max(span, 1.0e-18)


def _unwrap_translated_geometry(geometry: Geometry) -> Geometry | object:
    current: Geometry | object = geometry
    while isinstance(current, Translate):
        current = current.geometry
    return current


def _unwrap_translated_box_geometry(geometry: Geometry) -> Box | None:
    current = _unwrap_translated_geometry(geometry)
    return current if isinstance(current, Box) else None


def _unwrap_translated_flat_arch_waveguide_geometry(geometry: Geometry) -> ArchWaveguide | None:
    current = _unwrap_translated_geometry(geometry)
    if not isinstance(current, ArchWaveguide):
        return None
    tolerance = max(abs(current.height), abs(current.length), 1.0) * 1.0e-15
    return current if math.isclose(current.arch_height, 0.0, abs_tol=tolerance) else None


def _uses_analytic_box_air_shell(geometry: Geometry) -> bool:
    return _unwrap_translated_flat_arch_waveguide_geometry(geometry) is not None


def _perimeter_refinement_config(
    geometry: Geometry,
    *,
    entry: Mapping[str, object] | None,
    component_aware: bool,
) -> dict[str, float] | None:
    if entry is None:
        return None

    edge_hmax = _coerce_positive_float(entry.get("edge_maximum_element_size") or entry.get("edge_hmax"))
    edge_thickness = _coerce_positive_float(entry.get("edge_thickness"))
    corner_hmax = _coerce_positive_float(entry.get("corner_maximum_element_size") or entry.get("corner_hmax"))
    corner_extent = _coerce_positive_float(entry.get("corner_extent"))

    if all(value is None for value in (edge_hmax, edge_thickness, corner_hmax, corner_extent)):
        return None

    if not component_aware:
        emit_progress(
            f"Gmsh: warning - edge/corner refinement for '{geometry.geometry_name}' "
            "requires component-aware shared-domain meshing; skipping in fallback path"
        )
        return None

    if (edge_hmax is None) != (edge_thickness is None):
        raise ValueError(
            f"{geometry.geometry_name}: edge_maximum_element_size and edge_thickness must be set together"
        )
    if (corner_hmax is None) != (corner_extent is None):
        raise ValueError(
            f"{geometry.geometry_name}: corner_maximum_element_size and corner_extent must be set together"
        )
    box = _unwrap_translated_box_geometry(geometry)
    if box is None:
        return {
            key: value
            for key, value in {
                "edge_hmax": edge_hmax,
                "edge_thickness": edge_thickness,
                "corner_hmax": corner_hmax,
                "corner_extent": corner_extent,
            }.items()
            if value is not None
        }

    sx, sy, sz = (float(component) for component in box.size)
    in_plane_dims = sorted((sx, sy, sz), reverse=True)[:2]
    min_in_plane_dim = min(in_plane_dims)
    half_min_in_plane_dim = 0.5 * min_in_plane_dim

    if edge_thickness is not None and edge_thickness >= half_min_in_plane_dim:
        raise ValueError(
            f"{geometry.geometry_name}: edge_thickness must be smaller than half of the smaller in-plane dimension"
        )
    if corner_extent is not None and corner_extent >= half_min_in_plane_dim:
        raise ValueError(
            f"{geometry.geometry_name}: corner_extent must be smaller than half of the smaller in-plane dimension"
        )
    if (
        edge_hmax is not None
        and corner_hmax is not None
        and corner_hmax > edge_hmax
    ):
        raise ValueError(
            f"{geometry.geometry_name}: corner_maximum_element_size must be less than or equal to edge_maximum_element_size"
        )

    return {
        key: value
        for key, value in {
            "edge_hmax": edge_hmax,
            "edge_thickness": edge_thickness,
            "corner_hmax": corner_hmax,
            "corner_extent": corner_extent,
        }.items()
        if value is not None
    }


def _build_perimeter_refinement_fields(
    geometries: list[Geometry],
    *,
    default_hmax: float,
    override_by_name: dict[str, Mapping[str, object]],
    bounds_by_name: dict[str, tuple] | None = None,
    airbox_bounds: tuple[Sequence[float], Sequence[float]] | None = None,
    component_aware: bool = False,
) -> list[dict[str, object]]:
    """Build box-local or component-boundary edge and corner refinement fields."""
    fields: list[dict[str, object]] = []
    for geometry in geometries:
        entry = _lookup_geometry_name_alias(override_by_name, geometry.geometry_name)
        if entry is None:
            continue

        refinement = _perimeter_refinement_config(
            geometry,
            entry=entry,
            component_aware=component_aware,
        )
        if refinement is None:
            continue

        if bounds_by_name is not None:
            bounds_pair = bounds_by_name.get(geometry.geometry_name)
            if bounds_pair is None:
                continue
            bounds_min, bounds_max = bounds_pair
        else:
            bounds_min, bounds_max = geometry_bounds(geometry, source_root=None)
        if bounds_min is None or bounds_max is None:
            continue

        box = _unwrap_translated_box_geometry(geometry)
        if box is None:
            transition_growth = (
                _coerce_positive_float(entry.get("transition_growth"))
                if entry is not None
                else None
            )
            if "edge_hmax" in refinement and "edge_thickness" in refinement:
                edge_thickness = float(refinement["edge_thickness"])
                raw_edge_transition_distance = (
                    entry.get("edge_transition_distance")
                    if entry is not None
                    else None
                )
                edge_transition_distance = _coerce_positive_float(
                    raw_edge_transition_distance
                )
                if edge_transition_distance is None:
                    edge_transition_distance = _resolve_airbox_boundary_transition_span(
                        raw_edge_transition_distance,
                        bounds_min=bounds_min,
                        bounds_max=bounds_max,
                        airbox_bounds=airbox_bounds,
                        dist_min=edge_thickness,
                        mode="side",
                        context=f"{geometry.geometry_name}.mesh.edge_transition_distance",
                    )
                edge_dist_min = edge_thickness if edge_transition_distance is not None else 0.0
                edge_dist_max = (
                    edge_thickness + edge_transition_distance
                    if edge_transition_distance is not None
                    else edge_thickness
                )
                edge_params = {
                    "GeometryName": geometry.geometry_name,
                    "Selector": {"mode": "all_boundary_curves"},
                    "SizeMin": float(refinement["edge_hmax"]),
                    "SizeMax": float(default_hmax),
                    "DistMin": float(edge_dist_min),
                    "DistMax": float(edge_dist_max),
                    "Sampling": 40,
                    "Grading": "geometric",
                    "Source": (
                        "airbox_boundary"
                        if _is_airbox_boundary_transition(raw_edge_transition_distance)
                        else "per_geometry.edge_maximum_element_size"
                    ),
                }
                if transition_growth is not None and transition_growth > 1.0:
                    edge_params["GrowthRate"] = float(transition_growth)
                fields.append(
                    {
                        "kind": "EdgeDistanceThreshold",
                        "params": edge_params,
                    }
                )
            if "corner_hmax" in refinement and "corner_extent" in refinement:
                corner_extent = float(refinement["corner_extent"])
                raw_corner_transition_distance = (
                    entry.get("corner_transition_distance")
                    if entry is not None
                    else None
                )
                corner_transition_distance = (
                    _coerce_positive_float(raw_corner_transition_distance)
                )
                if corner_transition_distance is None:
                    corner_transition_distance = _resolve_airbox_boundary_transition_span(
                        raw_corner_transition_distance,
                        bounds_min=bounds_min,
                        bounds_max=bounds_max,
                        airbox_bounds=airbox_bounds,
                        dist_min=corner_extent,
                        mode="corner",
                        context=f"{geometry.geometry_name}.mesh.corner_transition_distance",
                    )
                corner_dist_min = (
                    corner_extent if corner_transition_distance is not None else 0.0
                )
                corner_dist_max = (
                    corner_extent + corner_transition_distance
                    if corner_transition_distance is not None
                    else corner_extent
                )
                corner_params = {
                    "GeometryName": geometry.geometry_name,
                    "Selector": {"mode": "all_boundary_curve_endpoints"},
                    "SizeMin": float(refinement["corner_hmax"]),
                    "SizeMax": float(default_hmax),
                    "DistMin": float(corner_dist_min),
                    "DistMax": float(corner_dist_max),
                    "Sampling": 20,
                    "Grading": "geometric",
                    "Source": (
                        "airbox_boundary"
                        if _is_airbox_boundary_transition(raw_corner_transition_distance)
                        else "per_geometry.corner_maximum_element_size"
                    ),
                }
                if transition_growth is not None and transition_growth > 1.0:
                    corner_params["GrowthRate"] = float(transition_growth)
                fields.append(
                    {
                        "kind": "CornerDistanceThreshold",
                        "params": corner_params,
                    }
                )
            continue
        size_by_axis = [float(component) for component in box.size]
        in_plane_axes = sorted(range(3), key=lambda axis: size_by_axis[axis], reverse=True)[:2]
        axis_a, axis_b = in_plane_axes
        air_side_fields: list[dict[str, object]] = []
        transition_growth = (
            _coerce_positive_float(entry.get("transition_growth"))
            if entry is not None
            else None
        )

        def add_component_sub_box(
            size_value: float | None,
            min_a: float,
            max_a: float,
            min_b: float,
            max_b: float,
        ) -> None:
            if size_value is None or size_value >= default_hmax:
                return
            local_min = [float(value) for value in bounds_min]
            local_max = [float(value) for value in bounds_max]
            local_min[axis_a] = min_a
            local_max[axis_a] = max_a
            local_min[axis_b] = min_b
            local_max[axis_b] = max_b
            fields.append(
                {
                    "kind": "ComponentRestrictedBox",
                    "params": {
                        "GeometryName": geometry.geometry_name,
                        "VIn": float(size_value),
                        "VOut": float(_NO_OP_FIELD_SIZE),
                        "XMin": float(local_min[0]),
                        "XMax": float(local_max[0]),
                        "YMin": float(local_min[1]),
                        "YMax": float(local_max[1]),
                        "ZMin": float(local_min[2]),
                        "ZMax": float(local_max[2]),
                    },
                }
            )

        if "edge_hmax" in refinement and "edge_thickness" in refinement:
            edge_hmax = float(refinement["edge_hmax"])
            edge_thickness = float(refinement["edge_thickness"])
            add_component_sub_box(
                edge_hmax,
                float(bounds_min[axis_a]),
                float(bounds_min[axis_a]) + edge_thickness,
                float(bounds_min[axis_b]),
                float(bounds_max[axis_b]),
            )
            add_component_sub_box(
                edge_hmax,
                float(bounds_max[axis_a]) - edge_thickness,
                float(bounds_max[axis_a]),
                float(bounds_min[axis_b]),
                float(bounds_max[axis_b]),
            )
            add_component_sub_box(
                edge_hmax,
                float(bounds_min[axis_a]),
                float(bounds_max[axis_a]),
                float(bounds_min[axis_b]),
                float(bounds_min[axis_b]) + edge_thickness,
            )
            add_component_sub_box(
                edge_hmax,
                float(bounds_min[axis_a]),
                float(bounds_max[axis_a]),
                float(bounds_max[axis_b]) - edge_thickness,
                float(bounds_max[axis_b]),
            )
            if edge_hmax < default_hmax:
                raw_edge_transition_distance = (
                    entry.get("edge_transition_distance")
                    if entry is not None
                    else None
                )
                edge_transition_distance = (
                    _coerce_positive_float(raw_edge_transition_distance)
                )
                if edge_transition_distance is None:
                    edge_transition_distance = _resolve_airbox_boundary_transition_span(
                        raw_edge_transition_distance,
                        bounds_min=bounds_min,
                        bounds_max=bounds_max,
                        airbox_bounds=airbox_bounds,
                        dist_min=edge_thickness,
                        mode="side",
                        context=f"{geometry.geometry_name}.mesh.edge_transition_distance",
                    )
                edge_dist_min = edge_thickness if edge_transition_distance is not None else 0.0
                edge_dist_max = (
                    edge_thickness + edge_transition_distance
                    if edge_transition_distance is not None
                    else edge_thickness
                )
                edge_params = {
                    "GeometryName": geometry.geometry_name,
                    "Selector": {"mode": "all_boundary_curves"},
                    "SizeMin": edge_hmax,
                    "SizeMax": float(default_hmax),
                    "DistMin": float(edge_dist_min),
                    "DistMax": float(edge_dist_max),
                    "Sampling": 40,
                    "Grading": "geometric",
                    "Source": (
                        "airbox_boundary"
                        if _is_airbox_boundary_transition(raw_edge_transition_distance)
                        else "per_geometry.edge_maximum_element_size.air_side"
                    ),
                }
                if transition_growth is not None and transition_growth > 1.0:
                    edge_params["GrowthRate"] = float(transition_growth)
                air_side_fields.append(
                    {
                        "kind": "EdgeDistanceThreshold",
                        "params": edge_params,
                    }
                )

        if "corner_hmax" in refinement and "corner_extent" in refinement:
            corner_hmax = float(refinement["corner_hmax"])
            corner_extent = float(refinement["corner_extent"])
            add_component_sub_box(
                corner_hmax,
                float(bounds_min[axis_a]),
                float(bounds_min[axis_a]) + corner_extent,
                float(bounds_min[axis_b]),
                float(bounds_min[axis_b]) + corner_extent,
            )
            add_component_sub_box(
                corner_hmax,
                float(bounds_min[axis_a]),
                float(bounds_min[axis_a]) + corner_extent,
                float(bounds_max[axis_b]) - corner_extent,
                float(bounds_max[axis_b]),
            )
            add_component_sub_box(
                corner_hmax,
                float(bounds_max[axis_a]) - corner_extent,
                float(bounds_max[axis_a]),
                float(bounds_min[axis_b]),
                float(bounds_min[axis_b]) + corner_extent,
            )
            add_component_sub_box(
                corner_hmax,
                float(bounds_max[axis_a]) - corner_extent,
                float(bounds_max[axis_a]),
                float(bounds_max[axis_b]) - corner_extent,
                float(bounds_max[axis_b]),
            )
            if corner_hmax < default_hmax:
                raw_corner_transition_distance = (
                    entry.get("corner_transition_distance")
                    if entry is not None
                    else None
                )
                corner_transition_distance = (
                    _coerce_positive_float(raw_corner_transition_distance)
                )
                if corner_transition_distance is None:
                    corner_transition_distance = _resolve_airbox_boundary_transition_span(
                        raw_corner_transition_distance,
                        bounds_min=bounds_min,
                        bounds_max=bounds_max,
                        airbox_bounds=airbox_bounds,
                        dist_min=corner_extent,
                        mode="corner",
                        context=f"{geometry.geometry_name}.mesh.corner_transition_distance",
                    )
                corner_dist_min = (
                    corner_extent if corner_transition_distance is not None else 0.0
                )
                corner_dist_max = (
                    corner_extent + corner_transition_distance
                    if corner_transition_distance is not None
                    else corner_extent
                )
                corner_params = {
                    "GeometryName": geometry.geometry_name,
                    "Selector": {"mode": "all_boundary_curve_endpoints"},
                    "SizeMin": corner_hmax,
                    "SizeMax": float(default_hmax),
                    "DistMin": float(corner_dist_min),
                    "DistMax": float(corner_dist_max),
                    "Sampling": 20,
                    "Grading": "geometric",
                    "Source": (
                        "airbox_boundary"
                        if _is_airbox_boundary_transition(raw_corner_transition_distance)
                        else "per_geometry.corner_maximum_element_size.air_side"
                    ),
                }
                if transition_growth is not None and transition_growth > 1.0:
                    corner_params["GrowthRate"] = float(transition_growth)
                air_side_fields.append(
                    {
                        "kind": "CornerDistanceThreshold",
                        "params": corner_params,
                    }
                )
        fields.extend(air_side_fields)
    return fields


# ===================================================================
# Legacy Box-only fields (pre-Commit 2 path)
# ===================================================================

def _legacy_box_size_fields(
    geometries: list[Geometry],
    *,
    default_hmax: float,
    per_geometry: object,
    bounds_by_name: dict[str, tuple] | None = None,
) -> list[dict[str, object]]:
    """Build Box-only per-object fields (legacy path, no alias expansion)."""
    if not isinstance(per_geometry, list):
        return []

    override_by_name: dict[str, Mapping[str, object]] = {}
    for entry in per_geometry:
        if not isinstance(entry, Mapping):
            continue
        raw_name = entry.get("geometry") or entry.get("geometry_name")
        if not isinstance(raw_name, str) or not raw_name.strip():
            continue
        override_by_name[raw_name.strip()] = entry

    fields: list[dict[str, object]] = []
    for geometry in geometries:
        if bounds_by_name is not None:
            bounds_pair = bounds_by_name.get(geometry.geometry_name)
            if bounds_pair is None:
                continue
            bounds_min, bounds_max = bounds_pair
        else:
            bounds_min, bounds_max = geometry_bounds(geometry, source_root=None)
        if bounds_min is None or bounds_max is None:
            continue
        entry = override_by_name.get(geometry.geometry_name)
        target_hmax = _coerce_positive_float(entry.get("hmax") if entry else None) or default_hmax
        if target_hmax >= default_hmax:
            continue
        fields.append(
            {
                "kind": "Box",
                "params": {
                    "VIn": float(target_hmax),
                    "VOut": float(default_hmax),
                    "XMin": float(bounds_min[0]),
                    "XMax": float(bounds_max[0]),
                    "YMin": float(bounds_min[1]),
                    "YMax": float(bounds_max[1]),
                    "ZMin": float(bounds_min[2]),
                    "ZMax": float(bounds_max[2]),
                },
            }
        )
    return fields


# ===================================================================
# Layer 1: object bulk fields
# ===================================================================

def _build_object_bulk_fields(
    geometries: list[Geometry],
    *,
    default_hmax: float,
    override_by_name: dict[str, Mapping[str, object]],
    bounds_by_name: dict[str, tuple] | None = None,
    component_aware: bool = False,
) -> list[dict[str, object]]:
    """Build per-object bulk refinement fields."""
    fields: list[dict[str, object]] = []
    for geometry in geometries:
        entry = _lookup_geometry_name_alias(override_by_name, geometry.geometry_name)
        bulk_hmax = _coerce_positive_float(
            entry.get("bulk_hmax") or entry.get("hmax") if entry else None  # type: ignore[union-attr]
        ) or default_hmax

        if bulk_hmax >= default_hmax:
            continue

        if component_aware:
            fields.append(
                {
                    "kind": "ComponentVolumeConstant",
                    "params": {
                        "GeometryName": geometry.geometry_name,
                        "VIn": float(bulk_hmax),
                        "VOut": float(_NO_OP_FIELD_SIZE),
                    },
                }
            )
            continue

        if bounds_by_name is not None:
            bounds_pair = bounds_by_name.get(geometry.geometry_name)
            if bounds_pair is None:
                continue
            bounds_min, bounds_max = bounds_pair
        else:
            bounds_min, bounds_max = geometry_bounds(geometry, source_root=None)
        if bounds_min is None or bounds_max is None:
            continue

        fields.append(
            {
                "kind": "Box",
                "params": {
                    "VIn": float(bulk_hmax),
                    "VOut": float(_NO_OP_FIELD_SIZE),
                    "XMin": float(bounds_min[0]),
                    "XMax": float(bounds_max[0]),
                    "YMin": float(bounds_min[1]),
                    "YMax": float(bounds_max[1]),
                    "ZMin": float(bounds_min[2]),
                    "ZMax": float(bounds_max[2]),
                },
            }
        )
    return fields


# ===================================================================
# Layer 2: interface refinement fields
# ===================================================================

def _build_interface_fields(
    geometries: list[Geometry],
    *,
    default_hmax: float,
    override_by_name: dict[str, Mapping[str, object]],
    bounds_by_name: dict[str, tuple] | None = None,
    component_aware: bool = False,
) -> list[dict[str, object]]:
    """Build interface refinement fields around each object."""
    fields: list[dict[str, object]] = []
    for geometry in geometries:
        entry = _lookup_geometry_name_alias(override_by_name, geometry.geometry_name)
        bulk_hmax = _coerce_positive_float(
            entry.get("bulk_hmax") or entry.get("hmax") if entry else None  # type: ignore[union-attr]
        ) or default_hmax
        interface_hmax = _coerce_positive_float(
            entry.get("interface_hmax") if entry else None  # type: ignore[union-attr]
        )
        interface_thickness = _coerce_positive_float(
            entry.get("interface_thickness") if entry else None  # type: ignore[union-attr]
        )

        if interface_hmax is None:
            # Only generate interface refinement when the user explicitly
            # requests it.  The auto-computed 0.6×bulk default created
            # elements *finer* than the body interior at the boundary,
            # throttling SmoothRatio growth and inflating airbox element
            # count.  The transition field already grades from bulk_hmax
            # outward, so the interface layer is redundant by default.
            continue
        if interface_thickness is None:
            # Default thickness = 2× the interface element size
            interface_thickness = interface_hmax * 2.0

        if interface_hmax >= default_hmax:
            continue
        interface_ramp = max(interface_hmax, interface_thickness * 0.05, 1.0e-18)

        if component_aware:
            if _uses_analytic_box_air_shell(geometry):
                if bounds_by_name is not None:
                    bounds_pair = bounds_by_name.get(geometry.geometry_name)
                    if bounds_pair is None:
                        continue
                    bounds_min, bounds_max = bounds_pair
                else:
                    bounds_min, bounds_max = geometry_bounds(geometry, source_root=None)
                if bounds_min is None or bounds_max is None:
                    continue
                fields.append(
                    {
                        "kind": "AxisAlignedBoxDistanceThreshold",
                        "params": {
                            "BoundsMin": [float(value) for value in bounds_min],
                            "BoundsMax": [float(value) for value in bounds_max],
                            "SizeMin": float(interface_hmax),
                            "SizeMax": float(_NO_OP_FIELD_SIZE),
                            "DistMin": float(interface_thickness),
                            "DistMax": float(interface_thickness + interface_ramp),
                            "Source": "interface_hmax",
                        },
                    }
                )
                continue
            fields.append(
                {
                    "kind": "InterfaceShellThreshold",
                    "params": {
                        "GeometryName": geometry.geometry_name,
                        "SizeMin": float(interface_hmax),
                        "SizeMax": float(_NO_OP_FIELD_SIZE),
                        "DistMin": float(interface_thickness),
                        "DistMax": float(interface_thickness + interface_ramp),
                        "Sampling": 20,
                    },
                }
            )
            continue

        if bounds_by_name is not None:
            bounds_pair = bounds_by_name.get(geometry.geometry_name)
            if bounds_pair is None:
                continue
            bounds_min, bounds_max = bounds_pair
        else:
            bounds_min, bounds_max = geometry_bounds(geometry, source_root=None)
        if bounds_min is None or bounds_max is None:
            continue

        fields.append(
            {
                "kind": "BoundsSurfaceThreshold",
                "params": {
                    "BoundsMin": list(bounds_min),
                    "BoundsMax": list(bounds_max),
                    "SizeMin": float(interface_hmax),
                    "SizeMax": float(_NO_OP_FIELD_SIZE),
                    "DistMin": float(interface_thickness),
                    "DistMax": float(interface_thickness + interface_ramp),
                    "Sampling": 20,
                    "MatchPadding": float(interface_hmax * 0.5),
                },
            }
        )
    return fields


# ===================================================================
# Layer 3: transition zone fields
# ===================================================================

def _build_transition_fields(
    geometries: list[Geometry],
    *,
    default_hmax: float,
    override_by_name: dict[str, Mapping[str, object]],
    bounds_by_name: dict[str, tuple] | None = None,
    airbox_bounds: tuple[Sequence[float], Sequence[float]] | None = None,
    component_aware: bool = False,
) -> list[dict[str, object]]:
    """Build transition zone fields from fine object region to coarse airbox."""
    fields: list[dict[str, object]] = []
    for geometry in geometries:
        entry = _lookup_geometry_name_alias(override_by_name, geometry.geometry_name)
        bulk_hmax = _coerce_positive_float(
            entry.get("bulk_hmax") or entry.get("hmax") if entry else None  # type: ignore[union-attr]
        ) or default_hmax
        raw_transition_distance = entry.get("transition_distance") if entry else None  # type: ignore[union-attr]
        if raw_transition_distance == 0 or raw_transition_distance == 0.0:
            continue
        if isinstance(raw_transition_distance, str) and raw_transition_distance.strip().lower() in {"0", "off", "none", "false"}:
            continue
        transition_distance_requested = _coerce_positive_float(
            raw_transition_distance
        )
        transition_distance = transition_distance_requested
        transition_growth = _coerce_positive_float(
            entry.get("transition_growth") if entry else None  # type: ignore[union-attr]
        )
        interface_hmax = _coerce_positive_float(
            entry.get("interface_hmax") if entry else None  # type: ignore[union-attr]
        )
        interface_thickness = _coerce_positive_float(
            entry.get("interface_thickness") if entry else None  # type: ignore[union-attr]
        ) or 0.0
        transition_size_min = interface_hmax if interface_hmax is not None else bulk_hmax
        transition_dist_min = interface_thickness if interface_hmax is not None else 0.0

        if bounds_by_name is not None:
            bounds_pair = bounds_by_name.get(geometry.geometry_name)
            if bounds_pair is None:
                continue
            bounds_min, bounds_max = bounds_pair
        else:
            bounds_min, bounds_max = geometry_bounds(geometry, source_root=None)
        if bounds_min is None or bounds_max is None:
            continue

        if transition_distance is None:
            transition_distance = _resolve_airbox_boundary_transition_span(
                raw_transition_distance,
                bounds_min=bounds_min,
                bounds_max=bounds_max,
                airbox_bounds=airbox_bounds,
                dist_min=transition_dist_min,
                mode="side",
                context=f"{geometry.geometry_name}.mesh.transition_distance",
            )

        if transition_distance is None:
            if bulk_hmax < default_hmax:
                transition_distance = bulk_hmax * 3.0
            else:
                continue

        if transition_size_min >= default_hmax:
            continue

        # SizeMax = default_hmax (the airbox target) so the transition
        # field grades from the near-interface target to default_hmax.
        # DistMin preserves the requested fine shell before the ramp starts.
        transition_size_max = default_hmax
        transition_dist_max = transition_dist_min + transition_distance
        transition_source = (
            "airbox_boundary"
            if _is_airbox_boundary_transition(raw_transition_distance)
            else "transition_distance" if transition_distance_requested is not None else "auto"
        )

        if component_aware:
            if _uses_analytic_box_air_shell(geometry):
                params = {
                    "BoundsMin": [float(value) for value in bounds_min],
                    "BoundsMax": [float(value) for value in bounds_max],
                    "SizeMin": float(transition_size_min),
                    "SizeMax": float(transition_size_max),
                    "DistMin": float(transition_dist_min),
                    "DistMax": float(transition_dist_max),
                    "Grading": "geometric",
                    "Source": transition_source,
                }
                if transition_growth is not None and transition_growth > 1.0:
                    params["GrowthRate"] = float(transition_growth)
                fields.append(
                    {
                        "kind": "AxisAlignedBoxDistanceThreshold",
                        "params": params,
                    }
                )
                continue
            params = {
                "GeometryName": geometry.geometry_name,
                "SizeMin": float(transition_size_min),
                "SizeMax": float(transition_size_max),
                "DistMin": float(transition_dist_min),
                "DistMax": float(transition_dist_max),
                "Sampling": 20,
                "Grading": "geometric",
                "Source": transition_source,
            }
            if transition_growth is not None and transition_growth > 1.0:
                params["GrowthRate"] = float(transition_growth)
            fields.append(
                {
                    "kind": "TransitionShellThreshold",
                    "params": params,
                }
            )
            continue

        params = {
            "BoundsMin": list(bounds_min),
            "BoundsMax": list(bounds_max),
            "SizeMin": float(transition_size_min),
            "SizeMax": float(transition_size_max),
            "DistMin": float(transition_dist_min),
            "DistMax": float(transition_dist_max),
            "Sampling": 20,
            "MatchPadding": float(bulk_hmax),
            "Source": transition_source,
        }
        if transition_growth is not None and transition_growth > 1.0:
            params["GrowthRate"] = float(transition_growth)
        fields.append(
            {
                "kind": "BoundsSurfaceThreshold",
                "params": params,
            }
        )
    return fields


# ===================================================================
# Layer 4: manual hotspot fields
# ===================================================================

def _build_manual_hotspot_fields(
    per_geometry: object,
) -> list[dict[str, object]]:
    """Extract manually declared size fields from per_geometry entries."""
    if not isinstance(per_geometry, list):
        return []
    fields: list[dict[str, object]] = []
    for entry in per_geometry:
        if not isinstance(entry, Mapping):
            continue
        extra = entry.get("size_fields")
        if not isinstance(extra, list):
            continue
        for sf in extra:
            if isinstance(sf, dict) and "kind" in sf:
                if sf.get("kind") == "ObjectCoreRelaxation":
                    fields.extend(_expand_object_core_relaxation(entry, sf))
                else:
                    fields.append(sf)
    return fields


def _expand_object_core_relaxation(
    entry: Mapping[str, object],
    field: Mapping[str, object],
) -> list[dict[str, object]]:
    params = field.get("params")
    if not isinstance(params, Mapping):
        params = field
    geometry_name = (
        params.get("GeometryName")
        or params.get("object_id")
        or params.get("target")
        or entry.get("geometry")
        or entry.get("geometry_name")
        or entry.get("object_id")
    )
    if not isinstance(geometry_name, str) or not geometry_name.strip():
        return []
    core_hmax = _coerce_positive_float(
        params.get("core_maximum_element_size")
        or params.get("core_hmax")
        or params.get("CoreHmax")
    )
    surface_hmax = _coerce_positive_float(
        params.get("surface_maximum_element_size")
        or params.get("surface_hmax")
        or params.get("SurfaceHmax")
    )
    surface_distance = _coerce_positive_float(
        params.get("surface_distance") or params.get("SurfaceDistance")
    )
    if core_hmax is None or surface_hmax is None or surface_distance is None:
        return []
    edge_hmax = _coerce_positive_float(
        params.get("edge_maximum_element_size")
        or params.get("edge_hmax")
        or params.get("EdgeHmax")
    ) or surface_hmax
    edge_distance = _coerce_positive_float(params.get("edge_distance") or params.get("edge_thickness")) or surface_distance
    surface_sampling = int(
        params.get("sampling_surface")
        or params.get("SamplingSurface")
        or params.get("Sampling")
        or 20
    )
    edge_sampling = int(
        params.get("sampling_edge")
        or params.get("SamplingEdge")
        or params.get("Sampling")
        or 40
    )
    return [
        {
            "kind": "ComponentVolumeConstant",
            "params": {
                "GeometryName": geometry_name,
                "VIn": float(core_hmax),
                "VOut": float(_NO_OP_FIELD_SIZE),
                "Source": "ObjectCoreRelaxation",
            },
        },
        {
            "kind": "SurfaceDistanceThreshold",
            "params": {
                "GeometryName": geometry_name,
                "SizeMin": float(surface_hmax),
                "SizeMax": float(core_hmax),
                "DistMin": 0.0,
                "DistMax": float(surface_distance),
                "Sampling": max(2, surface_sampling),
                "Source": "ObjectCoreRelaxation",
            },
        },
        {
            "kind": "EdgeDistanceThreshold",
            "params": {
                "GeometryName": geometry_name,
                "SizeMin": float(edge_hmax),
                "SizeMax": float(core_hmax),
                "DistMin": 0.0,
                "DistMax": float(edge_distance),
                "Sampling": max(2, edge_sampling),
                "Source": "ObjectCoreRelaxation",
            },
        },
    ]


# ===================================================================
# Full field stack
# ===================================================================

def _build_field_stack(
    geometries: list[Geometry],
    *,
    default_hmax: float,
    per_geometry: object,
    bounds_by_name: dict[str, tuple] | None = None,
    airbox_bounds: tuple[Sequence[float], Sequence[float]] | None = None,
    component_aware: bool = False,
) -> list[dict[str, object]]:
    """Full field stack: bulk + interface + transition + manual hotspots.

    This is the Commit 2 replacement for ``_shared_domain_local_size_fields``.
    Falls back to Box-only bulk fields when no interface/transition params are
    specified, keeping backward compatibility.
    """
    override_by_name = _parse_per_geometry_overrides(per_geometry)

    # Layer 1: Object bulk (Box fields)
    fields = _build_object_bulk_fields(
        geometries,
        default_hmax=default_hmax,
        override_by_name=override_by_name,
        bounds_by_name=bounds_by_name,
        component_aware=component_aware,
    )

    # Layer 2: Interface refinement (BoundsSurfaceThreshold)
    interface_fields = _build_interface_fields(
        geometries,
        default_hmax=default_hmax,
        override_by_name=override_by_name,
        bounds_by_name=bounds_by_name,
        component_aware=component_aware,
    )
    if interface_fields:
        fields.extend(interface_fields)

    # Layer 3: Transition zone (BoundsSurfaceThreshold with wider distance)
    transition_fields = _build_transition_fields(
        geometries,
        default_hmax=default_hmax,
        override_by_name=override_by_name,
        bounds_by_name=bounds_by_name,
        airbox_bounds=airbox_bounds,
        component_aware=component_aware,
    )
    if transition_fields:
        fields.extend(transition_fields)

    perimeter_fields = _build_perimeter_refinement_fields(
        geometries,
        default_hmax=default_hmax,
        override_by_name=override_by_name,
        bounds_by_name=bounds_by_name,
        airbox_bounds=airbox_bounds,
        component_aware=component_aware,
    )
    if perimeter_fields:
        fields.extend(perimeter_fields)

    # Layer 4: Manual hotspot fields
    hotspot_fields = _build_manual_hotspot_fields(per_geometry)
    if hotspot_fields:
        fields.extend(hotspot_fields)

    if fields:
        emit_progress(
            f"Field stack: {len(fields)} fields "
            f"(bulk={len(fields) - len(interface_fields) - len(transition_fields) - len(perimeter_fields) - len(hotspot_fields)}, "
            f"interface={len(interface_fields)}, "
            f"transition={len(transition_fields)}, "
            f"perimeter={len(perimeter_fields)}, "
            f"hotspots={len(hotspot_fields)})"
        )

    return fields


# ===================================================================
# Per-object recipe → size-field overrides
# ===================================================================

def _resolve_per_object_mesh_options(
    geometries: list[Geometry],
    per_object_recipes: dict[str, PerObjectMeshRecipe],
    assembly_policy: SharedMeshAssemblyPolicy,  # kept for API compat
    *,
    default_hmax: float,
    bounds_by_name: dict[str, tuple] | None = None,
    component_aware: bool = False,
) -> list[dict[str, object]]:
    """Build size-field overrides from per-object mesh recipes.

    For each geometry that has an associated :class:`PerObjectMeshRecipe`, a
    surface-driven threshold field is injected around the object's recovered
    STL surfaces.
    """
    extra_fields: list[dict[str, object]] = []
    for geometry in geometries:
        recipe = _lookup_geometry_name_alias(per_object_recipes, geometry.geometry_name)
        if recipe is None:
            continue
        if bounds_by_name is not None:
            bounds_pair = bounds_by_name.get(geometry.geometry_name)
            if bounds_pair is None:
                continue
            bounds_min, bounds_max = bounds_pair
        else:
            bounds_min, bounds_max = geometry_bounds(geometry, source_root=None)
        if bounds_min is None or bounds_max is None:
            continue
        target_hmax = recipe.hmax if recipe.hmax is not None else default_hmax  # type: ignore[union-attr]
        if target_hmax >= default_hmax:
            extra_fields.extend(recipe.size_fields if recipe.size_fields else [])  # type: ignore[union-attr]
            continue
        if component_aware:
            extra_fields.append(
                {
                    "kind": "ComponentVolumeConstant",
                    "params": {
                        "GeometryName": geometry.geometry_name,
                        "VIn": float(target_hmax),
                        "VOut": float(_NO_OP_FIELD_SIZE),
                    },
                }
            )
        else:
            extra_fields.append(
                {
                    "kind": "Box",
                    "params": {
                        "VIn": float(target_hmax),
                        "VOut": float(_NO_OP_FIELD_SIZE),
                        "XMin": float(bounds_min[0]),
                        "XMax": float(bounds_max[0]),
                        "YMin": float(bounds_min[1]),
                        "YMax": float(bounds_max[1]),
                        "ZMin": float(bounds_min[2]),
                        "ZMax": float(bounds_max[2]),
                    },
                }
            )
        for sf in recipe.size_fields:  # type: ignore[union-attr]
            if isinstance(sf, dict):
                extra_fields.append(sf)
    return extra_fields


# ===================================================================
# MeshOptions from workflow metadata
# ===================================================================

def _mesh_options_from_runtime_metadata(
    mesh_workflow: Mapping[str, object] | None,
    *,
    geometries: list[Geometry],
    default_hmax: float,
    bounds_by_name: dict[str, tuple] | None = None,
    airbox_bounds: tuple[Sequence[float], Sequence[float]] | None = None,
    component_aware: bool = False,
    per_object_recipes: dict[str, PerObjectMeshRecipe] | None = None,
    include_size_fields: bool = True,
) -> MeshOptions:
    raw_mesh_options = (
        mesh_workflow.get("mesh_options")
        if isinstance(mesh_workflow, Mapping)
        and isinstance(mesh_workflow.get("mesh_options"), Mapping)
        else {}
    )
    assert isinstance(raw_mesh_options, Mapping)
    raw_per_geometry = (
        mesh_workflow.get("per_geometry")
        if isinstance(mesh_workflow, Mapping)
        and isinstance(mesh_workflow.get("per_geometry"), list)
        else []
    )
    assert isinstance(raw_per_geometry, list)

    def _single_geometry_value(key: str) -> object | None:
        entries = [entry for entry in raw_per_geometry if isinstance(entry, Mapping)]
        if len(entries) != 1:
            return None
        return entries[0].get(key)

    def _per_geometry_values(key: str) -> list[object]:
        return [
            entry[key]
            for entry in raw_per_geometry
            if isinstance(entry, Mapping) and entry.get(key) is not None
        ]

    def _first_non_none(*values: object) -> object | None:
        for value in values:
            if value is not None:
                return value
        return None

    def _recipe_value(*keys: str, reducer: str = "unique") -> object | None:
        if not per_object_recipes:
            return None
        values: list[object] = []
        for geometry in geometries:
            recipe = _lookup_geometry_name_alias(
                per_object_recipes,
                geometry.geometry_name,
            )
            if not isinstance(recipe, PerObjectMeshRecipe):
                continue
            recipe_payload = recipe.to_ir()
            for key in keys:
                value = recipe_payload.get(key)
                if value is None:
                    continue
                values.append(value)
                break
        if not values:
            return None
        if reducer == "min":
            numeric_values = [
                float(value)
                for value in values
                if isinstance(value, (int, float))
            ]
            return min(numeric_values) if numeric_values else None
        first = values[0]
        if any(value != first for value in values[1:]):
            raise ValueError(f"per-object {keys[0]} values must match for shared-domain meshing")
        return first

    def _mesh_option_value(*keys: str, reducer: str = "unique") -> object | None:
        value = _recipe_value(*keys, reducer=reducer)
        if value is not None:
            return value
        for key in keys:
            value = raw_mesh_options.get(key)
            if value is not None:
                return value
        for key in keys:
            value = _single_geometry_value(key)
            if value is not None:
                return value
        return None

    def _shared_per_geometry_value(key: str) -> object | None:
        values = _per_geometry_values(key)
        if not values:
            return None
        first = values[0]
        if any(value != first for value in values[1:]):
            raise ValueError(f"per-geometry {key} values must match for shared-domain boundary layers")
        return first

    def _merged_per_geometry_list(key: str) -> list[object] | None:
        merged: list[object] = []
        for value in _per_geometry_values(key):
            if isinstance(value, list):
                merged.extend(value)
        return merged or None

    size_fields: list[Mapping[str, object]] = []
    if include_size_fields:
        size_fields = (
            [field for field in raw_mesh_options.get("size_fields", []) if isinstance(field, Mapping)]
            if isinstance(raw_mesh_options.get("size_fields"), list)
            else []
        )
        size_fields.extend(
            _build_field_stack(
                geometries,
                default_hmax=default_hmax,
                per_geometry=mesh_workflow.get("per_geometry") if isinstance(mesh_workflow, Mapping) else None,
                bounds_by_name=bounds_by_name,
                airbox_bounds=airbox_bounds,
                component_aware=component_aware,
            )
        )
    optimize = _mesh_option_value("optimize")
    raw_mesh_strategy = raw_mesh_options.get("mesh_strategy") or _single_geometry_value("mesh_strategy")
    raw_through_thickness_elements = (
        raw_mesh_options.get("through_thickness_elements")
        if raw_mesh_options.get("through_thickness_elements") is not None
        else _single_geometry_value("through_thickness_elements")
    )
    raw_through_thickness_distribution = (
        raw_mesh_options.get("through_thickness_distribution")
        or _single_geometry_value("through_thickness_distribution")
    )
    raw_through_thickness_element_ratio = (
        raw_mesh_options.get("through_thickness_element_ratio")
        if raw_mesh_options.get("through_thickness_element_ratio") is not None
        else _single_geometry_value("through_thickness_element_ratio")
    )
    raw_through_thickness_symmetric = (
        raw_mesh_options.get("through_thickness_symmetric")
        if raw_mesh_options.get("through_thickness_symmetric") is not None
        else _single_geometry_value("through_thickness_symmetric")
    )
    raw_sweep_face_meshing = raw_mesh_options.get("sweep_face_meshing") or _single_geometry_value(
        "sweep_face_meshing"
    )
    raw_boundary_layer_count = _first_non_none(
        raw_mesh_options.get("boundary_layer_count"),
        _shared_per_geometry_value("boundary_layer_count"),
    )
    raw_boundary_layer_thickness = _first_non_none(
        raw_mesh_options.get("boundary_layer_thickness"),
        _shared_per_geometry_value("boundary_layer_thickness"),
    )
    raw_boundary_layer_stretching = _first_non_none(
        raw_mesh_options.get("boundary_layer_stretching"),
        _shared_per_geometry_value("boundary_layer_stretching"),
    )
    raw_boundary_layer_surface_tags = _first_non_none(
        raw_mesh_options.get("boundary_layer_target_surface_tags"),
        _merged_per_geometry_list("boundary_layer_target_surface_tags"),
    )
    raw_boundary_layer_curve_tags = _first_non_none(
        raw_mesh_options.get("boundary_layer_target_curve_tags"),
        _merged_per_geometry_list("boundary_layer_target_curve_tags"),
    )
    raw_boundary_layer_surface_selectors = _first_non_none(
        raw_mesh_options.get("boundary_layer_target_surface_selectors"),
        _merged_per_geometry_list("boundary_layer_target_surface_selectors"),
    )
    raw_boundary_layer_curve_selectors = _first_non_none(
        raw_mesh_options.get("boundary_layer_target_curve_selectors"),
        _merged_per_geometry_list("boundary_layer_target_curve_selectors"),
    )
    raw_compute_quality = _mesh_option_value("compute_quality")
    raw_per_element_quality = _mesh_option_value("per_element_quality")

    def _int_list(value: object) -> list[int] | None:
        if not isinstance(value, list):
            return None
        return [int(item) for item in value]

    def _selector_list(value: object) -> list[dict[str, object]] | None:
        if not isinstance(value, list):
            return None
        return [dict(item) for item in value if isinstance(item, Mapping)]

    raw_optimize_iters = _mesh_option_value("optimize_iterations", "optimize_iters")

    return MeshOptions(
        algorithm_2d=int(_mesh_option_value("algorithm_2d") or 6),
        algorithm_3d=int(_mesh_option_value("algorithm_3d") or 1),
        hmin=_coerce_positive_float(
            _mesh_option_value("hmin", "minimum_element_size", reducer="min")
        ),
        calibrate_for=(
            str(_mesh_option_value("calibrate_for"))
            if isinstance(_mesh_option_value("calibrate_for"), str)
            else None
        ),
        size_preset=(
            str(_mesh_option_value("size_preset"))
            if isinstance(_mesh_option_value("size_preset"), str)
            else None
        ),
        size_factor=float(_mesh_option_value("size_factor") or 1.0),
        size_from_curvature=int(_mesh_option_value("size_from_curvature") or 0),
        curvature_factor=_coerce_positive_float(
            _mesh_option_value("curvature_factor")
        ),
        growth_rate=_coerce_positive_float(
            _mesh_option_value("growth_rate", "maximum_element_growth_rate")
        ),
        narrow_regions=int(_mesh_option_value("narrow_regions") or 0),
        narrow_region_resolution=_coerce_positive_float(
            _mesh_option_value("narrow_region_resolution")
        ),
        smoothing_steps=int(_mesh_option_value("smoothing_steps") or 1),
        optimize=str(optimize) if isinstance(optimize, str) and optimize.strip() else None,
        optimize_iters=int(raw_optimize_iters) if raw_optimize_iters is not None else 1,
        size_fields=size_fields,
        compute_quality=(
            bool(raw_compute_quality) if raw_compute_quality is not None else True
        ),
        per_element_quality=(
            bool(raw_per_element_quality) if raw_per_element_quality is not None else True
        ),
        mesh_strategy=(
            str(raw_mesh_strategy)
            if isinstance(raw_mesh_strategy, str) and raw_mesh_strategy.strip()
            else None
        ),
        through_thickness_elements=(
            int(raw_through_thickness_elements)
            if raw_through_thickness_elements is not None
            else None
        ),
        through_thickness_distribution=(
            str(raw_through_thickness_distribution)
            if isinstance(raw_through_thickness_distribution, str)
            and raw_through_thickness_distribution.strip()
            else None
        ),
        through_thickness_element_ratio=_coerce_positive_float(
            raw_through_thickness_element_ratio
        ),
        through_thickness_symmetric=bool(raw_through_thickness_symmetric or False),
        sweep_face_meshing=(
            str(raw_sweep_face_meshing)
            if isinstance(raw_sweep_face_meshing, str) and raw_sweep_face_meshing.strip()
            else None
        ),
        boundary_layer_count=(
            int(raw_boundary_layer_count)
            if raw_boundary_layer_count is not None and int(raw_boundary_layer_count) > 0
            else None
        ),
        boundary_layer_thickness=_coerce_positive_float(raw_boundary_layer_thickness),
        boundary_layer_stretching=_coerce_positive_float(raw_boundary_layer_stretching),
        boundary_layer_target_surface_tags=_int_list(raw_boundary_layer_surface_tags),
        boundary_layer_target_curve_tags=_int_list(raw_boundary_layer_curve_tags),
        boundary_layer_target_surface_selectors=_selector_list(
            raw_boundary_layer_surface_selectors
        ),
        boundary_layer_target_curve_selectors=_selector_list(
            raw_boundary_layer_curve_selectors
        ),
    )
