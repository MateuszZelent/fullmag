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
  - ``ComponentRestrictedBox`` — refine inside a named component sub-box

Bounds-based fallback (concatenated-STL or unknown topology):
  - ``Box`` — set size inside an axis-aligned bounding box
  - ``BoundsSurfaceThreshold`` — refine near an inferred surface (bounds)
"""
from __future__ import annotations

from typing import Mapping

from fullmag._progress import emit_progress
from fullmag.model.discretization import PerObjectMeshRecipe, SharedMeshAssemblyPolicy
from fullmag.model.domain_frame import geometry_bounds
from fullmag.model.geometry import Box, Geometry, Translate

from .gmsh_bridge import MeshOptions

from ._mesh_targets import (
    _coerce_positive_float,
    _lookup_geometry_name_alias,
    _parse_per_geometry_overrides,
)

_NO_OP_FIELD_SIZE = 1.0e22


def _unwrap_translated_box_geometry(geometry: Geometry) -> Box | None:
    current: Geometry | object = geometry
    while isinstance(current, Translate):
        current = current.geometry
    return current if isinstance(current, Box) else None


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
        raise ValueError(
            f"{geometry.geometry_name}: edge/corner refinement currently requires component-aware shared-domain meshing"
        )

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
        if corner_hmax is not None or corner_extent is not None:
            raise ValueError(
                f"{geometry.geometry_name}: corner refinement requires Box geometry or explicit named corner selectors"
            )
        return {
            key: value
            for key, value in {
                "edge_hmax": edge_hmax,
                "edge_thickness": edge_thickness,
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
    component_aware: bool = False,
) -> list[dict[str, object]]:
    """Build box-local edge and corner refinement fields for rectangular boxes."""
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
            if "edge_hmax" in refinement and "edge_thickness" in refinement:
                fields.append(
                    {
                        "kind": "EdgeDistanceThreshold",
                        "params": {
                            "GeometryName": geometry.geometry_name,
                            "Selector": {"mode": "all_boundary_curves"},
                            "SizeMin": float(refinement["edge_hmax"]),
                            "SizeMax": float(default_hmax),
                            "DistMin": 0.0,
                            "DistMax": float(refinement["edge_thickness"]),
                            "Sampling": 40,
                            "Source": "per_geometry.edge_maximum_element_size",
                        },
                    }
                )
            continue
        size_by_axis = [float(component) for component in box.size]
        in_plane_axes = sorted(range(3), key=lambda axis: size_by_axis[axis], reverse=True)[:2]
        axis_a, axis_b = in_plane_axes

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

        if component_aware:
            fields.append(
                {
                    "kind": "InterfaceShellThreshold",
                    "params": {
                        "GeometryName": geometry.geometry_name,
                        "SizeMin": float(interface_hmax),
                        "SizeMax": float(_NO_OP_FIELD_SIZE),
                        "DistMin": 0.0,
                        "DistMax": float(interface_thickness),
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
                    "DistMin": 0.0,
                    "DistMax": float(interface_thickness),
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
    component_aware: bool = False,
) -> list[dict[str, object]]:
    """Build transition zone fields from fine object region to coarse airbox."""
    fields: list[dict[str, object]] = []
    for geometry in geometries:
        entry = _lookup_geometry_name_alias(override_by_name, geometry.geometry_name)
        bulk_hmax = _coerce_positive_float(
            entry.get("bulk_hmax") or entry.get("hmax") if entry else None  # type: ignore[union-attr]
        ) or default_hmax
        transition_distance_requested = _coerce_positive_float(
            entry.get("transition_distance") if entry else None  # type: ignore[union-attr]
        )
        transition_distance = transition_distance_requested

        if transition_distance is None:
            if bulk_hmax < default_hmax:
                transition_distance = bulk_hmax * 3.0
            else:
                continue

        if bulk_hmax >= default_hmax:
            continue

        # SizeMax = default_hmax (the airbox target) so the Threshold
        # linearly ramps from bulk_hmax at the body surface to
        # default_hmax at the transition boundary.  Previously SizeMax
        # was 1e22, which jumped to infinity at d>0 and left grading
        # entirely to SmoothRatio — wasting the transition field.
        transition_size_max = default_hmax

        if component_aware:
            fields.append(
                {
                    "kind": "TransitionShellThreshold",
                    "params": {
                        "GeometryName": geometry.geometry_name,
                        "SizeMin": float(bulk_hmax),
                        "SizeMax": float(transition_size_max),
                        "DistMin": 0.0,
                        "DistMax": float(transition_distance),
                        "Sampling": 20,
                        "Source": "explicit" if transition_distance_requested is not None else "auto",
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
                    "SizeMin": float(bulk_hmax),
                    "SizeMax": float(transition_size_max),
                    "DistMin": 0.0,
                    "DistMax": float(transition_distance),
                    "Sampling": 20,
                    "MatchPadding": float(bulk_hmax),
                    "Source": "explicit" if transition_distance_requested is not None else "auto",
                },
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
        component_aware=component_aware,
    )
    if transition_fields:
        fields.extend(transition_fields)

    perimeter_fields = _build_perimeter_refinement_fields(
        geometries,
        default_hmax=default_hmax,
        override_by_name=override_by_name,
        bounds_by_name=bounds_by_name,
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
    component_aware: bool = False,
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
            component_aware=component_aware,
        )
    )
    optimize = raw_mesh_options.get("optimize")
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

    def _int_list(value: object) -> list[int] | None:
        if not isinstance(value, list):
            return None
        return [int(item) for item in value]

    def _selector_list(value: object) -> list[dict[str, object]] | None:
        if not isinstance(value, list):
            return None
        return [dict(item) for item in value if isinstance(item, Mapping)]

    return MeshOptions(
        algorithm_2d=int(raw_mesh_options.get("algorithm_2d", 6)),
        algorithm_3d=int(raw_mesh_options.get("algorithm_3d", 1)),
        hmin=_coerce_positive_float(raw_mesh_options.get("hmin")),
        calibrate_for=(
            str(raw_mesh_options.get("calibrate_for"))
            if isinstance(raw_mesh_options.get("calibrate_for"), str)
            else None
        ),
        size_preset=(
            str(raw_mesh_options.get("size_preset"))
            if isinstance(raw_mesh_options.get("size_preset"), str)
            else None
        ),
        size_factor=float(raw_mesh_options.get("size_factor", 1.0)),
        size_from_curvature=int(raw_mesh_options.get("size_from_curvature", 0)),
        curvature_factor=_coerce_positive_float(raw_mesh_options.get("curvature_factor")),
        growth_rate=_coerce_positive_float(raw_mesh_options.get("growth_rate")),
        narrow_regions=int(raw_mesh_options.get("narrow_regions", 0)),
        narrow_region_resolution=_coerce_positive_float(
            raw_mesh_options.get("narrow_region_resolution")
        ),
        smoothing_steps=int(raw_mesh_options.get("smoothing_steps", 1)),
        optimize=str(optimize) if isinstance(optimize, str) and optimize.strip() else None,
        optimize_iters=int(raw_mesh_options.get("optimize_iterations", 1)),
        size_fields=size_fields,
        compute_quality=bool(raw_mesh_options.get("compute_quality", True)),
        per_element_quality=bool(raw_mesh_options.get("per_element_quality", True)),
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
