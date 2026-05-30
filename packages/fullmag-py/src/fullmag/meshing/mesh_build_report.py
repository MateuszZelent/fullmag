from __future__ import annotations

import math
from dataclasses import replace as _dc_replace
from typing import Mapping

import numpy as np

from fullmag.model.discretization import FEM, PerObjectMeshRecipe
from fullmag.model.geometry import ArchWaveguide, Geometry

from ._gmsh_fields import resolve_effective_algorithm_3d
from ._gmsh_swept import classify_sweepability
from ._gmsh_types import AirboxOptions, MeshOptions
from ._mesh_targets import (
    MeshOperationStatus,
    ResolvedSharedObjectTarget,
    SharedDomainBuildReport,
    ThinFilmDiagnostic,
    _coerce_positive_float,
    _unique_size_field_kinds,
    resolve_shared_domain_targets,
)


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
    mesh_options: MeshOptions,
    selector_resolution: list[dict[str, object]] | None = None,
    boundary_layer_result: Mapping[str, object] | None = None,
    orphan_entities: list[dict[str, object]] | None = None,
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
    per_object_targets: dict[str, ResolvedSharedObjectTarget] = dict(resolved.per_object)
    for region in region_markers:
        geometry_name = region.get("geometry_name")
        marker = region.get("marker")
        if isinstance(geometry_name, str) and geometry_name in per_object_targets:
            per_object_targets[geometry_name] = _dc_replace(
                per_object_targets[geometry_name],
                marker=int(marker) if isinstance(marker, (int, np.integer)) else None,
            )
    # degraded = True when topology/identity had to be simplified.  A retry
    # with another OCC tetrahedral algorithm preserves the conformal CAD path.
    non_degrading_fallbacks = {
        "conformal_occ_delaunay_degenerate_retry_frontal",
        "conformal_occ_hxt_degenerate_retry_delaunay",
    }
    degraded = (
        any(fallback not in non_degrading_fallbacks for fallback in fallbacks_triggered)
        or build_mode == "concatenated_stl_fallback"
    )
    operation_statuses = _build_mesh_operation_statuses(
        geometries,
        mesh_options,
        airbox=airbox,
        build_mode=build_mode,
        fallbacks_triggered=fallbacks_triggered,
        selector_resolution=selector_resolution,
        boundary_layer_result=boundary_layer_result,
    )
    thin_film_diagnostics = _build_thin_film_diagnostics(
        geometries,
        mesh_options,
        per_object_targets,
        default_hmax=float(hints.hmax),
        build_mode=build_mode,
        airbox=airbox,
        operation_statuses=operation_statuses,
    )
    size_fields_realized = _realized_size_field_report(size_fields)
    return SharedDomainBuildReport(
        build_mode=build_mode,
        fallbacks_triggered=list(fallbacks_triggered),
        effective_airbox_target=resolved.airbox,
        effective_per_object_targets=per_object_targets,
        region_markers=[dict(region) for region in region_markers],
        used_size_field_kinds=_unique_size_field_kinds(size_fields),
        size_fields_realized=size_fields_realized,
        operation_statuses=operation_statuses,
        thin_film_diagnostics=thin_film_diagnostics,
        selector_resolution=[dict(item) for item in selector_resolution or []],
        orphan_entities=[dict(item) for item in orphan_entities or []],
        degraded=degraded,
    )


def _realized_size_field_report(size_fields: list[dict[str, object]]) -> list[dict[str, object]]:
    realized: list[dict[str, object]] = []
    for index, field_desc in enumerate(size_fields, start=1):
        if not isinstance(field_desc, dict):
            continue
        kind = field_desc.get("kind")
        params = field_desc.get("params")
        if not isinstance(kind, str) or not isinstance(params, dict):
            continue
        target = (
            params.get("GeometryName")
            or params.get("target")
            or params.get("object_id")
            or params.get("InterfaceId")
        )
        realized.append(
            {
                "id": f"sf{index}",
                "kind": kind,
                "target": str(target) if target is not None else None,
                "status": str(field_desc.get("_gmsh_status", "requested")),
                "source": str(
                    field_desc.get("source")
                    or params.get("Source", "scene_config")
                ),
                "reason": (
                    str(field_desc.get("_gmsh_reason"))
                    if field_desc.get("_gmsh_reason") is not None
                    else None
                ),
                "gmsh_field_id": field_desc.get("_gmsh_field_id"),
                "params": dict(params),
            }
        )
    return realized


_ALGORITHM_3D_NAMES = {
    1: "Delaunay",
    4: "Frontal",
    7: "MMG3D",
    9: "R-tree",
    10: "HXT",
}


def _algorithm_3d_name(value: int | None) -> str | None:
    if value is None:
        return None
    return _ALGORITHM_3D_NAMES.get(int(value), f"Gmsh Algorithm3D {int(value)}")


def _requested_swept_method(opts: MeshOptions) -> str | None:
    strategy = opts.mesh_strategy
    if strategy in {"swept_prism", "swept_hex"}:
        return strategy
    if strategy in {"free_tetrahedral", "thin_film_tetrahedral"}:
        return None
    if opts.through_thickness_elements is not None and opts.through_thickness_elements > 0:
        return "swept_prism"
    return None


def _requested_thin_film_method(opts: MeshOptions) -> str | None:
    return (
        "thin_film_tetrahedral"
        if opts.mesh_strategy == "thin_film_tetrahedral"
        else None
    )


def _shared_domain_swept_fallback_reason(
    geometries: list[Geometry],
    airbox: AirboxOptions | None,
    build_mode: str,
) -> str | None:
    geometry_count = len(geometries)
    if (
        geometry_count == 1
        and isinstance(geometries[0], ArchWaveguide)
        and build_mode in {"component_aware", "concatenated_stl_fallback"}
    ):
        return None
    if airbox is not None:
        return "airbox combined-domain swept workflow is not implemented"
    if geometry_count > 1:
        return "multi-object shared-domain swept workflow is not implemented"
    if build_mode in {"component_aware", "concatenated_stl_fallback"}:
        return "component shared-domain workflow uses free tetrahedral meshing"
    return None


def _shared_domain_swept_actual_method(geometry: Geometry, build_mode: str, requested: str) -> str:
    if isinstance(geometry, ArchWaveguide) and build_mode in {
        "component_aware",
        "concatenated_stl_fallback",
    }:
        return "layered_surface_tetrahedral"
    return requested


def _build_mesh_operation_statuses(
    geometries: list[Geometry],
    opts: MeshOptions,
    *,
    airbox: AirboxOptions | None,
    build_mode: str,
    fallbacks_triggered: list[str],
    selector_resolution: list[dict[str, object]] | None = None,
    boundary_layer_result: Mapping[str, object] | None = None,
) -> list[MeshOperationStatus]:
    statuses: list[MeshOperationStatus] = []

    if opts.optimize is not None:
        statuses.append(
            MeshOperationStatus(
                kind="optimizer",
                scope="global",
                requested=True,
                status="applied",
                requested_method=opts.optimize,
                actual_method=opts.optimize,
                details={"optimize_iters": int(opts.optimize_iters)},
            )
        )
    elif opts.optimize_iters > 0:
        statuses.append(
            MeshOperationStatus(
                kind="optimizer",
                scope="global",
                requested=True,
                status="skipped",
                requested_method=None,
                actual_method=None,
                reason="optimize_iters > 0 but no optimizer method is selected",
                details={"optimize_iters": int(opts.optimize_iters)},
            )
        )

    actual_algorithm, fallback_reason = resolve_effective_algorithm_3d(opts)
    statuses.append(
        MeshOperationStatus(
            kind="algorithm_3d",
            scope="global",
            requested=True,
            status="fallback" if fallback_reason else "applied",
            requested_method=_algorithm_3d_name(opts.algorithm_3d),
            actual_method=_algorithm_3d_name(actual_algorithm),
            reason=fallback_reason,
            details={"size_field_count": len(opts.size_fields)},
        )
    )

    boundary_layer_requested = opts.boundary_layer_count is not None or opts.boundary_layer_thickness is not None
    if boundary_layer_requested:
        boundary_layer_valid = (
            opts.boundary_layer_count is not None
            and opts.boundary_layer_count > 0
            and opts.boundary_layer_thickness is not None
            and opts.boundary_layer_thickness > 0.0
        )
        boundary_layer_has_explicit_targets = bool(
            opts.boundary_layer_target_surface_tags
        ) or bool(opts.boundary_layer_target_curve_tags)
        boundary_layer_has_requested_selectors = bool(
            opts.boundary_layer_target_surface_selectors
        ) or bool(
            opts.boundary_layer_target_curve_selectors
        )
        resolved_selector_tags = [
            tag
            for resolution in selector_resolution or []
            for tag in (
                resolution.get("resolved_tags")
                if isinstance(resolution.get("resolved_tags"), list)
                else []
            )
        ]
        boundary_layer_has_selector_targets = (
            boundary_layer_has_requested_selectors and bool(resolved_selector_tags)
        )
        boundary_layer_has_targets = (
            boundary_layer_has_explicit_targets or boundary_layer_has_selector_targets
        )
        boundary_layer_application_status = None
        boundary_layer_application_reason = None
        boundary_layer_application_field_id = None
        if isinstance(boundary_layer_result, Mapping):
            status_value = boundary_layer_result.get("status")
            if isinstance(status_value, str) and status_value:
                boundary_layer_application_status = status_value
            reason_value = boundary_layer_result.get("reason")
            if isinstance(reason_value, str) and reason_value:
                boundary_layer_application_reason = reason_value
            field_id_value = boundary_layer_result.get("field_id")
            if isinstance(field_id_value, (int, np.integer)):
                boundary_layer_application_field_id = int(field_id_value)

        boundary_layer_applied = boundary_layer_valid and boundary_layer_has_targets
        realized_status = "applied" if boundary_layer_applied else "ignored"
        actual_method = "gmsh_boundary_layer" if boundary_layer_applied else None
        reason = None
        if not boundary_layer_valid:
            reason = "boundary_layer_count and boundary_layer_thickness must both be positive"
        elif not boundary_layer_has_targets:
            reason = (
                "no boundary-layer selector resolved to target surfaces or curves"
                if boundary_layer_has_requested_selectors
                else "no explicit boundary-layer target surfaces or curves were provided"
            )
        elif boundary_layer_application_status in {"applied", "degraded", "ignored"}:
            realized_status = boundary_layer_application_status
            reason = boundary_layer_application_reason
            if realized_status == "applied":
                actual_method = "gmsh_boundary_layer"
            elif realized_status == "degraded":
                actual_method = "background_size_field"
            else:
                actual_method = None
        statuses.append(
            MeshOperationStatus(
                kind="boundary_layer",
                scope="global",
                requested=True,
                status=realized_status,
                requested_method="gmsh_boundary_layer",
                actual_method=actual_method,
                reason=reason,
                details={
                    "target_selector": (
                        "semantic_selectors"
                        if boundary_layer_has_selector_targets
                        else (
                            "explicit_surfaces_or_curves"
                            if boundary_layer_has_explicit_targets
                            else None
                        )
                    ),
                    "target_surface_tags": list(opts.boundary_layer_target_surface_tags or []),
                    "target_curve_tags": list(opts.boundary_layer_target_curve_tags or []),
                    "target_surface_selectors": [
                        dict(selector)
                        for selector in opts.boundary_layer_target_surface_selectors or []
                    ],
                    "target_curve_selectors": [
                        dict(selector)
                        for selector in opts.boundary_layer_target_curve_selectors or []
                    ],
                    "layer_count": opts.boundary_layer_count,
                    "first_layer_thickness": opts.boundary_layer_thickness,
                    "stretching": opts.boundary_layer_stretching or 1.2,
                    "gmsh_field_id": boundary_layer_application_field_id,
                    "experimental": True,
                },
            )
        )

    requested_swept = _requested_swept_method(opts)
    requested_thin_film = _requested_thin_film_method(opts)
    if requested_thin_film is not None:
        for geometry in geometries:
            sweepability = classify_sweepability(geometry)
            scope = getattr(geometry, "geometry_name", type(geometry).__name__)
            statuses.append(
                MeshOperationStatus(
                    kind="thin_film",
                    scope=str(scope),
                    requested=True,
                    status="applied" if sweepability.sweepable else "skipped",
                    requested_method=requested_thin_film,
                    actual_method=(
                        "feature_aware_tetrahedral" if sweepability.sweepable else "free_tetrahedral"
                    ),
                    reason=None if sweepability.sweepable else sweepability.reason,
                    details={
                        "build_mode": build_mode,
                        "through_thickness_elements": opts.through_thickness_elements,
                        "airbox_present": airbox is not None,
                    },
                )
            )
    if requested_swept is not None:
        fallback_reason = _shared_domain_swept_fallback_reason(
            geometries, airbox, build_mode
        )
        for geometry in geometries:
            sweepability = classify_sweepability(geometry)
            scope = getattr(geometry, "geometry_name", type(geometry).__name__)
            if not sweepability.sweepable:
                statuses.append(
                    MeshOperationStatus(
                        kind="swept_prism",
                        scope=str(scope),
                        requested=True,
                        status="skipped",
                        requested_method=requested_swept,
                        actual_method="free_tetrahedral",
                        reason=sweepability.reason,
                        details={"build_mode": build_mode},
                    )
                )
            elif fallback_reason is not None:
                statuses.append(
                    MeshOperationStatus(
                        kind="swept_prism",
                        scope=str(scope),
                        requested=True,
                        status="fallback",
                        requested_method=requested_swept,
                        actual_method="free_tetrahedral",
                        reason=fallback_reason,
                        details={
                            "build_mode": build_mode,
                            "fallbacks_triggered": list(fallbacks_triggered),
                            "through_thickness_elements": opts.through_thickness_elements,
                        },
                    )
                )
            else:
                statuses.append(
                    MeshOperationStatus(
                        kind="swept_prism",
                        scope=str(scope),
                        requested=True,
                        status="applied",
                        requested_method=requested_swept,
                        actual_method=_shared_domain_swept_actual_method(
                            geometry,
                            build_mode,
                            requested_swept,
                        ),
                        details={
                            "build_mode": build_mode,
                            "through_thickness_elements": opts.through_thickness_elements,
                        },
                    )
                )
    return statuses


def _actual_mesh_method_for_geometry(
    geometry_name: str,
    *,
    requested_swept: str | None,
    requested_thin_film: str | None = None,
    operation_statuses: list[MeshOperationStatus],
) -> str:
    if requested_thin_film is not None:
        for status in operation_statuses:
            if status.kind == "thin_film" and status.scope == geometry_name:
                return status.actual_method or "feature_aware_tetrahedral"
        return "feature_aware_tetrahedral"
    if requested_swept is None:
        return "free_tetrahedral"
    for status in operation_statuses:
        if status.kind == "swept_prism" and status.scope == geometry_name:
            return status.actual_method or "free_tetrahedral"
    return "free_tetrahedral"


def _build_thin_film_diagnostics(
    geometries: list[Geometry],
    opts: MeshOptions,
    per_object_targets: dict[str, ResolvedSharedObjectTarget],
    *,
    default_hmax: float,
    build_mode: str,
    airbox: AirboxOptions | None,
    operation_statuses: list[MeshOperationStatus],
) -> list[ThinFilmDiagnostic]:
    diagnostics: list[ThinFilmDiagnostic] = []
    requested_swept = _requested_swept_method(opts)
    requested_thin_film = _requested_thin_film_method(opts)
    swept_fallback_scopes = {
        status.scope
        for status in operation_statuses
        if status.kind == "swept_prism" and status.status == "fallback"
    }
    for geometry in geometries:
        name = getattr(geometry, "geometry_name", type(geometry).__name__)
        sweepability = classify_sweepability(geometry)
        if not sweepability.sweepable and sweepability.thickness is None:
            continue
        target = per_object_targets.get(str(name))
        hmax = target.hmax if target is not None and target.hmax is not None else default_hmax
        thickness = sweepability.thickness
        lateral_size: float | None = None
        if thickness is not None and sweepability.aspect_ratio is not None:
            lateral_size = thickness * sweepability.aspect_ratio
        estimated_layers = (
            max(1, int(math.floor(thickness / hmax)))
            if thickness is not None and hmax is not None and hmax > 0
            else None
        )
        hmax_ratio = (
            hmax / thickness
            if hmax is not None and thickness is not None and thickness > 0
            else None
        )
        actual_method = _actual_mesh_method_for_geometry(
            str(name),
            requested_swept=requested_swept,
            requested_thin_film=requested_thin_film,
            operation_statuses=operation_statuses,
        )
        warnings: list[str] = []
        if opts.through_thickness_elements is not None and opts.through_thickness_elements < 4:
            warnings.append("requested through-thickness layer count is below 4")
        if estimated_layers is not None and estimated_layers < 4:
            warnings.append("estimated layers from maximum element size across thickness is below 4")
        if hmax_ratio is not None and hmax_ratio > 0.5:
            warnings.append("maximum element size is too large relative to thin-film thickness")
        if opts.smoothing_steps == 0:
            warnings.append("smoothing is disabled for a thin-film mesh")
        if (
            sweepability.sweepable
            and actual_method == "free_tetrahedral"
            and requested_thin_film is None
        ):
            warnings.append("thin-film object is using free tetrahedral meshing")
        if str(name) in swept_fallback_scopes:
            warnings.append("requested swept/prism meshing fell back to free tetrahedral")
        if not warnings and not sweepability.sweepable:
            continue
        diagnostics.append(
            ThinFilmDiagnostic(
                geometry_name=str(name),
                scope=str(name),
                is_thin_film=bool(sweepability.sweepable),
                thickness=thickness,
                lateral_size=lateral_size,
                aspect_ratio=sweepability.aspect_ratio,
                requested_layers=opts.through_thickness_elements,
                estimated_layers_from_hmax=estimated_layers,
                hmax_to_thickness_ratio=hmax_ratio,
                requested_method=requested_thin_film or requested_swept,
                actual_method=actual_method,
                warnings=warnings,
            )
        )
    return diagnostics


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
