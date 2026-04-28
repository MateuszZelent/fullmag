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

Bounds-based fallback (concatenated-STL or unknown topology):
  - ``Box`` — set size inside an axis-aligned bounding box
  - ``BoundsSurfaceThreshold`` — refine near an inferred surface (bounds)
"""
from __future__ import annotations

from typing import Mapping

from fullmag._progress import emit_progress
from fullmag.model.discretization import PerObjectMeshRecipe, SharedMeshAssemblyPolicy
from fullmag.model.domain_frame import geometry_bounds
from fullmag.model.geometry import Geometry

from .gmsh_bridge import MeshOptions

from ._mesh_targets import (
    _coerce_positive_float,
    _lookup_geometry_name_alias,
    _parse_per_geometry_overrides,
)

_NO_OP_FIELD_SIZE = 1.0e22


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
        transition_distance = _coerce_positive_float(
            entry.get("transition_distance") if entry else None  # type: ignore[union-attr]
        )

        if transition_distance is None:
            # Keep plain per-object hmax local to the object.  Automatically
            # injecting a shell transition leaks fine object targets into the
            # surrounding airbox and makes the shared-domain mesh look nearly
            # uniform.  Users can still request a graded air/body shell
            # explicitly with transition_distance.
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
                fields.append(sf)
    return fields


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

    # Layer 4: Manual hotspot fields
    hotspot_fields = _build_manual_hotspot_fields(per_geometry)
    if hotspot_fields:
        fields.extend(hotspot_fields)

    if fields:
        emit_progress(
            f"Field stack: {len(fields)} fields "
            f"(bulk={len(fields) - len(interface_fields) - len(transition_fields) - len(hotspot_fields)}, "
            f"interface={len(interface_fields)}, "
            f"transition={len(transition_fields)}, "
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
    )
