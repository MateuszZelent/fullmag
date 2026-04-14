from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import numpy as np

from fullmag._progress import emit_progress

from ._gmsh_types import (
    ALGO_3D_HXT,
    ALGO_3D_MMG3D,
    MeshOptions,
    resolve_mesh_size_controls,
)


def _apply_mesh_options(
    gmsh: Any,
    hmax: float,
    order: int,
    opts: MeshOptions,
    hscale: float = 1.0,
    preexisting_field_ids: list[int] | None = None,
    preexisting_lower_bound_field_ids: list[int] | None = None,
    component_volume_tags: dict[str, list[int]] | None = None,
    component_surface_tags: dict[str, list[int]] | None = None,
    airbox_maximum_element_size: float | None = None,
) -> None:
    """Apply MeshOptions to the Gmsh context before mesh.generate()."""
    emit_progress("Gmsh: applying mesh options")
    resolved_size_controls = resolve_mesh_size_controls(opts)
    algorithm_3d = opts.algorithm_3d
    if opts.size_fields and algorithm_3d == ALGO_3D_MMG3D:
        # MMG3D has proven unstable for imported/shared-domain workflows when a
        # background size field is active; it can abort with "unable to set mesh
        # size" before tetra generation starts. HXT remains stable here while
        # preserving the intended local sizing semantics.
        emit_progress(
            "Gmsh: MMG3D is incompatible with active background size fields; "
            "falling back to HXT for stable local sizing"
        )
        algorithm_3d = ALGO_3D_HXT
    # When an airbox is present, allow larger elements in the far field
    effective_hmax = (
        max(hmax, airbox_maximum_element_size)
        if airbox_maximum_element_size is not None
        else hmax
    )
    gmsh.option.setNumber("Mesh.CharacteristicLengthMax", effective_hmax)
    # The exported mesh asset is intentionally first-order topology.
    # Higher-order FEM lives in the solver space (`fe_order`), not in the
    # geometric mesh connectivity. Generating quadratic Gmsh elements here
    # introduces mid-edge nodes that are not part of our MeshIR contract and
    # has produced unstable/degenerate tetrahedra for imported STL cases.
    gmsh.option.setNumber("Mesh.ElementOrder", 1)
    gmsh.option.setNumber("Mesh.Algorithm", opts.algorithm_2d)
    gmsh.option.setNumber("Mesh.Algorithm3D", algorithm_3d)
    gmsh.option.setNumber("Mesh.MeshSizeFactor", opts.size_factor)
    gmsh.option.setNumber("Mesh.Smoothing", opts.smoothing_steps)

    if opts.hmin is not None:
        gmsh.option.setNumber("Mesh.CharacteristicLengthMin", opts.hmin * hscale)

    resolved_curvature = int(resolved_size_controls["resolved_size_from_curvature"])
    if resolved_curvature > 0:
        gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", resolved_curvature)

    resolved_growth_rate = resolved_size_controls["resolved_growth_rate"]
    if isinstance(resolved_growth_rate, (int, float)):
        gmsh.option.setNumber("Mesh.SmoothRatio", float(resolved_growth_rate))
        if float(resolved_growth_rate) < 1.5:
            gmsh.option.setNumber("Mesh.Smoothing", max(opts.smoothing_steps, 5))

    extra_field_ids: list[int] = list(preexisting_field_ids or [])

    resolved_narrow_regions = int(resolved_size_controls["resolved_narrow_regions"])
    if resolved_narrow_regions > 0:
        fid = _add_narrow_region_field(gmsh, resolved_narrow_regions, hmax, hscale)
        if fid is not None:
            extra_field_ids.append(fid)

    if (
        opts.boundary_layer_count is not None
        and opts.boundary_layer_count > 0
        and opts.boundary_layer_thickness is not None
        and opts.boundary_layer_thickness > 0.0
    ):
        bl_stretching = opts.boundary_layer_stretching if opts.boundary_layer_stretching else 1.2
        fid = _add_boundary_layer_field(
            gmsh,
            count=opts.boundary_layer_count,
            thickness=opts.boundary_layer_thickness,
            stretching=bl_stretching,
            hscale=hscale,
        )
        if fid is not None:
            emit_progress(
                f"Gmsh: boundary layers ({opts.boundary_layer_count} layers, "
                f"thickness={opts.boundary_layer_thickness:.3e}, "
                f"stretching={bl_stretching:.2f})"
            )

    # When a background size field is active, disable competing Gmsh size
    # sources so the field is the authoritative sizing control.  Without these,
    # characteristic lengths embedded in GEO points (e.g. the h_outer value
    # baked into every airbox corner point by _add_airbox_geo) propagate via
    # MeshSizeFromPoints and MeshSizeExtendFromBoundary across the whole
    # volume, completely overriding per-geometry Box fields and making local
    # refinement settings have no visible effect on the final mesh.
    has_active_fields = bool(extra_field_ids) or bool(opts.size_fields)
    if has_active_fields:
        gmsh.option.setNumber("Mesh.MeshSizeFromPoints", 0)
        gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 0)

    if opts.size_fields:
        emit_progress("Gmsh: configuring mesh size fields")
        _configure_mesh_size_fields(
            gmsh,
            opts.size_fields,
            hscale,
            extra_field_ids,
            list(preexisting_lower_bound_field_ids or []),
            component_volume_tags=component_volume_tags,
            component_surface_tags=component_surface_tags,
        )
    elif extra_field_ids:
        # No explicit size_fields but we have auto-generated fields (e.g. narrow regions)
        emit_progress("Gmsh: configuring mesh size fields")
        _configure_mesh_size_fields(
            gmsh,
            [],
            hscale,
            extra_field_ids,
            list(preexisting_lower_bound_field_ids or []),
            component_volume_tags=component_volume_tags,
            component_surface_tags=component_surface_tags,
        )


def _apply_post_mesh_options(gmsh: Any, opts: MeshOptions) -> None:
    """Apply post-generation options (optimization passes)."""
    if opts.optimize is not None:
        method = opts.optimize
        niter = opts.optimize_iters
        emit_progress(f"Gmsh: optimizing mesh (method={method!r}, iters={niter})")
        gmsh.model.mesh.optimize(method, niter=niter)


def _add_narrow_region_field(
    gmsh: Any,
    n_resolve: int,
    hmax: float,
    hscale: float = 1.0,
) -> int | None:
    """Add a size field that refines narrow regions of the geometry.

    Uses a Distance field from all boundary surfaces: the local wall
    thickness is approximately ``2 × dist_to_nearest_boundary``.
    The target element size is ``thickness / n_resolve``, clamped to
    ``[hmax * 0.05, hmax]`` (scaled by *hscale*).

    Returns the Gmsh field ID of a MathEval field, or ``None`` when
    no surfaces are present.
    """
    if n_resolve < 1:
        return None

    surfaces = gmsh.model.getEntities(2)
    if not surfaces:
        return None
    surf_tags = [t for _, t in surfaces]

    f_dist = gmsh.model.mesh.field.add("Distance")
    gmsh.model.mesh.field.setNumbers(f_dist, "SurfacesList", surf_tags)
    gmsh.model.mesh.field.setNumber(f_dist, "Sampling", 20)

    hmin_val = hmax * 0.05 * hscale
    hmax_val = hmax * hscale
    # target_h = 2*dist / n_resolve, clamped to [hmin_val, hmax_val]
    expr = f"Min(Max(2*F{f_dist}/{n_resolve}, {hmin_val}), {hmax_val})"
    f_math = gmsh.model.mesh.field.add("MathEval")
    gmsh.model.mesh.field.setString(f_math, "F", expr)
    return f_math


def _add_boundary_layer_field(
    gmsh: Any,
    count: int,
    thickness: float,
    stretching: float,
    hscale: float = 1.0,
) -> int | None:
    """Add a Gmsh BoundaryLayer field for prismatic near-wall extrusion.

    Uses all currently visible surfaces as the seeding boundary.

    Args:
        gmsh: Active Gmsh Python module.
        count: Number of boundary-layer element layers.
        thickness: Target first-layer thickness in mesh units (after *hscale*
            is already applied to coordinates).
        stretching: Growth ratio between successive layers (e.g. 1.2–1.5).
        hscale: Coordinate scale factor (1 for SI meshes; SCALE for µm meshes).

    Returns:
        Gmsh field ID of the BoundaryLayer field, or ``None`` when no
        surfaces are found.
    """
    if count < 1 or thickness <= 0.0:
        return None

    surfaces = gmsh.model.getEntities(2)
    if not surfaces:
        return None
    surf_tags = [int(t) for _, t in surfaces]

    h_first = float(thickness) * hscale
    fid = gmsh.model.mesh.field.add("BoundaryLayer")
    gmsh.model.mesh.field.setNumbers(fid, "SurfacesList", surf_tags)
    gmsh.model.mesh.field.setNumber(fid, "hwall_n", h_first)
    gmsh.model.mesh.field.setNumber(fid, "hwall_t", h_first)
    gmsh.model.mesh.field.setNumber(fid, "ratio", float(stretching) if stretching > 0.0 else 1.2)
    gmsh.model.mesh.field.setNumber(fid, "nb_layers", int(count))
    try:
        gmsh.model.mesh.field.setAsBoundaryLayer(fid)
    except Exception:
        # Older Gmsh builds may not have setAsBoundaryLayer; fall back to
        # injecting as a background field which still provides local refinement
        # near walls even without true prismatic extrusion.
        pass
    return fid


def _match_surfaces_within_bounds(
    gmsh: Any,
    bounds_min: Sequence[float],
    bounds_max: Sequence[float],
    *,
    padding: float = 0.0,
) -> list[int]:
    target_min = np.asarray(bounds_min, dtype=np.float64) - float(padding)
    target_max = np.asarray(bounds_max, dtype=np.float64) + float(padding)
    matched: list[int] = []
    for _dim, surf_tag in gmsh.model.getEntities(2):
        bb = np.asarray(gmsh.model.getBoundingBox(2, surf_tag), dtype=np.float64)
        surf_min = bb[:3]
        surf_max = bb[3:]
        if np.all(surf_min >= target_min) and np.all(surf_max <= target_max):
            matched.append(int(surf_tag))
    return matched


def _component_surface_tags_for_geometry(
    geometry_name: str,
    component_surface_tags: dict[str, list[int]] | None,
) -> list[int]:
    if not component_surface_tags:
        return []
    return [int(tag) for tag in component_surface_tags.get(geometry_name, [])]


def _component_volume_tags_for_geometry(
    geometry_name: str,
    component_volume_tags: dict[str, list[int]] | None,
) -> list[int]:
    if not component_volume_tags:
        return []
    return [int(tag) for tag in component_volume_tags.get(geometry_name, [])]


def _add_surface_threshold_field(
    gmsh: Any,
    *,
    surface_tags: Sequence[int],
    size_min: float,
    size_max: float,
    dist_min: float,
    dist_max: float,
    sampling: int = 20,
    hscale: float = 1.0,
) -> int | None:
    normalized_surface_tags = [int(tag) for tag in surface_tags]
    if not normalized_surface_tags:
        return None

    f_dist = gmsh.model.mesh.field.add("Distance")
    gmsh.model.mesh.field.setNumbers(f_dist, "SurfacesList", normalized_surface_tags)
    gmsh.model.mesh.field.setNumber(f_dist, "Sampling", int(max(2, sampling)))

    f_thresh = gmsh.model.mesh.field.add("Threshold")
    gmsh.model.mesh.field.setNumber(f_thresh, "InField", f_dist)
    gmsh.model.mesh.field.setNumber(f_thresh, "SizeMin", float(size_min) * hscale)
    gmsh.model.mesh.field.setNumber(f_thresh, "SizeMax", float(size_max) * hscale)
    gmsh.model.mesh.field.setNumber(f_thresh, "DistMin", float(dist_min) * hscale)
    gmsh.model.mesh.field.setNumber(f_thresh, "DistMax", float(dist_max) * hscale)
    return f_thresh


def _add_component_surface_threshold_field(
    gmsh: Any,
    *,
    geometry_name: str,
    size_min: float,
    size_max: float,
    dist_min: float,
    dist_max: float,
    component_surface_tags: dict[str, list[int]] | None,
    sampling: int = 20,
    hscale: float = 1.0,
) -> int | None:
    surf_tags = _component_surface_tags_for_geometry(geometry_name, component_surface_tags)
    if not surf_tags:
        emit_progress(
            f"Gmsh: warning - no recovered component surfaces for '{geometry_name}', skipping local surface threshold"
        )
        return None
    return _add_surface_threshold_field(
        gmsh,
        surface_tags=surf_tags,
        size_min=size_min,
        size_max=size_max,
        dist_min=dist_min,
        dist_max=dist_max,
        sampling=sampling,
        hscale=hscale,
    )


def _add_component_volume_constant_field(
    gmsh: Any,
    *,
    geometry_name: str,
    vin: float,
    vout: float,
    component_volume_tags: dict[str, list[int]] | None,
    hscale: float = 1.0,
) -> int | None:
    volume_tags = _component_volume_tags_for_geometry(geometry_name, component_volume_tags)
    if not volume_tags:
        emit_progress(
            f"Gmsh: warning - no recovered component volumes for '{geometry_name}', skipping local bulk refinement"
        )
        return None

    field_id = gmsh.model.mesh.field.add("Constant")
    gmsh.model.mesh.field.setNumbers(field_id, "VolumesList", volume_tags)
    gmsh.model.mesh.field.setNumber(field_id, "VIn", float(vin) * hscale)
    gmsh.model.mesh.field.setNumber(field_id, "VOut", float(vout) * hscale)
    return field_id


def _add_bounds_surface_threshold_field(
    gmsh: Any,
    *,
    bounds_min: Sequence[float],
    bounds_max: Sequence[float],
    size_min: float,
    size_max: float,
    dist_min: float,
    dist_max: float,
    sampling: int = 20,
    match_padding: float = 0.0,
    hscale: float = 1.0,
) -> int | None:
    scaled_bounds_min = [float(v) * hscale for v in bounds_min]
    scaled_bounds_max = [float(v) * hscale for v in bounds_max]
    scaled_padding = float(match_padding) * hscale
    surf_tags = _match_surfaces_within_bounds(
        gmsh,
        scaled_bounds_min,
        scaled_bounds_max,
        padding=scaled_padding,
    )
    if not surf_tags:
        emit_progress(
            "Gmsh: warning - bounds-based surface threshold matched no surfaces; skipping local refinement field"
        )
        return None

    return _add_surface_threshold_field(
        gmsh,
        surface_tags=surf_tags,
        size_min=size_min,
        size_max=size_max,
        dist_min=dist_min,
        dist_max=dist_max,
        sampling=sampling,
        hscale=hscale,
    )


def _configure_mesh_size_fields(
    gmsh: Any,
    fields: list[dict[str, Any]],
    hscale: float = 1.0,
    extra_field_ids: list[int] | None = None,
    lower_bound_field_ids: list[int] | None = None,
    component_volume_tags: dict[str, list[int]] | None = None,
    component_surface_tags: dict[str, list[int]] | None = None,
) -> None:
    """Configure Gmsh mesh size fields from JSON-serializable configs.

    Each field config dict has:
        {"kind": "Box", "params": {"VIn": ..., "VOut": ..., ...}}

    Size values (VIn, VOut, hMin, hMax, SizeMin, SizeMax, Radius, etc.)
    are automatically scaled by ``hscale`` when the parameter name
    contains a size-like keyword.
    """
    _SIZE_PARAMS = {
        "vin", "vout", "hmin", "hmax", "hbulk",
        "sizemin", "sizemax", "distmin", "distmax",
        "radius", "thickness",
        "sizeminnormal", "sizemintangent",
        "sizemaxnormal", "sizemaxtangent",
    }

    field_ids = []
    for config in fields:
        kind = config["kind"]
        params = config.get("params", {})
        if not isinstance(params, dict):
            continue
        if kind == "ComponentVolumeConstant":
            geometry_name = params.get("GeometryName")
            if not isinstance(geometry_name, str) or not geometry_name.strip():
                emit_progress("Gmsh: warning - ComponentVolumeConstant is missing GeometryName; skipping")
                continue
            fid = _add_component_volume_constant_field(
                gmsh,
                geometry_name=geometry_name,
                vin=float(params.get("VIn")),
                vout=float(params.get("VOut", 1.0e22)),
                component_volume_tags=component_volume_tags,
                hscale=hscale,
            )
            if fid is not None:
                field_ids.append(fid)
            continue
        if kind in {"SurfaceDistanceThreshold", "InterfaceShellThreshold", "TransitionShellThreshold"}:
            geometry_name = params.get("GeometryName")
            if not isinstance(geometry_name, str) or not geometry_name.strip():
                emit_progress(f"Gmsh: warning - {kind} is missing GeometryName; skipping")
                continue
            fid = _add_component_surface_threshold_field(
                gmsh,
                geometry_name=geometry_name,
                size_min=float(params.get("SizeMin")),
                size_max=float(params.get("SizeMax", 1.0e22)),
                dist_min=float(params.get("DistMin", 0.0)),
                dist_max=float(params.get("DistMax", 0.0)),
                component_surface_tags=component_surface_tags,
                sampling=int(params.get("Sampling", 20)),
                hscale=hscale,
            )
            if fid is not None:
                field_ids.append(fid)
            continue
        if kind == "BoundsSurfaceThreshold":
            bounds_min = params.get("BoundsMin")
            bounds_max = params.get("BoundsMax")
            if not isinstance(bounds_min, list) or not isinstance(bounds_max, list):
                continue
            fid = _add_bounds_surface_threshold_field(
                gmsh,
                bounds_min=bounds_min,
                bounds_max=bounds_max,
                size_min=float(params.get("SizeMin")),
                size_max=float(params.get("SizeMax")),
                dist_min=float(params.get("DistMin", 0.0)),
                dist_max=float(params.get("DistMax", 0.0)),
                sampling=int(params.get("Sampling", 20)),
                match_padding=float(params.get("MatchPadding", 0.0)),
                hscale=hscale,
            )
            if fid is not None:
                field_ids.append(fid)
            continue
        fid = gmsh.model.mesh.field.add(kind)
        for key, value in params.items():
            if isinstance(value, str):
                gmsh.model.mesh.field.setString(fid, key, value)
            elif isinstance(value, list):
                gmsh.model.mesh.field.setNumbers(fid, key, value)
            else:
                # Auto-scale size-like params for µm-scaled geometries
                if hscale != 1.0 and key.lower() in _SIZE_PARAMS:
                    value = value * hscale
                gmsh.model.mesh.field.setNumber(fid, key, value)
        field_ids.append(fid)

    if extra_field_ids:
        field_ids.extend(extra_field_ids)

    if not field_ids and not lower_bound_field_ids:
        return

    size_upper_field = None
    if field_ids:
        if len(field_ids) > 1:
            size_upper_field = gmsh.model.mesh.field.add("Min")
            gmsh.model.mesh.field.setNumbers(size_upper_field, "FieldsList", field_ids)
        else:
            size_upper_field = field_ids[0]

    size_lower_field = None
    if lower_bound_field_ids:
        if len(lower_bound_field_ids) > 1:
            size_lower_field = gmsh.model.mesh.field.add("Max")
            gmsh.model.mesh.field.setNumbers(
                size_lower_field, "FieldsList", lower_bound_field_ids
            )
        else:
            size_lower_field = lower_bound_field_ids[0]

    if size_upper_field is not None and size_lower_field is not None:
        bounded = gmsh.model.mesh.field.add("Max")
        gmsh.model.mesh.field.setNumbers(
            bounded, "FieldsList", [size_upper_field, size_lower_field]
        )
        gmsh.model.mesh.field.setAsBackgroundMesh(bounded)
    elif size_upper_field is not None:
        gmsh.model.mesh.field.setAsBackgroundMesh(size_upper_field)
    elif size_lower_field is not None:
        gmsh.model.mesh.field.setAsBackgroundMesh(size_lower_field)


