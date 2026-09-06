from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

import math
import numpy as np

from fullmag._progress import emit_progress
from fullmag._validation import TypedValidationError, parse_finite_float

from ._airbox_grading import _geometric_size_profile_expression
from ._gmsh_types import (
    ALGO_3D_HXT,
    ALGO_3D_MMG3D,
    MeshOptions,
    resolve_mesh_size_controls,
)
from ._gmsh_selectors import resolve_entity_selectors
from ._mesh_targets import _geometry_name_aliases


_NO_OP_FIELD_SIZE = 1.0e22


def _coerce_growth_rate(value: object) -> float | None:
    if value is None:
        return None
    growth_rate = parse_finite_float(
        value,
        "/mesh_options/growth_rate",
        allow_numeric_string=True,
    )
    if growth_rate <= 1.0:
        raise TypedValidationError(
            code="numeric_range_error",
            pointer="/mesh_options/growth_rate",
            message="growth_rate must be greater than 1.0; use null to disable grading",
            value=growth_rate,
        )
    return float(growth_rate)


@dataclass(frozen=True, slots=True)
class BoundaryLayerResult:
    field_id: int | None
    status: str
    reason: str | None = None

    def to_report_dict(self) -> dict[str, object]:
        return {
            "field_id": self.field_id,
            "status": self.status,
            "reason": self.reason,
        }


@dataclass(frozen=True, slots=True)
class MeshOptionsApplicationReport:
    selector_resolution: list[dict[str, object]] = field(default_factory=list)
    boundary_layer_result: dict[str, object] | None = None
    # Keep the requested/effective pair beside the low-level Gmsh application
    # report.  A generator fallback must be observable by every consumer; a
    # later build-report reconstruction is not sufficient because pre-existing
    # airbox fields are only known at application time.
    algorithm_3d_requested: int | None = None
    algorithm_3d_effective: int | None = None
    algorithm_3d_fallback_reason: str | None = None


FIELD_SCHEMAS: dict[str, set[str]] = {
    "Box": {"VIn", "VOut", "XMin", "XMax", "YMin", "YMax", "ZMin", "ZMax"},
    "ComponentVolumeConstant": {"GeometryName", "VIn"},
    "ComponentRestrictedBox": {"GeometryName", "VIn", "XMin", "XMax", "YMin", "YMax", "ZMin", "ZMax"},
    "ComponentRestrictedRectangularPerimeter": {"GeometryName", "VIn", "Extent", "Mode", "AxisA", "AxisB", "XMin", "XMax", "YMin", "YMax", "ZMin", "ZMax"},
    "ComponentRestrictedCylinder": {"GeometryName", "VIn", "Radius", "XCenter", "YCenter"},
    "ComponentRestrictedSphere": {"GeometryName", "VIn", "Radius", "XCenter", "YCenter", "ZCenter"},
    "ComponentRestrictedMathEval": {"GeometryName", "F"},
    "ComponentRestrictedGradedBox": {"GeometryName", "VIn", "VOut", "TransitionDistance", "Size", "Center"},
    "ComponentRestrictedGradedCylinder": {"GeometryName", "VIn", "VOut", "TransitionDistance", "Radius", "Height", "Center"},
    "ComponentRestrictedGradedSphere": {"GeometryName", "VIn", "VOut", "TransitionDistance", "Radius", "Center"},
    "SurfaceDistanceThreshold": {"GeometryName", "SizeMin", "SizeMax", "DistMin", "DistMax"},
    "InterfaceShellThreshold": {"GeometryName", "SizeMin", "SizeMax", "DistMin", "DistMax"},
    "TransitionShellThreshold": {"GeometryName", "SizeMin", "SizeMax", "DistMin", "DistMax"},
    "AxisAlignedBoxDistanceThreshold": {"BoundsMin", "BoundsMax", "SizeMin", "SizeMax", "DistMin", "DistMax"},
    "BoundsSurfaceThreshold": {"BoundsMin", "BoundsMax", "SizeMin", "SizeMax", "DistMin", "DistMax"},
    "EdgeDistanceThreshold": {"GeometryName", "SizeMin", "SizeMax", "DistMin", "DistMax"},
    "CornerDistanceThreshold": {"GeometryName", "SizeMin", "SizeMax", "DistMin", "DistMax"},
}

_METADATA_PARAMS: set[str] = {"Source", "GeometryName", "role", "owner", "origin", "priority"}


def validate_size_field_config(config: dict[str, Any]) -> None:
    kind = config.get("kind")
    if not isinstance(kind, str) or not kind.strip():
        raise ValueError("mesh size field must define a non-empty kind")
    params = config.get("params", {})
    if not isinstance(params, dict):
        raise ValueError(f"mesh size field {kind} params must be an object")
    required = FIELD_SCHEMAS.get(kind)
    if not required:
        return
    missing = sorted(key for key in required if key not in params)
    if missing:
        raise ValueError(
            f"mesh size field {kind} missing required params: {', '.join(missing)}"
        )


def resolve_effective_algorithm_3d(
    opts: MeshOptions,
    *,
    preexisting_field_ids: Sequence[int] | None = None,
) -> tuple[int, str | None]:
    """Return the actual Gmsh 3D algorithm and a fallback reason, if any.

    MMG3D cannot consume the background-field stack used by the shared-domain
    route.  The stack may be authored explicitly (``size_fields``), generated
    from typed controls (curvature/narrow-region presets), or created before
    this function is called (the airbox field).  Resolve all three cases here
    so the value reported by the build is the value actually sent to Gmsh.
    """
    active_sources: list[str] = []
    if opts.size_fields:
        active_sources.append("authored size fields")
    resolved_controls = resolve_mesh_size_controls(opts)
    if int(resolved_controls["resolved_size_from_curvature"]) > 0:
        active_sources.append("curvature refinement")
    if int(resolved_controls["resolved_narrow_regions"]) > 0:
        active_sources.append("narrow-region refinement")
    boundary_layer_valid = (
        opts.boundary_layer_count is not None
        and opts.boundary_layer_count > 0
        and opts.boundary_layer_thickness is not None
        and opts.boundary_layer_thickness > 0.0
        and (
            bool(opts.boundary_layer_target_surface_tags)
            or bool(opts.boundary_layer_target_curve_tags)
            or bool(opts.boundary_layer_target_surface_selectors)
            or bool(opts.boundary_layer_target_curve_selectors)
        )
    )
    if boundary_layer_valid:
        active_sources.append("boundary-layer field")
    if preexisting_field_ids:
        active_sources.append("pre-existing background fields")
    if active_sources and opts.algorithm_3d == ALGO_3D_MMG3D:
        source_text = ", ".join(active_sources)
        return (
            ALGO_3D_HXT,
            "MMG3D is incompatible with active background size fields "
            f"({source_text}); using HXT",
        )
    return opts.algorithm_3d, None


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
) -> MeshOptionsApplicationReport:
    """Apply MeshOptions to the Gmsh context before mesh.generate()."""
    emit_progress("Gmsh: applying mesh options")
    selector_resolution: list[dict[str, object]] = []
    resolved_size_controls = resolve_mesh_size_controls(opts)
    algorithm_3d, algorithm_3d_fallback_reason = resolve_effective_algorithm_3d(
        opts,
        preexisting_field_ids=preexisting_field_ids,
    )
    if algorithm_3d_fallback_reason is not None:
        # MMG3D has proven unstable for imported/shared-domain workflows when a
        # background size field is active; it can abort with "unable to set mesh
        # size" before tetra generation starts. HXT remains stable here while
        # preserving the intended local sizing semantics.
        emit_progress(
            f"Gmsh: {algorithm_3d_fallback_reason} for stable local sizing"
        )
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
    gmsh.option.setNumber("Mesh.RandomSeed", 1)
    gmsh.option.setNumber("Mesh.RandomFactor3D", 1.0e-9)
    gmsh.option.setNumber("Mesh.Reproducible", 1)
    gmsh.option.setNumber("Mesh.MeshSizeFactor", opts.size_factor)
    gmsh.option.setNumber("Mesh.Smoothing", opts.smoothing_steps)
    gmsh.option.setNumber("Mesh.Optimize", 0)

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
    boundary_layer_result: dict[str, object] | None = None

    if resolved_curvature > 0:
        fid = _add_curvature_surface_field(
            gmsh,
            resolved_curvature,
            hmax,
            hscale,
            hmin=opts.hmin,
            curvature_factor=resolved_size_controls.get("curvature_factor"),
            component_surface_tags=component_surface_tags,
        )
        if fid is not None:
            extra_field_ids.append(fid)
            emit_progress(
                "Gmsh: curvature surface refinement active "
                f"(samples={resolved_curvature})"
            )

    resolved_narrow_regions = int(resolved_size_controls["resolved_narrow_regions"])
    if resolved_narrow_regions > 0:
        fid = _add_narrow_region_field(
            gmsh, resolved_narrow_regions, hmax, hscale,
            hmin=opts.hmin,
            component_surface_tags=component_surface_tags,
            component_volume_tags=component_volume_tags,
        )
        if fid is not None:
            extra_field_ids.append(fid)

    if (
        opts.boundary_layer_count is not None
        and opts.boundary_layer_count > 0
        and opts.boundary_layer_thickness is not None
        and opts.boundary_layer_thickness > 0.0
    ):
        bl_stretching = opts.boundary_layer_stretching if opts.boundary_layer_stretching else 1.2
        selected_surface_tags, surface_reports = resolve_entity_selectors(
            gmsh,
            opts.boundary_layer_target_surface_selectors,
            dimension=2,
            component_surface_tags=component_surface_tags,
        )
        selected_curve_tags, curve_reports = resolve_entity_selectors(
            gmsh,
            opts.boundary_layer_target_curve_selectors,
            dimension=1,
            component_surface_tags=component_surface_tags,
        )
        selector_resolution.extend(surface_reports)
        selector_resolution.extend(curve_reports)
        result = _add_boundary_layer_field(
            gmsh,
            count=opts.boundary_layer_count,
            thickness=opts.boundary_layer_thickness,
            stretching=bl_stretching,
            target_surface_tags=sorted(
                set(opts.boundary_layer_target_surface_tags or []) | set(selected_surface_tags)
            ),
            target_curve_tags=sorted(
                set(opts.boundary_layer_target_curve_tags or []) | set(selected_curve_tags)
            ),
            hscale=hscale,
        )
        boundary_layer_result = result.to_report_dict()
        if result.field_id is not None and result.status == "degraded":
            extra_field_ids.append(result.field_id)
        if result.status in {"applied", "degraded"}:
            emit_progress(
                f"Gmsh: boundary layers ({opts.boundary_layer_count} layers, "
                f"thickness={opts.boundary_layer_thickness:.3e}, "
                f"stretching={bl_stretching:.2f}, status={result.status})"
            )
        elif result.reason:
            emit_progress(f"Gmsh: boundary layers ignored ({result.reason})")

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
    return MeshOptionsApplicationReport(
        selector_resolution=selector_resolution,
        boundary_layer_result=boundary_layer_result,
        algorithm_3d_requested=int(opts.algorithm_3d),
        algorithm_3d_effective=int(algorithm_3d),
        algorithm_3d_fallback_reason=algorithm_3d_fallback_reason,
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
    *,
    hmin: float | None = None,
    component_surface_tags: dict[str, list[int]] | None = None,
    component_volume_tags: dict[str, list[int]] | None = None,
) -> int | None:
    """Add a size field that refines narrow regions of the geometry.

    Uses two complementary constraints:

    - a Distance field from boundary surfaces, where the local wall thickness is
      approximately ``2 × dist_to_nearest_boundary``;
    - for component-aware shared-domain meshes, a per-volume bounding-box
      narrow-span constraint, where the target size is ``min_span / n_resolve``.

    Both targets are clamped to ``[max(hmin, hmax * 0.05), hmax]`` in mesh
    units.  The volume constraint prevents the middle of a thin film from
    returning to the far-field target when the nearest-surface distance reaches
    half the film thickness.

    When *component_surface_tags* is provided (shared-domain mesh with
    airbox), only the ferromagnetic component surfaces are used.  This
    prevents airbox outer-boundary faces from being treated as "walls"
    of a narrow region, which would otherwise create unnecessarily fine
    elements at airbox boundaries and in the body–airbox gap.

    When *component_volume_tags* is also provided, the resulting size
    field is restricted to body volumes only.  This prevents the field
    from constraining the airbox, where distance-to-body is not a
    physical narrow-region measurement.

    Returns the Gmsh field ID of a MathEval field, or ``None`` when
    no surfaces are present.
    """
    if n_resolve < 1:
        return None

    field_ids: list[int] = []

    # Prefer component surfaces (bodies only) so the airbox boundary
    # is not treated as a narrow-region wall.
    surf_tags: list[int] = []
    if component_surface_tags:
        for tags in component_surface_tags.values():
            surf_tags.extend(tags)
    else:
        surfaces = gmsh.model.getEntities(2)
        if surfaces:
            surf_tags = [t for _, t in surfaces]

    lower_size, upper_size = _narrow_region_size_bounds(
        hmax=hmax,
        hscale=hscale,
        hmin=hmin,
    )

    if surf_tags:
        f_dist = gmsh.model.mesh.field.add("Distance")
        gmsh.model.mesh.field.setNumbers(f_dist, "SurfacesList", surf_tags)
        gmsh.model.mesh.field.setNumber(f_dist, "Sampling", 20)

        # target_h = 2*dist / n_resolve, clamped to [lower_size, upper_size]
        expr = f"Min(Max(2*F{f_dist}/{n_resolve}, {lower_size}), {upper_size})"
        f_math = gmsh.model.mesh.field.add("MathEval")
        gmsh.model.mesh.field.setString(f_math, "F", expr)

        # Restrict to body volumes only: in the airbox, distance-to-body
        # is not a narrow-region measurement and would over-refine.
        body_vol_tags = _flatten_unique_tags(component_volume_tags)
        if body_vol_tags:
            f_restrict = gmsh.model.mesh.field.add("Restrict")
            gmsh.model.mesh.field.setNumber(f_restrict, "InField", f_math)
            gmsh.model.mesh.field.setNumbers(f_restrict, "VolumesList", body_vol_tags)
            field_ids.append(f_restrict)
        else:
            field_ids.append(f_math)

    field_ids.extend(
        _add_component_volume_narrow_span_fields(
            gmsh,
            n_resolve=n_resolve,
            lower_size=lower_size,
            upper_size=upper_size,
            component_volume_tags=component_volume_tags,
        )
    )

    if not field_ids:
        return None
    if len(field_ids) == 1:
        return field_ids[0]

    f_min = gmsh.model.mesh.field.add("Min")
    gmsh.model.mesh.field.setNumbers(f_min, "FieldsList", field_ids)
    return f_min


def _narrow_region_size_bounds(
    *,
    hmax: float,
    hscale: float,
    hmin: float | None,
) -> tuple[float, float]:
    upper_size = float(hmax) * hscale
    lower_size = upper_size * 0.05
    if hmin is not None and hmin > 0.0:
        lower_size = max(lower_size, float(hmin) * hscale)
    return min(lower_size, upper_size), upper_size


def _flatten_unique_tags(tags_by_name: dict[str, list[int]] | None) -> list[int]:
    if not tags_by_name:
        return []
    tags: set[int] = set()
    for values in tags_by_name.values():
        tags.update(int(tag) for tag in values)
    return sorted(tags)


def _add_component_volume_narrow_span_fields(
    gmsh: Any,
    *,
    n_resolve: int,
    lower_size: float,
    upper_size: float,
    component_volume_tags: dict[str, list[int]] | None,
) -> list[int]:
    volume_tags = _flatten_unique_tags(component_volume_tags)
    if not volume_tags:
        return []

    fields: list[int] = []
    for volume_tag in volume_tags:
        try:
            bbox = gmsh.model.getBoundingBox(3, int(volume_tag))
        except AttributeError:
            return []
        except Exception:
            continue
        if len(bbox) != 6:
            continue
        spans = [
            float(bbox[3]) - float(bbox[0]),
            float(bbox[4]) - float(bbox[1]),
            float(bbox[5]) - float(bbox[2]),
        ]
        positive_spans = [
            span for span in spans if np.isfinite(span) and span > 0.0
        ]
        if not positive_spans:
            continue
        target = max(lower_size, min(upper_size, min(positive_spans) / float(n_resolve)))
        if target >= upper_size:
            continue
        field_id = gmsh.model.mesh.field.add("Constant")
        gmsh.model.mesh.field.setNumbers(field_id, "VolumesList", [int(volume_tag)])
        gmsh.model.mesh.field.setNumber(field_id, "VIn", target)
        gmsh.model.mesh.field.setNumber(field_id, "VOut", upper_size)
        gmsh.model.mesh.field.setNumber(field_id, "IncludeBoundary", 1)
        gmsh.model.mesh.field.setNumber(field_id, "IncludeEmbedded", 1)
        fields.append(field_id)
    return fields


def _sample_surface_curvature_radius(
    gmsh: Any,
    surface_tag: int,
    *,
    samples_per_axis: int,
) -> float | None:
    try:
        bounds_min, bounds_max = gmsh.model.getParametrizationBounds(2, int(surface_tag))
    except AttributeError:
        raise
    except Exception:
        return None

    if len(bounds_min) < 2 or len(bounds_max) < 2:
        return None
    u_min, v_min = float(bounds_min[0]), float(bounds_min[1])
    u_max, v_max = float(bounds_max[0]), float(bounds_max[1])
    if not all(np.isfinite(value) for value in (u_min, v_min, u_max, v_max)):
        return None
    if u_max <= u_min or v_max <= v_min:
        return None

    sample_count = max(1, min(int(samples_per_axis), 5))
    fractions = [(index + 1.0) / (sample_count + 1.0) for index in range(sample_count)]
    parametric_coords: list[float] = []
    for u_fraction in fractions:
        u_value = u_min + (u_max - u_min) * u_fraction
        for v_fraction in fractions:
            v_value = v_min + (v_max - v_min) * v_fraction
            parametric_coords.extend([u_value, v_value])

    try:
        curvatures = gmsh.model.getCurvature(2, int(surface_tag), parametric_coords)
    except AttributeError:
        raise
    except Exception:
        return None

    finite_curvatures = [
        abs(float(curvature))
        for curvature in curvatures
        if np.isfinite(float(curvature)) and abs(float(curvature)) > 0.0
    ]
    if not finite_curvatures:
        return None
    max_curvature = max(finite_curvatures)
    if max_curvature <= 0.0:
        return None
    return 1.0 / max_curvature


def _curvature_limited_surfaces(
    gmsh: Any,
    surface_tags: Sequence[int],
    *,
    curvature_factor: float,
    hmax_scaled: float,
    hscale: float,
    samples_per_axis: int,
) -> tuple[list[int], float | None] | None:
    target_surfaces: list[int] = []
    target_min: float | None = None
    for surface_tag in surface_tags:
        try:
            radius_scaled = _sample_surface_curvature_radius(
                gmsh,
                int(surface_tag),
                samples_per_axis=samples_per_axis,
            )
        except AttributeError:
            return None
        if radius_scaled is None:
            continue
        if hscale <= 0.0:
            continue
        target = float(curvature_factor) * (radius_scaled / hscale)
        if target * hscale >= hmax_scaled:
            continue
        target_surfaces.append(int(surface_tag))
        target_min = target if target_min is None else min(target_min, target)
    return target_surfaces, target_min


def _add_curvature_surface_field(
    gmsh: Any,
    curvature_samples: int,
    hmax: float,
    hscale: float = 1.0,
    *,
    hmin: float | None = None,
    curvature_factor: object = None,
    component_surface_tags: dict[str, list[int]] | None = None,
) -> int | None:
    """Add an explicit surface-near field for rounded-feature refinement.

    Gmsh's global ``MeshSizeFromCurvature`` works well on native CAD in simple
    cases, but shared-domain Fullmag meshes often pass through recovered STL or
    fragmented component surfaces.  In those paths the global option can be too
    weak to survive the background-field stack, producing a visually uniform
    mesh even when the user requested curvature refinement.  This field keeps
    the same public control but turns it into a local ``Distance -> Threshold``
    constraint around recovered object surfaces.
    """
    if curvature_samples < 1:
        return None

    if component_surface_tags:
        surf_tags: list[int] = []
        for tags in component_surface_tags.values():
            surf_tags.extend(int(tag) for tag in tags)
        if not surf_tags:
            return None
    else:
        surfaces = gmsh.model.getEntities(2)
        if not surfaces:
            return None
        surf_tags = [int(tag) for _, tag in surfaces]

    target_surfaces = surf_tags
    target_min: float | None = None
    if curvature_factor is not None:
        try:
            factor_value = float(curvature_factor)
        except (TypeError, ValueError):
            factor_value = 0.0
        if factor_value > 0.0:
            limited = _curvature_limited_surfaces(
                gmsh,
                surf_tags,
                curvature_factor=factor_value,
                hmax_scaled=float(hmax) * hscale,
                hscale=hscale,
                samples_per_axis=max(1, min(int(curvature_samples), 5)),
            )
            if limited is not None:
                target_surfaces, target_min = limited
                if not target_surfaces or target_min is None:
                    return None

    if target_min is None:
        target_min = hmax / float(max(curvature_samples, 1))
    target_min = max(target_min, hmax * 0.05)
    if hmin is not None and hmin > 0.0:
        target_min = max(target_min, float(hmin))
    if target_min >= hmax:
        return None

    # Keep the influence local.  The global SmoothRatio / transition fields
    # handle far-field grading; this field only makes rounded surfaces visible
    # to the background-field stack.
    influence = min(hmax, max(target_min * 3.0, hmax * 0.25))
    return _add_surface_threshold_field(
        gmsh,
        surface_tags=target_surfaces,
        size_min=target_min,
        size_max=hmax,
        dist_min=0.0,
        dist_max=influence,
        sampling=max(20, int(curvature_samples)),
        hscale=hscale,
    )


def _add_boundary_layer_field(
    gmsh: Any,
    *,
    count: int,
    thickness: float,
    stretching: float,
    target_surface_tags: Sequence[int] | None = None,
    target_curve_tags: Sequence[int] | None = None,
    hscale: float = 1.0,
) -> BoundaryLayerResult:
    """Add a Gmsh BoundaryLayer field for prismatic near-wall extrusion.

    Uses explicit target surfaces/curves as the seeding boundary.  A missing
    target selector is ignored instead of silently applying to the whole model.

    Args:
        gmsh: Active Gmsh Python module.
        count: Number of boundary-layer element layers.
        thickness: Target first-layer thickness in mesh units (after *hscale*
            is already applied to coordinates).
        stretching: Growth ratio between successive layers (e.g. 1.2–1.5).
        hscale: Coordinate scale factor (1 for SI meshes; SCALE for µm meshes).

    Returns:
        Boundary-layer realization status and the created field ID, if any.
    """
    if count < 1 or thickness <= 0.0:
        return BoundaryLayerResult(
            field_id=None,
            status="ignored",
            reason="boundary layer count and thickness must be positive",
        )

    surf_tags = [int(tag) for tag in (target_surface_tags or [])]
    curve_tags = [int(tag) for tag in (target_curve_tags or [])]
    if not surf_tags and not curve_tags:
        return BoundaryLayerResult(
            field_id=None,
            status="ignored",
            reason="no explicit boundary-layer target surfaces or curves were provided",
        )

    h_first = float(thickness) * hscale
    fid = gmsh.model.mesh.field.add("BoundaryLayer")
    if surf_tags:
        try:
            boundary = gmsh.model.getBoundary(
                [(2, tag) for tag in surf_tags],
                oriented=False,
                recursive=False,
            )
            curve_tags = sorted(
                set(curve_tags) | {int(tag) for dim, tag in boundary if int(dim) == 1}
            )
        except Exception as exc:
            return BoundaryLayerResult(
                field_id=fid,
                status="ignored",
                reason=f"surface boundary-layer targets could not be converted to curves: {exc}",
            )
    if curve_tags:
        gmsh.model.mesh.field.setNumbers(fid, "CurvesList", curve_tags)
    gmsh.model.mesh.field.setNumber(fid, "hwall_n", h_first)
    gmsh.model.mesh.field.setNumber(fid, "thickness", h_first)
    gmsh.model.mesh.field.setNumber(fid, "ratio", float(stretching) if stretching > 0.0 else 1.2)
    gmsh.model.mesh.field.setNumber(fid, "NbLayers", int(count))
    try:
        gmsh.model.mesh.field.setAsBoundaryLayer(fid)
    except Exception as exc:
        return BoundaryLayerResult(
            field_id=fid,
            status="degraded",
            reason=f"setAsBoundaryLayer unavailable: {exc}",
        )
    return BoundaryLayerResult(field_id=fid, status="applied")


def _match_surfaces_within_bounds(
    gmsh: Any,
    bounds_min: Sequence[float],
    bounds_max: Sequence[float],
    *,
    padding: float = 0.0,
) -> list[int]:
    target_min = np.asarray(bounds_min, dtype=np.float64) - float(padding)
    target_max = np.asarray(bounds_max, dtype=np.float64) + float(padding)
    matched: list[tuple[tuple[float, ...], int]] = []
    for _dim, surf_tag in gmsh.model.getEntities(2):
        bb = np.asarray(gmsh.model.getBoundingBox(2, surf_tag), dtype=np.float64)
        surf_min = bb[:3]
        surf_max = bb[3:]
        if np.all(surf_min >= target_min) and np.all(surf_max <= target_max):
            # Gmsh entity iteration order is not a stable API contract.  Keep
            # all matching surfaces (the field is a min-envelope), but sort
            # by the complete bounding box and tag so equal-distance/tie
            # surfaces produce the same field input on every run.
            matched.append((tuple(float(value) for value in bb.tolist()), int(surf_tag)))
    matched.sort(key=lambda item: (item[0], item[1]))
    return [tag for _bbox, tag in matched]


def _resolve_tags_from_aliases(
    geometry_name: str,
    tag_dict: dict[str, list[int]],
) -> list[int]:
    """Look up component tags by geometry_name, trying canonical aliases."""
    for alias in _geometry_name_aliases(geometry_name):
        tags = tag_dict.get(alias)
        if tags:
            return [int(tag) for tag in tags]
    return []


def _component_surface_tags_for_geometry(
    geometry_name: str,
    component_surface_tags: dict[str, list[int]] | None,
) -> list[int]:
    if not component_surface_tags:
        return []
    return _resolve_tags_from_aliases(geometry_name, component_surface_tags)


def _component_volume_tags_for_geometry(
    geometry_name: str,
    component_volume_tags: dict[str, list[int]] | None,
) -> list[int]:
    if not component_volume_tags:
        return []
    return _resolve_tags_from_aliases(geometry_name, component_volume_tags)


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
    grading: str | None = None,
    growth_rate: object = None,
) -> int | None:
    normalized_surface_tags = [int(tag) for tag in surface_tags]
    if not normalized_surface_tags:
        return None

    return _add_entity_distance_threshold_field(
        gmsh,
        distance_list_key="SurfacesList",
        entity_tags=normalized_surface_tags,
        size_min=size_min,
        size_max=size_max,
        dist_min=dist_min,
        dist_max=dist_max,
        sampling=sampling,
        hscale=hscale,
        grading=grading,
        growth_rate=growth_rate,
    )


def _add_entity_distance_threshold_field(
    gmsh: Any,
    *,
    distance_list_key: str,
    entity_tags: Sequence[int],
    size_min: float,
    size_max: float,
    dist_min: float,
    dist_max: float,
    sampling: int = 20,
    hscale: float = 1.0,
    grading: str | None = None,
    growth_rate: object = None,
) -> int:
    f_dist = gmsh.model.mesh.field.add("Distance")
    normalized_entity_tags = sorted({int(tag) for tag in entity_tags})
    gmsh.model.mesh.field.setNumbers(f_dist, distance_list_key, normalized_entity_tags)
    gmsh.model.mesh.field.setNumber(f_dist, "Sampling", int(max(2, sampling)))

    size_min_scaled = float(size_min) * hscale
    size_max_scaled = float(size_max) * hscale
    dist_min_scaled = float(dist_min) * hscale
    grading_mode = str(grading or "").strip().lower()
    if (
        grading_mode == "geometric"
        and size_min_scaled > 0.0
        and size_max_scaled > size_min_scaled
        and float(dist_max) * hscale > dist_min_scaled
    ):
        span = float(dist_max) * hscale - dist_min_scaled
        f_math = gmsh.model.mesh.field.add("MathEval")
        expr = _geometric_size_profile_expression(
            size_min=size_min_scaled,
            size_max=size_max_scaled,
            ramp=f"(F{f_dist} - {dist_min_scaled}) / {span}",
            growth_rate=_coerce_growth_rate(growth_rate),
        )
        gmsh.model.mesh.field.setString(f_math, "F", expr)
        return f_math

    f_thresh = gmsh.model.mesh.field.add("Threshold")
    gmsh.model.mesh.field.setNumber(f_thresh, "InField", f_dist)
    gmsh.model.mesh.field.setNumber(f_thresh, "SizeMin", size_min_scaled)
    gmsh.model.mesh.field.setNumber(f_thresh, "SizeMax", size_max_scaled)
    gmsh.model.mesh.field.setNumber(f_thresh, "DistMin", dist_min_scaled)
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
    grading: str | None = None,
    growth_rate: object = None,
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
        grading=grading,
        growth_rate=growth_rate,
    )


def _curve_tags_for_geometry(
    gmsh: Any,
    geometry_name: str,
    params: dict[str, Any],
    component_surface_tags: dict[str, list[int]] | None,
) -> list[int]:
    explicit_curve_tags = params.get("CurveTags")
    if isinstance(explicit_curve_tags, list) and explicit_curve_tags:
        return [int(tag) for tag in explicit_curve_tags]

    selector = params.get("Selector")
    if isinstance(selector, dict):
        mode = selector.get("mode")
        if mode not in {None, "all_boundary_curves"}:
            emit_progress(
                f"Gmsh: warning - unsupported edge selector {mode!r}; using all boundary curves"
            )

    surface_tags = _component_surface_tags_for_geometry(geometry_name, component_surface_tags)
    if not surface_tags:
        return []
    curve_tags: set[int] = set()
    for surface_tag in surface_tags:
        try:
            boundary = gmsh.model.getBoundary([(2, int(surface_tag))], oriented=False)
        except Exception:
            continue
        for dim, tag in boundary:
            if int(dim) == 1:
                curve_tags.add(abs(int(tag)))
    return sorted(curve_tags)


def _add_edge_distance_threshold_field(
    gmsh: Any,
    *,
    geometry_name: str,
    size_min: float,
    size_max: float,
    dist_min: float,
    dist_max: float,
    params: dict[str, Any],
    component_surface_tags: dict[str, list[int]] | None,
    sampling: int = 40,
    hscale: float = 1.0,
    grading: str | None = None,
    growth_rate: object = None,
) -> int | None:
    curve_params = dict(params)
    curve_params["Selector"] = {"mode": "all_boundary_curves"}
    curve_tags = _curve_tags_for_geometry(
        gmsh,
        geometry_name,
        curve_params,
        component_surface_tags,
    )
    if not curve_tags:
        emit_progress(
            f"Gmsh: warning - no recovered edge curves for '{geometry_name}', skipping edge distance field"
        )
        return None

    # Edge fields intentionally cross the conformal component/air interface:
    # restricting them to the magnetic volume leaves the neighboring air coarse
    # exactly where demag needs near-edge resolution.
    return _add_entity_distance_threshold_field(
        gmsh,
        distance_list_key="CurvesList",
        entity_tags=curve_tags,
        size_min=size_min,
        size_max=size_max,
        dist_min=dist_min,
        dist_max=dist_max,
        sampling=sampling,
        hscale=hscale,
        grading=grading if grading is not None else params.get("Grading"),
        growth_rate=growth_rate if growth_rate is not None else params.get("GrowthRate"),
    )


def _point_tags_for_geometry(
    gmsh: Any,
    geometry_name: str,
    params: dict[str, Any],
    component_surface_tags: dict[str, list[int]] | None,
) -> list[int]:
    explicit_point_tags = params.get("PointTags")
    if isinstance(explicit_point_tags, list) and explicit_point_tags:
        return [int(tag) for tag in explicit_point_tags]

    selector = params.get("Selector")
    if isinstance(selector, dict):
        mode = selector.get("mode")
        if mode not in {None, "all_boundary_curve_endpoints"}:
            emit_progress(
                f"Gmsh: warning - unsupported corner selector {mode!r}; using all boundary curve endpoints"
            )

    curve_params = dict(params)
    curve_params["Selector"] = {"mode": "all_boundary_curves"}
    curve_tags = _curve_tags_for_geometry(
        gmsh,
        geometry_name,
        curve_params,
        component_surface_tags,
    )
    if not curve_tags:
        return []

    point_tags: set[int] = set()
    for curve_tag in curve_tags:
        try:
            boundary = gmsh.model.getBoundary([(1, int(curve_tag))], oriented=False)
        except Exception:
            continue
        for dim, tag in boundary:
            if int(dim) == 0:
                point_tags.add(abs(int(tag)))
    return sorted(point_tags)


def _add_corner_distance_threshold_field(
    gmsh: Any,
    *,
    geometry_name: str,
    size_min: float,
    size_max: float,
    dist_min: float,
    dist_max: float,
    params: dict[str, Any],
    component_surface_tags: dict[str, list[int]] | None,
    sampling: int = 20,
    hscale: float = 1.0,
    grading: str | None = None,
    growth_rate: object = None,
) -> int | None:
    point_tags = _point_tags_for_geometry(
        gmsh,
        geometry_name,
        params,
        component_surface_tags,
    )
    if not point_tags:
        emit_progress(
            f"Gmsh: warning - no recovered corner points for '{geometry_name}', skipping corner distance field"
        )
        return None

    return _add_entity_distance_threshold_field(
        gmsh,
        distance_list_key="PointsList",
        entity_tags=point_tags,
        size_min=size_min,
        size_max=size_max,
        dist_min=dist_min,
        dist_max=dist_max,
        sampling=sampling,
        hscale=hscale,
        grading=grading if grading is not None else params.get("Grading"),
        growth_rate=growth_rate if growth_rate is not None else params.get("GrowthRate"),
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
    gmsh.model.mesh.field.setNumber(field_id, "IncludeBoundary", 1)
    gmsh.model.mesh.field.setNumber(field_id, "IncludeEmbedded", 1)
    return field_id


def _add_component_restricted_box_field(
    gmsh: Any,
    *,
    geometry_name: str,
    vin: float,
    vout: float,
    xmin: float,
    xmax: float,
    ymin: float,
    ymax: float,
    zmin: float,
    zmax: float,
    component_volume_tags: dict[str, list[int]] | None,
    hscale: float = 1.0,
) -> int | None:
    volume_tags = _component_volume_tags_for_geometry(geometry_name, component_volume_tags)
    if not volume_tags:
        emit_progress(
            f"Gmsh: warning - no recovered component volumes for '{geometry_name}', skipping restricted sub-box refinement"
        )
        return None

    field_id = gmsh.model.mesh.field.add("Box")
    gmsh.model.mesh.field.setNumber(field_id, "VIn", float(vin) * hscale)
    gmsh.model.mesh.field.setNumber(field_id, "VOut", float(vout) * hscale)
    gmsh.model.mesh.field.setNumber(field_id, "XMin", float(xmin) * hscale)
    gmsh.model.mesh.field.setNumber(field_id, "XMax", float(xmax) * hscale)
    gmsh.model.mesh.field.setNumber(field_id, "YMin", float(ymin) * hscale)
    gmsh.model.mesh.field.setNumber(field_id, "YMax", float(ymax) * hscale)
    gmsh.model.mesh.field.setNumber(field_id, "ZMin", float(zmin) * hscale)
    gmsh.model.mesh.field.setNumber(field_id, "ZMax", float(zmax) * hscale)

    restricted = gmsh.model.mesh.field.add("Restrict")
    gmsh.model.mesh.field.setNumber(restricted, "InField", field_id)
    gmsh.model.mesh.field.setNumbers(restricted, "VolumesList", volume_tags)
    return restricted


def _add_component_restricted_rectangular_perimeter_field(
    gmsh: Any,
    *,
    geometry_name: str,
    vin: float,
    vout: float,
    extent: float,
    mode: str,
    axis_a: int,
    axis_b: int,
    xmin: float,
    xmax: float,
    ymin: float,
    ymax: float,
    zmin: float,
    zmax: float,
    component_volume_tags: dict[str, list[int]] | None,
    hscale: float = 1.0,
) -> int | None:
    volume_tags = _component_volume_tags_for_geometry(geometry_name, component_volume_tags)
    if not volume_tags:
        emit_progress(
            f"Gmsh: warning - no recovered component volumes for '{geometry_name}', skipping rectangular perimeter refinement"
        )
        return None

    if extent <= 0.0:
        return None
    axes = ("x", "y", "z")
    bounds_min = [float(xmin) * hscale, float(ymin) * hscale, float(zmin) * hscale]
    bounds_max = [float(xmax) * hscale, float(ymax) * hscale, float(zmax) * hscale]
    try:
        coord_a = axes[int(axis_a)]
        coord_b = axes[int(axis_b)]
        min_a = bounds_min[int(axis_a)]
        max_a = bounds_max[int(axis_a)]
        min_b = bounds_min[int(axis_b)]
        max_b = bounds_max[int(axis_b)]
    except (IndexError, ValueError):
        emit_progress(
            f"Gmsh: warning - invalid rectangular perimeter axes for '{geometry_name}', skipping"
        )
        return None

    da = (
        f"Min({coord_a} - {_math_atom(min_a)}, "
        f"{_math_atom(max_a)} - {coord_a})"
    )
    db = (
        f"Min({coord_b} - {_math_atom(min_b)}, "
        f"{_math_atom(max_b)} - {coord_b})"
    )
    normalized_mode = str(mode).strip().lower()
    if normalized_mode == "corner":
        metric = f"Max({da}, {db})"
    elif normalized_mode == "edge":
        metric = f"Min({da}, {db})"
    else:
        emit_progress(
            f"Gmsh: warning - invalid rectangular perimeter mode {mode!r} for '{geometry_name}', skipping"
        )
        return None

    extent_scaled = float(extent) * hscale
    ramp = f"Min(Max(({metric}) / {_math_number(extent_scaled)}, 0), 1)"
    vin_scaled = float(vin) * hscale
    vout_scaled = float(vout) * hscale
    expr = (
        f"{_math_number(vin_scaled)} + "
        f"({_math_number(vout_scaled)} - {_math_number(vin_scaled)}) * {ramp}"
    )

    field_id = gmsh.model.mesh.field.add("MathEval")
    gmsh.model.mesh.field.setString(field_id, "F", expr)
    restricted = gmsh.model.mesh.field.add("Restrict")
    gmsh.model.mesh.field.setNumber(restricted, "InField", field_id)
    gmsh.model.mesh.field.setNumbers(restricted, "VolumesList", volume_tags)
    return restricted


def _add_component_restricted_cylinder_field(
    gmsh: Any,
    *,
    geometry_name: str,
    vin: float,
    vout: float,
    radius: float,
    xcenter: float,
    ycenter: float,
    zcenter: float,
    component_volume_tags: dict[str, list[int]] | None,
    axis: Sequence[float] = (0.0, 0.0, 1.0),
    hscale: float = 1.0,
) -> int | None:
    volume_tags = _component_volume_tags_for_geometry(geometry_name, component_volume_tags)
    if not volume_tags:
        emit_progress(
            f"Gmsh: warning - no recovered component volumes for '{geometry_name}', skipping restricted cylinder refinement"
        )
        return None

    field_id = gmsh.model.mesh.field.add("Cylinder")
    gmsh.model.mesh.field.setNumber(field_id, "VIn", float(vin) * hscale)
    gmsh.model.mesh.field.setNumber(field_id, "VOut", float(vout) * hscale)
    gmsh.model.mesh.field.setNumber(field_id, "Radius", float(radius) * hscale)
    gmsh.model.mesh.field.setNumber(field_id, "XCenter", float(xcenter) * hscale)
    gmsh.model.mesh.field.setNumber(field_id, "YCenter", float(ycenter) * hscale)
    gmsh.model.mesh.field.setNumber(field_id, "ZCenter", float(zcenter) * hscale)
    gmsh.model.mesh.field.setNumber(field_id, "XAxis", float(axis[0]))
    gmsh.model.mesh.field.setNumber(field_id, "YAxis", float(axis[1]))
    gmsh.model.mesh.field.setNumber(field_id, "ZAxis", float(axis[2]))

    restricted = gmsh.model.mesh.field.add("Restrict")
    gmsh.model.mesh.field.setNumber(restricted, "InField", field_id)
    gmsh.model.mesh.field.setNumbers(restricted, "VolumesList", volume_tags)
    return restricted


def _add_component_restricted_sphere_field(
    gmsh: Any,
    *,
    geometry_name: str,
    vin: float,
    vout: float,
    radius: float,
    xcenter: float,
    ycenter: float,
    zcenter: float,
    component_volume_tags: dict[str, list[int]] | None,
    hscale: float = 1.0,
) -> int | None:
    volume_tags = _component_volume_tags_for_geometry(geometry_name, component_volume_tags)
    if not volume_tags:
        emit_progress(
            f"Gmsh: warning - no recovered component volumes for '{geometry_name}', skipping restricted sphere refinement"
        )
        return None

    field_id = gmsh.model.mesh.field.add("Ball")
    gmsh.model.mesh.field.setNumber(field_id, "VIn", float(vin) * hscale)
    gmsh.model.mesh.field.setNumber(field_id, "VOut", float(vout) * hscale)
    gmsh.model.mesh.field.setNumber(field_id, "Radius", float(radius) * hscale)
    gmsh.model.mesh.field.setNumber(field_id, "XCenter", float(xcenter) * hscale)
    gmsh.model.mesh.field.setNumber(field_id, "YCenter", float(ycenter) * hscale)
    gmsh.model.mesh.field.setNumber(field_id, "ZCenter", float(zcenter) * hscale)

    restricted = gmsh.model.mesh.field.add("Restrict")
    gmsh.model.mesh.field.setNumber(restricted, "InField", field_id)
    gmsh.model.mesh.field.setNumbers(restricted, "VolumesList", volume_tags)
    return restricted


def _add_component_restricted_matheval_field(
    gmsh: Any,
    *,
    geometry_name: str,
    expr: str,
    component_volume_tags: dict[str, list[int]] | None,
) -> int | None:
    volume_tags = _component_volume_tags_for_geometry(geometry_name, component_volume_tags)
    if not volume_tags:
        emit_progress(
            f"Gmsh: warning - no recovered component volumes for '{geometry_name}', skipping restricted MathEval refinement"
        )
        return None

    field_id = gmsh.model.mesh.field.add("MathEval")
    gmsh.model.mesh.field.setString(field_id, "F", expr)

    restricted = gmsh.model.mesh.field.add("Restrict")
    gmsh.model.mesh.field.setNumber(restricted, "InField", field_id)
    gmsh.model.mesh.field.setNumbers(restricted, "VolumesList", volume_tags)
    return restricted


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
    grading: str | None = None,
    growth_rate: object = None,
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
        grading=grading,
        growth_rate=growth_rate,
    )


def _math_number(value: float) -> str:
    return f"{float(value):.17g}"


def _math_atom(value: float) -> str:
    return f"({_math_number(value)})"


def _box_outside_distance_expression(bounds_min: Sequence[float], bounds_max: Sequence[float]) -> str:
    xmin, ymin, zmin = (_math_atom(value) for value in bounds_min)
    xmax, ymax, zmax = (_math_atom(value) for value in bounds_max)
    dx = f"Max(Max({xmin} - x, 0), x - {xmax})"
    dy = f"Max(Max({ymin} - y, 0), y - {ymax})"
    dz = f"Max(Max({zmin} - z, 0), z - {zmax})"
    return f"Sqrt(({dx}) * ({dx}) + ({dy}) * ({dy}) + ({dz}) * ({dz}))"


def _max_expression(expressions: Sequence[str]) -> str:
    result = expressions[0]
    for expression in expressions[1:]:
        result = f"Max({result}, {expression})"
    return result


def _box_airbox_boundary_ramp_expression(
    bounds_min: Sequence[float],
    bounds_max: Sequence[float],
    airbox_bounds_min: Sequence[float],
    airbox_bounds_max: Sequence[float],
    dist_min: float,
) -> str | None:
    coords = ("x", "y", "z")
    terms: list[str] = []
    dist_min_text = _math_number(dist_min)
    for axis, coord in enumerate(coords):
        inner_min = float(bounds_min[axis])
        inner_max = float(bounds_max[axis])
        outer_min = float(airbox_bounds_min[axis])
        outer_max = float(airbox_bounds_max[axis])

        lower_gap = inner_min - outer_min
        if lower_gap > dist_min:
            delta = f"Max({_math_atom(inner_min)} - {coord}, 0)"
            terms.append(
                f"Min(Max(({delta} - {dist_min_text}) / "
                f"{_math_number(lower_gap - dist_min)}, 0), 1)"
            )

        upper_gap = outer_max - inner_max
        if upper_gap > dist_min:
            delta = f"Max({coord} - {_math_atom(inner_max)}, 0)"
            terms.append(
                f"Min(Max(({delta} - {dist_min_text}) / "
                f"{_math_number(upper_gap - dist_min)}, 0), 1)"
            )

    if not terms:
        return None
    return _max_expression(terms)


def _add_axis_aligned_box_distance_threshold_field(
    gmsh: Any,
    *,
    bounds_min: Sequence[float],
    bounds_max: Sequence[float],
    size_min: float,
    size_max: float,
    dist_min: float,
    dist_max: float,
    hscale: float = 1.0,
    grading: str | None = None,
    growth_rate: object = None,
    airbox_bounds_min: Sequence[float] | None = None,
    airbox_bounds_max: Sequence[float] | None = None,
) -> int | None:
    scaled_bounds_min = [float(value) * hscale for value in bounds_min]
    scaled_bounds_max = [float(value) * hscale for value in bounds_max]
    size_min_scaled = float(size_min) * hscale
    size_max_scaled = float(size_max) * hscale
    dist_min_scaled = float(dist_min) * hscale
    dist_max_scaled = float(dist_max) * hscale
    if dist_max_scaled <= dist_min_scaled:
        emit_progress(
            "Gmsh: warning - analytic box distance threshold has non-positive distance span; skipping"
        )
        return None

    ramp = None
    if airbox_bounds_min is not None and airbox_bounds_max is not None:
        scaled_airbox_bounds_min = [float(value) * hscale for value in airbox_bounds_min]
        scaled_airbox_bounds_max = [float(value) * hscale for value in airbox_bounds_max]
        ramp = _box_airbox_boundary_ramp_expression(
            scaled_bounds_min,
            scaled_bounds_max,
            scaled_airbox_bounds_min,
            scaled_airbox_bounds_max,
            dist_min_scaled,
        )
    if ramp is None:
        distance = _box_outside_distance_expression(scaled_bounds_min, scaled_bounds_max)
        span = dist_max_scaled - dist_min_scaled
        ramp = (
            f"Min(Max(({distance} - {_math_number(dist_min_scaled)}) / "
            f"{_math_number(span)}, 0), 1)"
        )
    grading_mode = str(grading or "").strip().lower()
    if (
        grading_mode == "geometric"
        and size_min_scaled > 0.0
        and size_max_scaled > size_min_scaled
    ):
        expr = _geometric_size_profile_expression(
            size_min=size_min_scaled,
            size_max=size_max_scaled,
            ramp=ramp,
            growth_rate=_coerce_growth_rate(growth_rate),
        )
    else:
        expr = (
            f"{_math_number(size_min_scaled)} + "
            f"({_math_number(size_max_scaled)} - {_math_number(size_min_scaled)}) * {ramp}"
        )

    field_id = gmsh.model.mesh.field.add("MathEval")
    gmsh.model.mesh.field.setString(field_id, "F", expr)
    return field_id


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
        "xmin", "xmax", "ymin", "ymax", "zmin", "zmax",
        "xcenter", "ycenter", "zcenter",
        "sizeminnormal", "sizemintangent",
        "sizemaxnormal", "sizemaxtangent",
    }
    _METADATA_PARAMS = {"Source", "GeometryName", "role", "owner", "origin", "priority"}

    field_ids = []

    def _mark_field(
        config: dict[str, Any],
        *,
        status: str,
        reason: str | None = None,
        field_id: int | None = None,
    ) -> None:
        config["_gmsh_status"] = status
        if reason is not None:
            config["_gmsh_reason"] = reason
        if field_id is not None:
            config["_gmsh_field_id"] = int(field_id)

    for config in fields:
        validate_size_field_config(config)
        kind = config["kind"]
        params = config.get("params", {})
        if not isinstance(params, dict):
            continue
        if kind == "ComponentVolumeConstant":
            geometry_name = params.get("GeometryName")
            if not isinstance(geometry_name, str) or not geometry_name.strip():
                emit_progress("Gmsh: warning - ComponentVolumeConstant is missing GeometryName; skipping")
                _mark_field(config, status="ignored", reason="missing GeometryName")
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
                _mark_field(config, status="applied", field_id=fid)
            else:
                _mark_field(config, status="ignored", reason="no recovered component volumes")
            continue
        if kind == "ComponentRestrictedBox":
            geometry_name = params.get("GeometryName")
            if not isinstance(geometry_name, str) or not geometry_name.strip():
                emit_progress("Gmsh: warning - ComponentRestrictedBox is missing GeometryName; skipping")
                _mark_field(config, status="ignored", reason="missing GeometryName")
                continue
            fid = _add_component_restricted_box_field(
                gmsh,
                geometry_name=geometry_name,
                vin=float(params.get("VIn")),
                vout=float(params.get("VOut", 1.0e22)),
                xmin=float(params.get("XMin")),
                xmax=float(params.get("XMax")),
                ymin=float(params.get("YMin")),
                ymax=float(params.get("YMax")),
                zmin=float(params.get("ZMin")),
                zmax=float(params.get("ZMax")),
                component_volume_tags=component_volume_tags,
                hscale=hscale,
            )
            if fid is not None:
                field_ids.append(fid)
                _mark_field(config, status="applied", field_id=fid)
            else:
                _mark_field(config, status="ignored", reason="no recovered component volumes")
            continue
        if kind == "ComponentRestrictedRectangularPerimeter":
            geometry_name = params.get("GeometryName")
            if not isinstance(geometry_name, str) or not geometry_name.strip():
                emit_progress("Gmsh: warning - ComponentRestrictedRectangularPerimeter is missing GeometryName; skipping")
                _mark_field(config, status="ignored", reason="missing GeometryName")
                continue
            fid = _add_component_restricted_rectangular_perimeter_field(
                gmsh,
                geometry_name=geometry_name,
                vin=float(params.get("VIn")),
                vout=float(params.get("VOut", _NO_OP_FIELD_SIZE)),
                extent=float(params.get("Extent")),
                mode=str(params.get("Mode")),
                axis_a=int(params.get("AxisA")),
                axis_b=int(params.get("AxisB")),
                xmin=float(params.get("XMin")),
                xmax=float(params.get("XMax")),
                ymin=float(params.get("YMin")),
                ymax=float(params.get("YMax")),
                zmin=float(params.get("ZMin")),
                zmax=float(params.get("ZMax")),
                component_volume_tags=component_volume_tags,
                hscale=hscale,
            )
            if fid is not None:
                field_ids.append(fid)
                _mark_field(config, status="applied", field_id=fid)
            else:
                _mark_field(config, status="ignored", reason="no recovered component volumes")
            continue
        if kind == "ComponentRestrictedCylinder":
            geometry_name = params.get("GeometryName")
            if not isinstance(geometry_name, str) or not geometry_name.strip():
                emit_progress("Gmsh: warning - ComponentRestrictedCylinder is missing GeometryName; skipping")
                _mark_field(config, status="ignored", reason="missing GeometryName")
                continue
            fid = _add_component_restricted_cylinder_field(
                gmsh,
                geometry_name=geometry_name,
                vin=float(params.get("VIn")),
                vout=float(params.get("VOut", 1.0e22)),
                radius=float(params.get("Radius")),
                xcenter=float(params.get("XCenter")),
                ycenter=float(params.get("YCenter")),
                zcenter=float(params.get("ZCenter", 0.0)),
                component_volume_tags=component_volume_tags,
                axis=params.get("Axis", (0.0, 0.0, 1.0)),
                hscale=hscale,
            )
            if fid is not None:
                field_ids.append(fid)
                _mark_field(config, status="applied", field_id=fid)
            else:
                _mark_field(config, status="ignored", reason="no recovered component volumes")
            continue
        if kind == "ComponentRestrictedSphere":
            geometry_name = params.get("GeometryName")
            if not isinstance(geometry_name, str) or not geometry_name.strip():
                emit_progress("Gmsh: warning - ComponentRestrictedSphere is missing GeometryName; skipping")
                _mark_field(config, status="ignored", reason="missing GeometryName")
                continue
            fid = _add_component_restricted_sphere_field(
                gmsh,
                geometry_name=geometry_name,
                vin=float(params.get("VIn")),
                vout=float(params.get("VOut", 1.0e22)),
                radius=float(params.get("Radius")),
                xcenter=float(params.get("XCenter")),
                ycenter=float(params.get("YCenter")),
                zcenter=float(params.get("ZCenter", 0.0)),
                component_volume_tags=component_volume_tags,
                hscale=hscale,
            )
            if fid is not None:
                field_ids.append(fid)
                _mark_field(config, status="applied", field_id=fid)
            else:
                _mark_field(config, status="ignored", reason="no recovered component volumes")
            continue
        if kind == "ComponentRestrictedMathEval":
            geometry_name = params.get("GeometryName")
            if not isinstance(geometry_name, str) or not geometry_name.strip():
                emit_progress("Gmsh: warning - ComponentRestrictedMathEval is missing GeometryName; skipping")
                _mark_field(config, status="ignored", reason="missing GeometryName")
                continue
            fid = _add_component_restricted_matheval_field(
                gmsh,
                geometry_name=geometry_name,
                expr=str(params.get("F")),
                component_volume_tags=component_volume_tags,
            )
            if fid is not None:
                field_ids.append(fid)
                _mark_field(config, status="applied", field_id=fid)
            else:
                _mark_field(config, status="ignored", reason="no recovered component volumes")
            continue
        if kind == "ComponentRestrictedGradedBox":
            geometry_name = params.get("GeometryName")
            if not isinstance(geometry_name, str) or not geometry_name.strip():
                emit_progress("Gmsh: warning - ComponentRestrictedGradedBox is missing GeometryName; skipping")
                _mark_field(config, status="ignored", reason="missing GeometryName")
                continue
            vin = float(params["VIn"])
            vout = float(params["VOut"])
            trans = float(params["TransitionDistance"])
            size = [float(v) for v in params["Size"]]
            center = [float(v) for v in params["Center"]]

            x_c_scaled = center[0] * hscale
            y_c_scaled = center[1] * hscale
            z_c_scaled = center[2] * hscale

            dx = f"Max(Abs(x - {_math_atom(x_c_scaled)}) - {_math_number(0.5 * size[0] * hscale)}, 0)"
            dy = f"Max(Abs(y - {_math_atom(y_c_scaled)}) - {_math_number(0.5 * size[1] * hscale)}, 0)"
            dz = f"Max(Abs(z - {_math_atom(z_c_scaled)}) - {_math_number(0.5 * size[2] * hscale)}, 0)"
            distance_expr = f"Sqrt(({dx})*({dx}) + ({dy})*({dy}) + ({dz})*({dz}))"

            span = trans * hscale
            ramp = f"({distance_expr}) / {_math_number(span)}"

            expr = _geometric_size_profile_expression(
                size_min=vin * hscale,
                size_max=vout * hscale,
                ramp=ramp,
                growth_rate=1.2,
            )
            fid = _add_component_restricted_matheval_field(
                gmsh,
                geometry_name=geometry_name,
                expr=expr,
                component_volume_tags=component_volume_tags,
            )
            if fid is not None:
                field_ids.append(fid)
                _mark_field(config, status="applied", field_id=fid)
            else:
                _mark_field(config, status="ignored", reason="no recovered component volumes")
            continue
        if kind == "ComponentRestrictedGradedCylinder":
            geometry_name = params.get("GeometryName")
            if not isinstance(geometry_name, str) or not geometry_name.strip():
                emit_progress("Gmsh: warning - ComponentRestrictedGradedCylinder is missing GeometryName; skipping")
                _mark_field(config, status="ignored", reason="missing GeometryName")
                continue
            vin = float(params["VIn"])
            vout = float(params["VOut"])
            trans = float(params["TransitionDistance"])
            radius = float(params["Radius"])
            height = float(params["Height"])
            center = [float(v) for v in params["Center"]]
            axis = params.get("Axis", [0.0, 0.0, 1.0])
            axis = [float(v) for v in axis]
            axis_len = math.sqrt(sum(v * v for v in axis))
            if axis_len > 0.0:
                ax, ay, az = [v / axis_len for v in axis]
            else:
                ax, ay, az = 0.0, 0.0, 1.0

            x_c_scaled = center[0] * hscale
            y_c_scaled = center[1] * hscale
            z_c_scaled = center[2] * hscale

            xc_num = _math_atom(x_c_scaled)
            yc_num = _math_atom(y_c_scaled)
            zc_num = _math_atom(z_c_scaled)
            ax_num = _math_atom(ax)
            ay_num = _math_atom(ay)
            az_num = _math_atom(az)

            # va = projection along the unit axis vector
            va = f"((x - {xc_num})*{ax_num} + (y - {yc_num})*{ay_num} + (z - {zc_num})*{az_num})"
            # da = axial distance outside the cylinder length bounds
            da = f"Max(Abs({va}) - {_math_number(0.5 * height * hscale)}, 0)"
            # vr_sq = squared distance perpendicular to the axis
            v_sq = f"((x - {xc_num})*(x - {xc_num}) + (y - {yc_num})*(y - {yc_num}) + (z - {zc_num})*(z - {zc_num}))"
            vr_sq = f"Max({v_sq} - ({va})*({va}), 0)"
            # dr = radial distance outside the cylinder radius bounds
            dr = f"Max(Sqrt({vr_sq}) - {_math_number(radius * hscale)}, 0)"

            distance_expr = f"Sqrt(({dr})*({dr}) + ({da})*({da}))"

            span = trans * hscale
            ramp = f"({distance_expr}) / {_math_number(span)}"

            expr = _geometric_size_profile_expression(
                size_min=vin * hscale,
                size_max=vout * hscale,
                ramp=ramp,
                growth_rate=1.2,
            )
            fid = _add_component_restricted_matheval_field(
                gmsh,
                geometry_name=geometry_name,
                expr=expr,
                component_volume_tags=component_volume_tags,
            )
            if fid is not None:
                field_ids.append(fid)
                _mark_field(config, status="applied", field_id=fid)
            else:
                _mark_field(config, status="ignored", reason="no recovered component volumes")
            continue
        if kind == "ComponentRestrictedGradedSphere":
            geometry_name = params.get("GeometryName")
            if not isinstance(geometry_name, str) or not geometry_name.strip():
                emit_progress("Gmsh: warning - ComponentRestrictedGradedSphere is missing GeometryName; skipping")
                _mark_field(config, status="ignored", reason="missing GeometryName")
                continue
            vin = float(params["VIn"])
            vout = float(params["VOut"])
            trans = float(params["TransitionDistance"])
            radius = float(params["Radius"])
            center = [float(v) for v in params["Center"]]

            x_c_scaled = center[0] * hscale
            y_c_scaled = center[1] * hscale
            z_c_scaled = center[2] * hscale

            d = f"Sqrt((x - {_math_atom(x_c_scaled)})*(x - {_math_atom(x_c_scaled)}) + (y - {_math_atom(y_c_scaled)})*(y - {_math_atom(y_c_scaled)}) + (z - {_math_atom(z_c_scaled)})*(z - {_math_atom(z_c_scaled)}))"
            distance_expr = f"Max({d} - {_math_number(radius * hscale)}, 0)"

            span = trans * hscale
            ramp = f"({distance_expr}) / {_math_number(span)}"

            expr = _geometric_size_profile_expression(
                size_min=vin * hscale,
                size_max=vout * hscale,
                ramp=ramp,
                growth_rate=1.2,
            )
            fid = _add_component_restricted_matheval_field(
                gmsh,
                geometry_name=geometry_name,
                expr=expr,
                component_volume_tags=component_volume_tags,
            )
            if fid is not None:
                field_ids.append(fid)
                _mark_field(config, status="applied", field_id=fid)
            else:
                _mark_field(config, status="ignored", reason="no recovered component volumes")
            continue
        if kind == "AxisAlignedBoxDistanceThreshold":
            fid = _add_axis_aligned_box_distance_threshold_field(
                gmsh,
                bounds_min=params.get("BoundsMin"),
                bounds_max=params.get("BoundsMax"),
                size_min=float(params.get("SizeMin")),
                size_max=float(params.get("SizeMax")),
                dist_min=float(params.get("DistMin")),
                dist_max=float(params.get("DistMax")),
                hscale=hscale,
                grading=params.get("Grading"),
                growth_rate=params.get("GrowthRate"),
                airbox_bounds_min=params.get("AirboxBoundsMin"),
                airbox_bounds_max=params.get("AirboxBoundsMax"),
            )
            if fid is not None:
                field_ids.append(fid)
                _mark_field(config, status="applied", field_id=fid)
            else:
                _mark_field(config, status="ignored", reason="invalid analytic box distance span")
            continue
        if kind in {"SurfaceDistanceThreshold", "InterfaceShellThreshold", "TransitionShellThreshold"}:
            geometry_name = params.get("GeometryName")
            if not isinstance(geometry_name, str) or not geometry_name.strip():
                emit_progress(f"Gmsh: warning - {kind} is missing GeometryName; skipping")
                _mark_field(config, status="ignored", reason="missing GeometryName")
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
                grading=params.get("Grading"),
                growth_rate=params.get("GrowthRate"),
            )
            if fid is not None:
                field_ids.append(fid)
                _mark_field(config, status="applied", field_id=fid)
            else:
                _mark_field(config, status="ignored", reason="no recovered component surfaces")
            continue
        if kind == "EdgeDistanceThreshold":
            geometry_name = params.get("GeometryName")
            if not isinstance(geometry_name, str) or not geometry_name.strip():
                emit_progress("Gmsh: warning - EdgeDistanceThreshold is missing GeometryName; skipping")
                _mark_field(config, status="ignored", reason="missing GeometryName")
                continue
            fid = _add_edge_distance_threshold_field(
                gmsh,
                geometry_name=geometry_name,
                size_min=float(params.get("SizeMin")),
                size_max=float(params.get("SizeMax")),
                dist_min=float(params.get("DistMin", 0.0)),
                dist_max=float(params.get("DistMax")),
                params=params,
                component_surface_tags=component_surface_tags,
                sampling=int(params.get("Sampling", 40)),
                hscale=hscale,
                grading=params.get("Grading"),
                growth_rate=params.get("GrowthRate"),
            )
            if fid is not None:
                field_ids.append(fid)
                _mark_field(config, status="applied", field_id=fid)
            else:
                _mark_field(config, status="ignored", reason="no recovered edge curves")
            continue
        if kind == "CornerDistanceThreshold":
            geometry_name = params.get("GeometryName")
            if not isinstance(geometry_name, str) or not geometry_name.strip():
                emit_progress("Gmsh: warning - CornerDistanceThreshold is missing GeometryName; skipping")
                _mark_field(config, status="ignored", reason="missing GeometryName")
                continue
            fid = _add_corner_distance_threshold_field(
                gmsh,
                geometry_name=geometry_name,
                size_min=float(params.get("SizeMin")),
                size_max=float(params.get("SizeMax")),
                dist_min=float(params.get("DistMin", 0.0)),
                dist_max=float(params.get("DistMax")),
                params=params,
                component_surface_tags=component_surface_tags,
                sampling=int(params.get("Sampling", 20)),
                hscale=hscale,
                grading=params.get("Grading"),
                growth_rate=params.get("GrowthRate"),
            )
            if fid is not None:
                field_ids.append(fid)
                _mark_field(config, status="applied", field_id=fid)
            else:
                _mark_field(config, status="ignored", reason="no recovered corner points")
            continue
        if kind == "BoundsSurfaceThreshold":
            bounds_min = params.get("BoundsMin")
            bounds_max = params.get("BoundsMax")
            if not isinstance(bounds_min, list) or not isinstance(bounds_max, list):
                _mark_field(config, status="ignored", reason="missing BoundsMin/BoundsMax")
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
                grading=params.get("Grading"),
                growth_rate=params.get("GrowthRate"),
            )
            if fid is not None:
                field_ids.append(fid)
                _mark_field(config, status="applied", field_id=fid)
            else:
                _mark_field(config, status="ignored", reason="bounds matched no surfaces")
            continue
        fid = gmsh.model.mesh.field.add(kind)
        for key, value in params.items():
            if key in _METADATA_PARAMS:
                continue
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
        _mark_field(config, status="applied", field_id=fid)

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
